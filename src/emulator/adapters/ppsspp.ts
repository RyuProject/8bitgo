/**
 * PPSSPP 浏览器运行时。
 *
 * 这里不能接 EmulatorJS 的 PPSSPP 核心：那条路会先把整份 ISO 下载成 Blob，再复制进
 * Emscripten 内存。PSP 镜像常见 1~1.8GB，手机还没进游戏就会被内存峰值杀掉。
 *
 * 本适配器只传 URL、文件名和已验证的总大小。真正的随机读取发生在自建 PPSSPP 核心的
 * WasmRangeFileLoader 中：2MB 固定块、96MB LRU、每次响应必须是 206。这样浏览器不会
 * 持有整张盘，断线重试也只重取当前块。
 */
import type { Capability, CaptureSources, MountOptions, RuntimeHandle } from '../types'
import { focusFrame, frameGamepads } from '../frameFocus'
import { PPSSPP_RUNTIME_PATH } from '../paths'
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

interface PPSSPPFrameWindow extends Window {
  Module?: {
    __ppssppAudio?: {
      context?: AudioContext
      node?: AudioNode
    }
    __ppssppBridgePopupOpen?: () => boolean
  }
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
      // 存档包必须带站内游戏身份，不能只信 PPSSPP 盘内文件名：同一游戏的地区版/汉化版
      // 可能共享标题，读错状态的结果通常不是明确报错，而是几分钟后随机崩溃。
      const stateId = options.gameSlug || `local:${discNameOf(options.game, options.gameName)}`
      if (game instanceof File) await request('mount-local', { file: game, stateId })
      else await request('mount-remote', { remote: game, stateId })
      if (destroyed) return

      ready = true
      options.onProgress?.({ phase: 'starting', startup: 1 })
      caps.add('gamepad')
      // PPSSPP 自己绘制完整 PSP 触屏按键，不再叠本站只有八键的通用面板。
      caps.add('enginePad')
      caps.add('saveState')
      caps.add('remapKeys')
      options.onCaps?.(caps)
      options.onReady?.()
      options.onStart?.()
      focusFrame(iframe)
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
  // replaceChildren 到 Safari 13.1 才有；播放器容器本来就应该只剩这一项。
  container.textContent = ''
  container.appendChild(iframe)
  // 版本目录是 immutable；这里换的是 index.html 的入口代次，不和核心/桥/data 的缓存数字
  // 强行保持一致。漏掉它时，老访客连新 index.html 都拿不到，更不会看到里面的新桥地址。
  // r=6 虽然保留了主线程 canvas，但 SDL/EGL 只在主线程建出上下文，Worker 的 GLctx 仍为空。
  // r=7 改由 Emscripten WebGL API 建立 Worker 代理上下文，再用 OffscreenFramebuffer 呈现。
  // r=8 把 SDL 原生采样率读取代理回主线程，但 SDL 随后仍会从主线程回调 pthread Wasm。
  // r=9 改成共享环形音频缓冲区，浏览器音频回调不再进入错误的线程局部状态。
  // r=10 给桥初始化加故障边界，避免底层异常丢失具体步骤和调用栈。
  // r=11 临时补齐 PPSSPP 启动阶段追踪，确认崩溃发生在音频之后的哪一步。
  // r=12 移除 pthread 第一帧中非法重设主线程计时器的调用。
  // r=13 给首帧的音频填充、事件轮询与 NativeFrame 加一次性定位点。
  // r=14 证实真正故障是 Emscripten 在代理 WebGL 的整数令牌上执行本地 VBO 预帧维护。
  // v4 根据真实冷启动数据把 CHD Range 恢复为 2MB，并裁掉 data 里的远程调试器资源、
  // 降低解包前内存峰值。Cloudflare 对这组静态资源忽略查询串，因此必须换实体目录；
  // 不能再用 `?r=`，否则边缘会把旧 data 和新 JS 拼成不可启动的一套。
  iframe.src = `${PPSSPP_RUNTIME_PATH}index.html?embed=1`
  hostTimer = window.setTimeout(() => {
    if (!destroyed && !ready && !fatalReported) {
      fatalReported = true
      options.onError?.(rt.ppssppStartTimeout)
    }
  }, HOST_TIMEOUT_MS)

  return {
    caps,
    saveExt: 'ppssppstate',
    async saveState() {
      const payload = await request('save-state', {}) as { data?: unknown } | null
      const data = payload?.data
      if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return null
      return new Blob([data], { type: 'application/octet-stream' })
    },
    async loadState(data: ArrayBuffer) {
      if (!data.byteLength) throw new Error('PSP 存档文件是空的')
      await request('load-state', { data })
    },
    openControls() {
      post('open-controls')
      focusFrame(iframe)
    },
    popupOpen() {
      try {
        return Boolean((iframe.contentWindow as PPSSPPFrameWindow | null)?.Module?.__ppssppBridgePopupOpen?.())
      } catch {
        return false
      }
    },
    captureSources(): CaptureSources | null {
      try {
        const frame = iframe.contentWindow as PPSSPPFrameWindow | null
        // iframe 有自己的 Window 构造器；拿子文档的 canvas 去做父窗口 instanceof 会得到 false。
        // 按元素类型和 captureStream 能力判断，Safari/Chromium 的同源 frame 都能正确通过。
        const frameCanvas = iframe.contentDocument?.getElementById('canvas') as HTMLCanvasElement | null
        if (!frameCanvas || frameCanvas.tagName !== 'CANVAS' || typeof frameCanvas.captureStream !== 'function') return null
        const audio = frame?.Module?.__ppssppAudio
        return {
          canvas: frameCanvas,
          audioNode: audio?.node ?? null,
          audioContext: audio?.context ?? null,
        }
      } catch {
        return null
      }
    },
    focus() {
      focusFrame(iframe)
    },
    gamepads() {
      return frameGamepads(iframe)
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
