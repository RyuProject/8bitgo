/**
 * PPSSPP 的独立浏览器运行时。
 *
 * 这里不能接 EmulatorJS 的 PPSSPP 核心：那条路会先把整份 ISO 下载成 Blob，再复制进
 * Emscripten 内存。PSP 镜像常见 1~1.8GB，手机还没进游戏就会被内存峰值杀掉。
 *
 * 本适配器只传 URL、文件名和已验证的总大小。真正的随机读取发生在自建 PPSSPP 核心的
 * WasmRangeFileLoader 中：2MB 固定块、96MB LRU、每次响应必须是 206。这样浏览器不会
 * 持有整张盘，断线重试也只重取当前块。
 */
import type { Capability, MountOptions, RuntimeHandle } from '../types'
import { PPSSPP_PATH } from '../paths'
import { probeRange } from '../remoteDisc'
import { fmt, getT } from '@/services/i18n'

const BRIDGE_SOURCE = '8bitgo-ppsspp-bridge'
const BRIDGE_VERSION = 1
const HOST_TIMEOUT_MS = 120_000
const MOUNT_TIMEOUT_MS = 180_000
const RANGE_PROBE_TIMEOUT_MS = 20_000

interface BridgeMessage {
  source?: string
  version?: number
  type?: string
  requestId?: number
  ok?: boolean
  payload?: unknown
  error?: string
  loaded?: number
  total?: number
}

interface RemoteDiscDescriptor {
  url: string
  name: string
  size: number
}

function discNameOf(game: File | string, fallback: string): string {
  if (game instanceof File) return game.name
  try {
    const pathname = new URL(game, location.href).pathname
    const name = pathname.slice(pathname.lastIndexOf('/') + 1)
    if (name) return decodeURIComponent(name)
  } catch {
    /* URL 不合法时仍保留一个带后缀的名字，PPSSPP 会再给出真正的读取错误。 */
  }
  return /\.(?:iso|cso|chd|pbp|elf|prx)$/i.test(fallback) ? fallback : `${fallback}.iso`
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  const caps = new Set<Capability>()
  let destroyed = false
  let ready = false
  let bootStarted = false
  let requestId = 0
  let hostTimer = 0
  let fatalReported = false
  const probeController = new AbortController()
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: number
  }>()

  const iframe = document.createElement('iframe')
  iframe.title = `${options.gameName} · PPSSPP`
  iframe.tabIndex = 0
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.referrerPolicy = 'same-origin'
  iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; cross-origin-isolated')
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-pointer-lock allow-downloads allow-forms allow-modals',
  )

  const post = (type: string, payload: Record<string, unknown> = {}) => {
    iframe.contentWindow?.postMessage(
      { source: BRIDGE_SOURCE, version: BRIDGE_VERSION, type, ...payload },
      location.origin,
    )
  }

  const request = (type: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (destroyed) return Promise.reject(new Error('PPSSPP 会话已经关闭'))
    const id = ++requestId
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error('PPSSPP 响应超时'))
      }, MOUNT_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      post(type, { ...payload, requestId: id })
    })
  }

  const reportFatal = (message: string) => {
    if (destroyed || fatalReported) return
    fatalReported = true
    options.onError?.(fmt(rt.ppssppLoadFailed, { msg: message }))
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
    // host-ready 只说明 iframe 的桥已经加载，不能拿它当网络超时。旧实现会在一个永不返回的
    // Range 探测上无限挂住，而且 destroy 后请求仍继续占连接；这里给探测独立的截止时间。
    const probeTimer = window.setTimeout(() => probeController.abort(), RANGE_PROBE_TIMEOUT_MS)
    const probe = await probeRange(options.game, probeController.signal).finally(() => {
      window.clearTimeout(probeTimer)
    })
    if (!probe.rangeSupported || !probe.size) throw new Error(rt.ppssppNoRange)
    options.onProgress?.({ phase: 'rom', loaded: 2, total: probe.size })
    return {
      url: options.game,
      name: discNameOf(options.game, options.gameName),
      size: probe.size,
    }
  }

  async function boot(): Promise<void> {
    // iframe 恢复缓存或脚本被重复执行时可能再次发 host-ready；第二次 boot 会同时挂两张盘，
    // 而 host 只允许 start 一次，外层就会把真实成功误报成失败。
    if (bootStarted || destroyed) return
    bootStarted = true
    try {
      if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw new Error(rt.ppssppNeedsIsolation)
      }
      const game = await prepareGame()
      if (destroyed) return
      if (game instanceof File) await request('mount-local', { file: game })
      else await request('mount-remote', { remote: game })
      if (destroyed) return

      ready = true
      options.onProgress?.({ phase: 'starting', startup: 1 })
      caps.add('gamepad')
      // PPSSPP 自己绘制完整 PSP 触屏按键，不再叠本站只有八键的通用面板。
      caps.add('enginePad')
      options.onCaps?.(caps)
      options.onReady?.()
      options.onStart?.()
      iframe.focus()
      iframe.contentWindow?.focus()
    } catch (error) {
      if (!destroyed) {
        reportFatal(error instanceof Error ? error.message : String(error))
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
    if (message.type === 'stream-progress' && Number.isFinite(message.loaded) && Number.isFinite(message.total)) {
      const loaded = Math.max(0, Number(message.loaded))
      const total = Math.max(0, Number(message.total))
      options.onProgress?.({ phase: 'rom', loaded, total, ratio: total ? Math.min(1, loaded / total) : undefined })
      return
    }
    if (message.type === 'runtime-error') {
      reportFatal(message.error || 'PPSSPP 运行时发生致命错误')
      return
    }
    if (message.type !== 'response' || !Number.isInteger(message.requestId)) return
    const entry = pending.get(message.requestId as number)
    if (!entry) return
    pending.delete(message.requestId as number)
    window.clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.payload)
    else entry.reject(new Error(message.error || 'PPSSPP 运行时返回错误'))
  }
  window.addEventListener('message', onMessage)

  iframe.addEventListener('error', () => {
    reportFatal('运行时页面加载失败')
  })

  options.onCaps?.(caps)
  options.onProgress?.({ phase: 'engine', loaded: 0 })
  container.replaceChildren(iframe)
  // 版本目录是 immutable；查询串必须跟 host.js 的 RUNTIME_REVISION 同步，否则老访客连
  // 新 index.html 都拿不到，更不会看到里面带代次的桥与核心地址。
  iframe.src = `${PPSSPP_PATH}index.html?embed=1&r=2`
  hostTimer = window.setTimeout(() => {
    if (!destroyed && !ready && !fatalReported) {
      fatalReported = true
      options.onError?.(rt.ppssppStartTimeout)
    }
  }, HOST_TIMEOUT_MS)

  return {
    caps,
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
      window.removeEventListener('message', onMessage)
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer)
        entry.reject(new Error('PPSSPP 会话已经关闭'))
      }
      pending.clear()
      iframe.remove()
    },
  }
}
