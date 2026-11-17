/**
 * wasm-dolphin：GameCube / Wii 的实验性浏览器运行时。
 *
 * 上游是一套完整网页壳，不是能直接 import 的 npm 模块；把它放在同源 iframe 里有两个收益：
 *   1. 它自己的 Worker、音频、键盘/手柄与设置面板不用在本站重写一遍；
 *   2. 15MB 核心和 1.5GB SharedArrayBuffer 只会在独立隔离页里创建，不污染普通详情页。
 *
 * 远程镜像不能整份下载。适配器先用一个真实的 Range 请求确认对象存储会返回 206，
 * 再把 URL + 大小交给 Dolphin Worker；Worker 内的 range-backed-file.js 按 2MB 分块同步读取、
 * 192MB LRU 缓存。同步只阻塞模拟 Worker，不会把 React 主线程卡白。
 */
import type { Capability, MountOptions, RuntimeHandle } from '../types'
import { DOLPHIN_PATH, DOLPHIN_VERSION } from '../paths'
import { dolphinVersionSaveSlug } from '../dolphinSave'
import { probeRange, type ProbeResult } from '../remoteDisc'
import { isRomContentFailure, isRomNetworkFailure, markRomContentFailure, markRomNetworkFailure } from '../loadProgress'
import { getT, fmt } from '@/services/i18n'
import { alternateRomUrls, rememberRomHostForUrl } from '@/services/romHosts'
import { rankRomRoutes } from '@/services/romRouteHealth'
import { diagLog } from '@/services/startupDiagnostics'

const BRIDGE_SOURCE = '8bitgo-dolphin-bridge'
const BRIDGE_VERSION = 1
const HOST_TIMEOUT_MS = 120_000
const MOUNT_TIMEOUT_MS = 180_000

interface BridgeMessage {
  source?: string
  version?: number
  type?: string
  requestId?: number
  ok?: boolean
  payload?: unknown
  error?: string
  message?: string
  tone?: string
}

interface RemoteDiscDescriptor {
  url: string
  name: string
  size: number
  alternateUrls?: string[]
}

function discNameOf(game: File | string, fallback: string): string {
  if (game instanceof File) return game.name
  try {
    const pathname = new URL(game, location.href).pathname
    const name = pathname.slice(pathname.lastIndexOf('/') + 1)
    if (name) return decodeURIComponent(name)
  } catch {
    /* 地址没有合法路径时使用游戏名兜底，扩展名仍必须给 Dolphin 留着 */
  }
  return /\.(?:iso|gcm|rvz|ciso|gcz|wbfs|wad|dol|elf)$/i.test(fallback) ? fallback : `${fallback}.iso`
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  const caps = new Set<Capability>()
  let destroyed = false
  let ready = false
  let requestId = 0
  let hostTimer = 0
  let remoteTotal = 0
  const probeController = new AbortController()
  let remoteProbe: Promise<{ url: string; result: ProbeResult }> | null = null
  let speculativeProbe = false
  let runtimeFailureReported = false
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: number
  }>()

  const iframe = document.createElement('iframe')
  iframe.title = `${options.gameName} · Dolphin`
  iframe.tabIndex = 0
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.referrerPolicy = 'same-origin'
  iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; cross-origin-isolated')
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-pointer-lock allow-downloads allow-forms allow-modals',
  )

  function post(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): void {
    iframe.contentWindow?.postMessage(
      { source: BRIDGE_SOURCE, version: BRIDGE_VERSION, type, ...payload },
      location.origin,
      transfer,
    )
  }

  function request(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = [], timeout = MOUNT_TIMEOUT_MS): Promise<unknown> {
    if (destroyed) return Promise.reject(new Error('Dolphin 会话已经关闭'))
    const id = ++requestId
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error('Dolphin 响应超时'))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      post(type, { ...payload, requestId: id }, transfer)
    })
  }

  function startRemoteProbe(game: string): Promise<{ url: string; result: ProbeResult }> {
    if (!remoteProbe) {
      // 按线路记分板排序（services/romRouteHealth.ts）：熔断中 / 明显更慢的线路排到后面，不再每局先撞它
      const candidates = rankRomRoutes([game, ...alternateRomUrls(game)])
      remoteProbe = (async () => {
        let networkFailure = false
        let missingResource = false
        let lastResult: ProbeResult = { rangeSupported: false, size: 0 }
        for (const candidate of candidates) {
          const result = await probeRange(candidate, probeController.signal, candidates.length > 1 ? 5_000 : undefined)
          lastResult = result
          networkFailure ||= Boolean(result.networkFailure)
          missingResource ||= Boolean(result.missingResource)
          if (result.rangeSupported && result.size) {
            if (candidate !== game) {
              rememberRomHostForUrl(candidate)
              diagLog('download', 'warn', 'Dolphin Range 探测切换线路：', game, '→', candidate)
            }
            return { url: candidate, result }
          }
          if (probeController.signal.aborted) break
        }
        return {
          url: game,
          result: {
            ...lastResult,
            rangeSupported: false,
            size: 0,
            ...(networkFailure ? { networkFailure: true } : {}),
            ...(missingResource ? { missingResource: true } : {}),
          },
        }
      })()
      void remoteProbe.catch(() => {})
    }
    return remoteProbe
  }

  async function prepareGame(): Promise<File | RemoteDiscDescriptor> {
    if (options.game instanceof File) {
      options.onProgress?.({
        phase: 'rom',
        loaded: options.game.size,
        total: options.game.size,
        ratio: 1,
        cached: true,
      })
      return options.game
    }

    options.onProgress?.({ phase: 'rom', loaded: 0 })
    let selected = await startRemoteProbe(options.game)
    let probe = selected.result
    let probeNetworkFailure = Boolean(probe.networkFailure)
    let probeMissingResource = Boolean(probe.missingResource)
    // iframe 下载期间的提前探测若撞上瞬时断网，正式挂盘时再补一次，不能永久记住一次失败。
    if (speculativeProbe && !probe.rangeSupported && !probeController.signal.aborted) {
      speculativeProbe = false
      remoteProbe = null
      selected = await startRemoteProbe(options.game)
      probe = selected.result
      probeNetworkFailure ||= Boolean(probe.networkFailure)
      probeMissingResource ||= Boolean(probe.missingResource)
    }
    if (!probe.rangeSupported || !probe.size) {
      if (probeNetworkFailure) throw markRomNetworkFailure(new Error('Dolphin 光盘 Range 探测网络失败'))
      if (probeMissingResource) throw markRomContentFailure(new Error('Dolphin 光盘 ROM 返回 HTTP 404/410'))
      throw new Error(rt.dolphinNoRange)
    }
    remoteTotal = probe.size
    // 远程盘没有“整份下载完成”这一刻。只把探测实际读取的两个字节报出去；
    // ratio / cached 若写成 1 / true，加载层会谎称“整盘已缓存”，而真正的块还没开始取。
    options.onProgress?.({
      phase: 'rom',
      loaded: 2,
      total: probe.size,
    })
    return {
      url: selected.url,
      name: discNameOf(options.game, options.gameName),
      size: probe.size,
      alternateUrls: [selected.url, ...alternateRomUrls(options.game)]
        .filter((url, index, all) => url !== selected.url && all.indexOf(url) === index),
    }
  }

  async function boot(): Promise<void> {
    let configurationFailure = false
    let romPrepared = false
    try {
      if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        configurationFailure = true
        throw new Error(rt.dolphinNeedsIsolation)
      }
      const game = await prepareGame()
      romPrepared = true
      if (destroyed) return
      if (game instanceof File) await request('mount-local', { file: game })
      else await request('mount-remote', { remote: game })
      if (destroyed) return

      ready = true
      options.onProgress?.({ phase: 'starting', ratio: 1 })
      for (const cap of ['pause', 'saveState', 'volume', 'gamepad', 'enginePad'] as Capability[]) {
        caps.add(cap)
      }
      options.onCaps?.(caps)
      options.onReady?.()
      options.onStart?.()
      iframe.focus()
      iframe.contentWindow?.focus()
    } catch (error) {
      if (!destroyed) {
        const scope = !romPrepared && isRomNetworkFailure(error)
          ? 'network'
          : isRomContentFailure(error)
            ? 'content'
            : configurationFailure || (error instanceof Error && error.message === rt.dolphinNoRange)
              ? 'config'
              : 'runtime'
        options.onError?.(fmt(rt.dolphinLoadFailed, { msg: error instanceof Error ? error.message : String(error) }), scope)
      }
    }
  }

  const onMessage = (event: MessageEvent) => {
    if (destroyed || event.source !== iframe.contentWindow || event.origin !== location.origin) return
    const message = event.data as BridgeMessage | null
    if (!message || message.source !== BRIDGE_SOURCE || message.version !== BRIDGE_VERSION) return

    if (message.type === 'host-ready') {
      window.clearTimeout(hostTimer)
      void boot()
      return
    }
    if (message.type === 'status') {
      const streamed = /^Remote disc: \d+ blocks \/ ([\d.]+) MiB fetched$/.exec(message.message ?? '')
      if (streamed && remoteTotal > 0) {
        const loaded = Math.min(remoteTotal, Math.round(Number(streamed[1]) * 1024 * 1024))
        options.onProgress?.({ phase: 'rom', loaded, total: remoteTotal, ratio: loaded / remoteTotal })
      }
      if (message.tone === 'error' && message.message?.startsWith('REMOTE_DISC_RANGE_ERROR:') && !runtimeFailureReported) {
        runtimeFailureReported = true
        const detail = String(message.message ?? '').replace(/^REMOTE_DISC_RANGE_ERROR:\s*/, '')
        console.error('[dolphin] 远程读盘发生错误：', detail)
        options.onError?.(fmt(rt.dolphinLoadFailed, { msg: detail || '远程光盘读取失败' }), 'runtime')
      }
      return
    }
    if (message.type !== 'response' || !Number.isInteger(message.requestId)) return
    const entry = pending.get(message.requestId as number)
    if (!entry) return
    pending.delete(message.requestId as number)
    window.clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.payload)
    else entry.reject(new Error(message.error || 'Dolphin 运行时返回错误'))
  }
  window.addEventListener('message', onMessage)

  iframe.addEventListener('error', () => {
    if (!destroyed) options.onError?.(fmt(rt.dolphinLoadFailed, { msg: '运行时页面加载失败' }), 'runtime')
  })

  options.onCaps?.(caps)
  options.onProgress?.({ phase: 'engine', loaded: 0 })
  // replaceChildren 到 Safari 13.1 才有；播放器容器本来就应该只剩这一项。
  container.textContent = ''
  container.appendChild(iframe)
  // 入口代次绕开旧的“删 index.html”301 边缘缓存；核心目录本身已经带构建版本。
  iframe.src = `${DOLPHIN_PATH}index.html?embed=1&r=2`
  // 核心页面和远端光盘探测互不依赖；提前发出真实 Range，把一轮 CDN 往返藏在 iframe 启动里。
  if (typeof options.game === 'string' && globalThis.crossOriginIsolated) {
    speculativeProbe = true
    remoteProbe = null
    remoteProbe = startRemoteProbe(options.game)
  }
  hostTimer = window.setTimeout(() => {
    if (!destroyed && !ready) options.onError?.(rt.dolphinStartTimeout, 'runtime')
  }, HOST_TIMEOUT_MS)

  return {
    caps,
    saveExt: 'sav',
    saveMetadata: { core: 'dolphin', build: DOLPHIN_VERSION, format: 'dolphin-state' },
    // Dolphin 状态只保证同一构建可读；核心换代后必须与旧档物理隔离。
    saveArchiveKey: options.gameSlug
      ? dolphinVersionSaveSlug(options.gameSlug, DOLPHIN_VERSION)
      : undefined,
    setPaused(paused) {
      post('set-paused', { paused })
    },
    volume: 1,
    setVolume(volume) {
      post('set-volume', { volume })
    },
    async saveState() {
      const result = await request('save-state') as { bytes?: ArrayBuffer }
      if (!(result?.bytes instanceof ArrayBuffer) || result.bytes.byteLength === 0) return null
      return new Blob([result.bytes], { type: 'application/octet-stream' })
    },
    async loadState(data) {
      const copy = data.slice(0)
      await request('load-state', { bytes: copy }, [copy])
    },
    focus() {
      iframe.focus()
      iframe.contentWindow?.focus()
    },
    gamepads() {
      try {
        return Array.from(iframe.contentWindow?.navigator.getGamepads?.() ?? [])
          .filter((pad): pad is Gamepad => Boolean(pad))
          .map((pad) => pad.id)
      } catch {
        return []
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      probeController.abort()
      window.clearTimeout(hostTimer)
      post('set-paused', { paused: true })
      window.removeEventListener('message', onMessage)
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer)
        entry.reject(new Error('Dolphin 会话已经关闭'))
      }
      pending.clear()
      iframe.remove()
    },
  }
}
