/**
 * PPSSPP 的独立浏览器运行时。
 *
 * 这里不能接 EmulatorJS 的 PPSSPP 核心：那条路会先把整份 ISO 下载成 Blob，再复制进
 * Emscripten 内存。PSP 镜像常见 1~1.8GB，手机还没进游戏就会被内存峰值杀掉。
 *
 * 本适配器只传 URL、文件名和已验证的总大小。真正的随机读取发生在自建 PPSSPP 核心的
 * WasmRangeFileLoader 中：2MB 固定块、192MB LRU、每次响应必须是 206。这样浏览器不会
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
  let requestId = 0
  let hostTimer = 0
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
    const probe = await probeRange(options.game)
    if (!probe.rangeSupported || !probe.size) throw new Error(rt.ppssppNoRange)
    options.onProgress?.({ phase: 'rom', loaded: 2, total: probe.size })
    return {
      url: options.game,
      name: discNameOf(options.game, options.gameName),
      size: probe.size,
    }
  }

  async function boot(): Promise<void> {
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
        options.onError?.(fmt(rt.ppssppLoadFailed, { msg: error instanceof Error ? error.message : String(error) }))
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
    if (!destroyed) options.onError?.(fmt(rt.ppssppLoadFailed, { msg: '运行时页面加载失败' }))
  })

  options.onCaps?.(caps)
  options.onProgress?.({ phase: 'engine', loaded: 0 })
  container.replaceChildren(iframe)
  iframe.src = `${PPSSPP_PATH}index.html?embed=1`
  hostTimer = window.setTimeout(() => {
    if (!destroyed && !ready) options.onError?.(rt.ppssppStartTimeout)
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
