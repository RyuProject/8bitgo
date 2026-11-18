/**
 * HTML5 网页游戏运行时。
 *
 * 和主机模拟器不同，这类游戏本身就是一个网站：入口可能是 R2 上的 index.html，
 * 也可能是单独部署的完整应用。这里负责把入口放进播放器 iframe，不搬运也不补齐
 * 游戏资源；脚本、WASM、音频等相对路径仍由游戏自己的部署目录提供。
 */
import type { Capability, CaptureSources, MountOptions, RuntimeHandle } from '../types'
import { focusFrame, frameGamepads } from '../frameFocus'
import { installAudioTap, type AudioTap } from '../audioTap'
import { captureCanvasScreenshot } from '../recorder'
import { findHtml5Canvas, html5CanvasCapabilities, html5MediaBridge } from '../html5Media'
import { html5CanvasHasFrame, html5RuntimeSignal } from '../html5Lifecycle'

const SAVE_BRIDGE_SOURCE = '8bitgo-save-bridge'
const SAVE_BRIDGE_VERSION = 1
const SAVE_BRIDGE_TIMEOUT_MS = 15_000
const GAME_SDK_SOURCE = '8bitgo-game-sdk'
const GAME_SDK_VERSION = 1
const GAME_SDK_TIMEOUT_MS = 15_000
const PVZ_SHELL_VERSION = '20261118-live2'
const LEGACY_PAGES_ENTRIES = [
  ['/web/PvZ', 'https://pvz.8bitgo.com'],
  ['/web/diablo', 'https://diablo.8bitgo.com'],
  ['/web/Minecraft', 'https://minecraft.8bitgo.com'],
  ['/web/celeste', 'https://celeste.8bitgo.com'],
  ['/web/terraria', 'https://terraria.8bitgo.com'],
  ['/web/cs16', 'https://cs16.8bitgo.com'],
] as const
const MANAGED_SAVE_BRIDGE_HOSTS = new Set([
  'gamblers-table.8bitgo.com',
  'digiverse.8bitgo.com',
  'pvz.8bitgo.com',
  '8bitgo-pvz.pages.dev',
])

/**
 * 存档消息默认仍限同源；只有本站自己管理、专门承载游戏的少数精确域名例外。
 * 不能放宽成 `*.8bitgo.com`：任意一个被接管的旧子域都不该获得读写玩家存档的资格。
 */
export function html5SaveBridgeOrigin(value: string | Blob, base = location.href): string | null {
  try {
    const page = new URL(base)
    if (typeof value !== 'string') return page.origin
    const game = new URL(value, page)
    if (game.origin === page.origin) return game.origin
    if (game.protocol === 'https:' && MANAGED_SAVE_BRIDGE_HOSTS.has(game.hostname.toLowerCase())) return game.origin
  } catch {
    /* 非法入口会在后面的 iframe 导航里按原有错误路径处理；这里只关闭存档能力。 */
  }
  return null
}

/**
 * 数据库里的存量游戏仍可能绑定主站 `/web/...`。入口在播放器最后一跳迁移，才能保证
 * “每款游戏一个 Pages 项目”不依赖逐条改生产数据库；只认主站精确路径，第三方入口不碰。
 *
 * PvZ 的 HTML 外壳是固定文件名，Cloudflare 允许旧副本继续服务一小段时间。
 * 后台游戏详情同样有边缘缓存：即使数据库已经换成带版本号的地址，详情接口仍可能短暂
 * 返回不带查询串的旧地址。播放器在最后一跳补上发布代次，避免新增的存档按钮再次被旧壳吞掉。
 *
 * 只迁移本站登记过的旧 Pages 入口；第三方 HTML5 游戏和 Pages 游戏的资源子路径都保持原样。
 */
export function versionHtml5Entry(value: string, base = location.href): string {
  try {
    const baseUrl = new URL(base)
    const url = new URL(value, baseUrl)
    let migrated = false
    if (url.origin === baseUrl.origin) {
      const legacy = LEGACY_PAGES_ENTRIES.find(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`))
      if (legacy) {
        const [path, origin] = legacy
        const suffix = url.pathname.slice(path.length)
        // Minecraft 的旧入口是会再次导航的启动壳；直接进游戏页才能让 SDK 看到主站父页来源。
        const target = path === '/web/Minecraft' && (suffix === '' || suffix === '/')
          ? '/web/Minecraft/eaglercraft/index.html'
          : `${path}${suffix}`
        url.href = `${origin}${target}${url.search}${url.hash}`
        migrated = true
      }
    }
    // 数据库也可能已经写成 Pages 自定义域的旧启动壳；从播放器嵌入时仍要直达游戏文档。
    const managedMinecraftHost = url.protocol === 'https:' &&
      ['minecraft.8bitgo.com', '8bitgo-minecraft.pages.dev'].includes(url.hostname.toLowerCase())
    const minecraftShell = url.pathname === '/' || [
      '/web/Minecraft',
      '/web/Minecraft/',
      '/web/Minecraft/index.html',
    ].includes(url.pathname)
    if (managedMinecraftHost && minecraftShell) {
      url.pathname = '/web/Minecraft/eaglercraft/index.html'
      migrated = true
    }
    const managedPvz = url.protocol === 'https:' && ['pvz.8bitgo.com', '8bitgo-pvz.pages.dev'].includes(url.hostname.toLowerCase())
    if ((url.origin !== baseUrl.origin && !managedPvz) || !/^\/web\/PvZ\/(?:cn|en)\/?$/.test(url.pathname)) return migrated ? url.href : value
    url.searchParams.set('shell', PVZ_SHELL_VERSION)
    return url.href
  } catch {
    return value
  }
}

interface SaveBridgeMessage {
  source?: string
  version?: number
  type?: string
  requestId?: number
  ok?: boolean
  data?: unknown
  error?: string
}

interface GameSdkMessage {
  source?: string
  version?: number
  type?: string
  token?: string
  requestId?: number
  operation?: string
  ok?: boolean
  result?: unknown
  sessionId?: string
  frameId?: number
  bitmap?: ImageBitmap
  audioTrack?: MediaStreamTrack
  detail?: {
    capabilities?: { screenshot?: boolean; record?: boolean; live?: boolean }
    width?: number
    height?: number
  }
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const caps = new Set<Capability>()
  // PvZ 返回 ZIP；Digiverse 直接交换它原生的 JSON，扩展名和 MIME 不能再冒充 ZIP。
  const saveFormat = options.gameSlug === 'gamblers-table'
    ? { ext: 'gamblers.json', mime: 'application/json' }
    : { ext: 'pvzsave.zip', mime: 'application/zip' }
  let destroyed = false
  let objectUrl = ''
  let saveBridgeReady = false
  // 必须先迁移入口再确定消息来源；否则旧的同源 PvZ 入口会被导航到 Pages，
  // 但存档桥仍只接受主站 origin，表现为游戏能玩却永远没有云存档按钮。
  const frameEntry = typeof options.game === 'string' ? versionHtml5Entry(options.game) : null
  const saveBridgeOrigin = html5SaveBridgeOrigin(frameEntry ?? options.game)
  let gameSdkOrigin = ''
  try {
    if (frameEntry) gameSdkOrigin = new URL(frameEntry, location.href).origin
  } catch {
    // 非法地址继续沿用 iframe 原有错误路径，不给它开放消息桥。
  }
  let saveRequestId = 0
  let gameSdkRequestId = 0
  let gameSdkReady = false
  let gameSdkLiveCapable = false
  let gameSdkToken = ''
  let remoteLiveSession = ''
  let remoteLiveCanvas: HTMLCanvasElement | null = null
  let remoteLiveContext: CanvasRenderingContext2D | null = null
  let remoteLiveAudioTrack: MediaStreamTrack | null = null
  let remoteLiveStream: MediaStream | null = null
  let remoteLiveFrameId = 0
  const pendingGameSdkRequests = new Map<number, {
    operation: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: number
  }>()
  let mediaObserver: MutationObserver | null = null
  let mediaPollTimer = 0
  let firstFrame = false
  let playable = false
  let firstInteractionReported = false
  let canvasProbeScheduled = false
  const mediaTaps = new WeakMap<Window, AudioTap>()
  const liveMediaTaps = new Set<AudioTap>()
  const pendingSaveRequests = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: number
  }>()

  const iframe = document.createElement('iframe')
  iframe.title = `${options.gameName} · HTML5`
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'
  /**
   * 全屏只声明在 allow 里。再写一个 allowfullscreen 属性会让 Chrome 报
   * 「Allow attribute will take precedence over 'allowfullscreen'」—— 两者并存时
   * 现代浏览器只读 allow，老属性纯属噪音。其余 adapter（ruffle / j2me /
   * emulatorjs / webretro）本来就只写 allow，这里跟它们保持一致。
   */
  /**
   * cross-origin-isolated 是给「游戏要 SharedArrayBuffer」那类构建准备的（reVC、
   * Unity 的多线程构建等）：这个权限策略默认只给 self，**跨源子框架不会自动继承**，
   * 不在这里授出去，iframe 里就永远拿不到 SharedArrayBuffer。
   *
   * ⚠️ 光授权不够。SharedArrayBuffer 还要求**顶层文档**发
   * COOP: same-origin + COEP: require-corp，且整条祖先链都隔离 —— 详情页做不到这件事
   * （require-corp 会掐掉没有 CORP 头的跨源资源：收录脚本、跨源封面图）。所以这类游戏走
   * server/src/routes/play.js 那条独立整页路由，登记表在 shared/isolated-embeds.js。
   * 这里授权只是把该给的给到位，让那条路径能用同一个运行时。
   */
  iframe.setAttribute('allow', 'fullscreen; autoplay; gamepad; cross-origin-isolated; clipboard-read; clipboard-write')
  /**
   * 游戏需要脚本、存储、手柄和全屏，但不应借嵌入页直接改写 8BitGo 顶层窗口。
   * 不给 allow-top-navigation；这样第三方页面即使被攻破，也不能把玩家整页带走。
   */
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups allow-downloads',
  )

  /**
   * 网页游戏只交换存档二进制，不碰登录令牌和 API 地址。
   *
   * 消息同时校验 source 和精确 origin：第三方跨源 HTML5 游戏即使伪造同名消息也接不进来；
   * 只有本站同源页面或上面白名单里的 Pages 项目才会获得 saveState 能力。
   */
  const onSaveBridgeMessage = (event: MessageEvent) => {
    if (destroyed || !saveBridgeOrigin || event.source !== iframe.contentWindow || event.origin !== saveBridgeOrigin) return
    const message = event.data as SaveBridgeMessage | null
    if (!message || message.source !== SAVE_BRIDGE_SOURCE || message.version !== SAVE_BRIDGE_VERSION) return

    if (message.type === 'ready') {
      saveBridgeReady = true
      if (!caps.has('saveState')) {
        caps.add('saveState')
        options.onCaps?.(caps)
      }
      return
    }
    // 保存和读取共用外层的三卡面板；区分消息名只是让游戏里的两个按钮语义明确。
    if (message.type === 'request-save' || message.type === 'request-load') {
      if (saveBridgeReady) options.onSaveRequested?.()
      return
    }
    if (message.type !== 'response' || !Number.isInteger(message.requestId)) return
    const pending = pendingSaveRequests.get(message.requestId as number)
    if (!pending) return
    pendingSaveRequests.delete(message.requestId as number)
    window.clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.data)
    else pending.reject(new Error(message.error || '网页游戏存档失败'))
  }
  window.addEventListener('message', onSaveBridgeMessage)

  const frameDocument = (): Document | null => {
    try {
      return iframe.contentDocument
    } catch {
      return null
    }
  }

  const currentCanvas = (): HTMLCanvasElement | null => findHtml5Canvas(frameDocument())

  const markFirstFrame = () => {
    if (destroyed || firstFrame) return
    firstFrame = true
    options.onStart?.()
  }

  const markPlayable = () => {
    if (destroyed || playable) return
    playable = true
    markFirstFrame()
    options.onReady?.()
  }

  const reportFirstInteraction = () => {
    if (destroyed || firstInteractionReported) return
    firstInteractionReported = true
    options.onFirstInteraction?.()
  }

  /**
   * 跨域网页不能读 DOM，所以给愿意配合的游戏一条极小的 postMessage 协议。
   * 不校验 origin 是有意的：入口可能部署在独立域；event.source 已经把消息锁死到当前 iframe，
   * 它最多能给自己的这一局报就绪，碰不到令牌、存档或其它页面。
   */
  const onRuntimeBridgeMessage = (event: MessageEvent) => {
    if (destroyed || event.source !== iframe.contentWindow) return
    const signal = html5RuntimeSignal(event.data)
    if (!signal) return
    if (signal.type === 'first-frame') markFirstFrame()
    else if (signal.type === 'game-playable') markPlayable()
    else if (signal.type === 'first-interaction') reportFirstInteraction()
    else options.onError?.(signal.detail || 'HTML5 游戏报告启动失败', 'runtime')
  }
  window.addEventListener('message', onRuntimeBridgeMessage)

  const isManagedPvzEntry = () => {
    if (!frameEntry) return false
    try {
      const url = new URL(frameEntry, location.href)
      return ['pvz.8bitgo.com', '8bitgo-pvz.pages.dev'].includes(url.hostname.toLowerCase()) && /^\/web\/PvZ\/(?:cn|en)\/?$/.test(url.pathname)
    } catch {
      return false
    }
  }

  const isManagedMinecraftEntry = () => {
    if (!frameEntry) return false
    try {
      const url = new URL(frameEntry, location.href)
      const managedHost = ['minecraft.8bitgo.com', '8bitgo-minecraft.pages.dev'].includes(url.hostname.toLowerCase())
      return managedHost && /^\/web\/Minecraft\/eaglercraft(?:\/index\.html)?\/?$/.test(url.pathname)
    } catch {
      return false
    }
  }

  const isManagedCs16Entry = () => {
    if (!frameEntry) return false
    try {
      const url = new URL(frameEntry, location.href)
      return url.protocol === 'https:' && url.hostname.toLowerCase() === 'cs16.8bitgo.com' && /^\/web\/cs16\/?$/.test(url.pathname)
    } catch {
      return false
    }
  }

  const clearRemoteLiveCanvas = () => {
    remoteLiveSession = ''
    remoteLiveFrameId = 0
    remoteLiveContext = null
    const tracks = remoteLiveStream?.getTracks() ?? []
    if (remoteLiveAudioTrack && !tracks.includes(remoteLiveAudioTrack)) tracks.push(remoteLiveAudioTrack)
    for (const track of tracks) {
      try { track.stop() } catch { /* 播放器已释放这条轨 */ }
    }
    remoteLiveStream = null
    remoteLiveAudioTrack = null
    if (remoteLiveCanvas) {
      // 释放 backing store；主播停播或页面换代后不该让 800×600 画布继续占显存。
      remoteLiveCanvas.width = 0
      remoteLiveCanvas.height = 0
    }
  }

  const acknowledgeRemoteLiveFrame = (message: GameSdkMessage): void => {
    if (!gameSdkToken || message.sessionId !== remoteLiveSession || !Number.isInteger(message.frameId) || !iframe.contentWindow) return
    try {
      // 父页处理完当前画面再回 ACK，游戏页才继续抓帧，避免跨源消息队列持有一串大位图。
      iframe.contentWindow.postMessage({
        source: '8bitgo-host',
        version: GAME_SDK_VERSION,
        type: 'live-frame-ack',
        token: gameSdkToken,
        sessionId: message.sessionId,
        frameId: message.frameId,
      }, gameSdkOrigin)
    } catch {
      // 超时会在游戏页停止采集；不能因收尾确认失败中断模拟器。
    }
  }

  const drawRemoteLiveFrame = (message: GameSdkMessage): void => {
    const bitmap = message.bitmap
    const width = Number(bitmap?.width) || 0
    const height = Number(bitmap?.height) || 0
    if (!remoteLiveSession || message.sessionId !== remoteLiveSession || !bitmap || !Number.isInteger(message.frameId) || (message.frameId as number) <= remoteLiveFrameId) {
      bitmap?.close?.()
      acknowledgeRemoteLiveFrame(message)
      return
    }
    if (width < 16 || height < 16 || width > 8192 || height > 8192 || width * height > 16_777_216) {
      bitmap.close?.()
      void stopRemoteLiveCapture()
      return
    }
    try {
      if (message.audioTrack?.kind === 'audio' && message.audioTrack.readyState !== 'ended') {
        if (remoteLiveAudioTrack && remoteLiveAudioTrack !== message.audioTrack) remoteLiveAudioTrack.stop()
        remoteLiveAudioTrack = message.audioTrack
        if (remoteLiveStream && !remoteLiveStream.getTracks().includes(remoteLiveAudioTrack)) remoteLiveStream.addTrack(remoteLiveAudioTrack)
      }
      if (!remoteLiveCanvas) remoteLiveCanvas = document.createElement('canvas')
      if (!remoteLiveContext) {
        remoteLiveContext = remoteLiveCanvas.getContext('2d', { alpha: false, desynchronized: true })
          ?? remoteLiveCanvas.getContext('2d')
      }
      if (!remoteLiveContext) throw new Error('浏览器无法创建直播画布')
      if (remoteLiveCanvas.width !== width || remoteLiveCanvas.height !== height) {
        remoteLiveCanvas.width = width
        remoteLiveCanvas.height = height
        // 改 Canvas 尺寸会结束旧的 captureStream 轨；重建流时要把 SDK 送来的音轨接回去。
        remoteLiveStream?.getVideoTracks().forEach((track) => track.stop())
        remoteLiveStream = null
      }
      remoteLiveContext.drawImage(bitmap, 0, 0, width, height)
      remoteLiveFrameId = message.frameId as number
    } catch {
      void stopRemoteLiveCapture()
    } finally {
      bitmap.close?.()
      acknowledgeRemoteLiveFrame(message)
    }
  }

  /**
   * 跨源游戏的画布不能由父页直接读取。只有游戏页主动加载 8BitGo SDK 后，
   * 才允许它在自己的 origin 内截图 / 录制，再把有限大小的 Blob 回给当前 iframe。
   * 每条消息同时核对 frame、精确 origin、协议版本和请求编号，避免其它窗口伪造结果。
   */
  const onGameSdkMessage = (event: MessageEvent) => {
    if (destroyed || !gameSdkOrigin || event.source !== iframe.contentWindow || event.origin !== gameSdkOrigin) return
    const message = event.data as GameSdkMessage | null
    if (!message || message.source !== GAME_SDK_SOURCE || message.version !== GAME_SDK_VERSION) return
    if (message.type === 'hello') {
      if (!gameSdkToken) gameSdkToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      try {
        iframe.contentWindow?.postMessage({ source: '8bitgo-host', version: GAME_SDK_VERSION, type: 'init', token: gameSdkToken }, gameSdkOrigin)
      } catch {
        // 不支持精确目标来源的浏览器会保留原有 iframe 能力，不影响游戏启动。
      }
      return
    }
    if (!gameSdkToken || message.token !== gameSdkToken) return
    if (message.type === 'unready') {
      void stopRemoteLiveCapture()
      gameSdkReady = false
      gameSdkLiveCapable = false
      const removedShot = setMediaCapability('screenshot', false)
      const removedRecord = setMediaCapability('record', false)
      if (removedShot || removedRecord) options.onCaps?.(caps)
      return
    }
    if (message.type === 'ready') {
      gameSdkReady = true
      const capabilities = message.detail?.capabilities
      let changed = false
      const width = Number(message.detail?.width)
      const height = Number(message.detail?.height)
      const usable = Number.isFinite(width) && Number.isFinite(height) && width >= 16 && height >= 16 && width * height <= 16_777_216
      // 同源页面由播放器直接验证；只对主动接入 SDK 的跨源页面启用远程能力。
      if (!frameDocument()) {
        changed = setMediaCapability('screenshot', usable && Boolean(capabilities?.screenshot)) || changed
        changed = setMediaCapability('record', usable && Boolean(capabilities?.record)) || changed
        gameSdkLiveCapable = usable && Boolean(capabilities?.live)
      }
      if (changed) options.onCaps?.(caps)
      return
    }
    if (message.type === 'live-frame') {
      drawRemoteLiveFrame(message)
      return
    }
    if (message.type !== 'response' || !Number.isInteger(message.requestId)) return
    const pending = pendingGameSdkRequests.get(message.requestId as number)
    if (!pending) return
    if (message.operation !== pending.operation) return
    pendingGameSdkRequests.delete(message.requestId as number)
    window.clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(typeof message.result === 'string' ? message.result : '网页游戏 SDK 请求失败'))
  }
  window.addEventListener('message', onGameSdkMessage)

  const requestGameSdk = (
    type: 'request-screenshot' | 'record-start' | 'record-stop' | 'live-start' | 'live-stop',
    options?: Record<string, unknown>,
  ): Promise<unknown> => {
    if (destroyed || !gameSdkReady || !gameSdkOrigin || !iframe.contentWindow) {
      return Promise.reject(new Error('网页游戏没有接入 8BitGo SDK'))
    }
    const requestId = ++gameSdkRequestId
    const operation = type === 'request-screenshot' ? 'screenshot' : type
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingGameSdkRequests.delete(requestId)
        reject(new Error('网页游戏 SDK 响应超时'))
      }, GAME_SDK_TIMEOUT_MS)
      pendingGameSdkRequests.set(requestId, { operation, resolve, reject, timer })
      try {
        iframe.contentWindow?.postMessage({
          source: '8bitgo-host',
          version: GAME_SDK_VERSION,
          type,
          token: gameSdkToken,
          requestId,
          options,
        }, gameSdkOrigin)
      } catch (error) {
        pendingGameSdkRequests.delete(requestId)
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async function stopRemoteLiveCapture(): Promise<void> {
    const sessionId = remoteLiveSession
    if (!sessionId) return
    clearRemoteLiveCanvas()
    if (!gameSdkReady) return
    try {
      await requestGameSdk('live-stop', { sessionId })
    } catch {
      // 页面已跳转或关闭时，浏览器会随文档一起回收它的帧循环。
    }
  }

  /**
   * 没接公开桥的普通同源页面也尽量补一个探针。
   *
   * load 之后装对「已经建好的 AudioContext」来不及，但很多游戏要等玩家第一次点击才建声音，
   * 这条兜底仍能覆盖它们。Unity 想保证从第一声开始就能录，需在 loader 之前引入
   * `/html5-api/8bitgo-media-bridge.js`；它和这里使用相同的探针键，不会被重复包两层。
   */
  const tapFor = (win: Window | null): AudioTap | null => {
    if (!win) return null
    const known = mediaTaps.get(win)
    if (known) return known
    let tap: AudioTap
    try {
      tap = installAudioTap(win as Window & Record<string, unknown>)
    } catch {
      // 第三方页面可能冻结内建构造函数；音频拿不到也不能阻止页面 ready 或画面录制。
      return null
    }
    mediaTaps.set(win, tap)
    liveMediaTaps.add(tap)
    return tap
  }

  const setMediaCapability = (name: 'screenshot' | 'record', enabled: boolean): boolean => {
    if (enabled === caps.has(name)) return false
    if (enabled) caps.add(name)
    else caps.delete(name)
    return true
  }

  const refreshMediaCapabilities = (allowRemove = false) => {
    if (destroyed) return
    const canvas = currentCanvas()
    const found = html5CanvasCapabilities(canvas)
    let changed = false
    if (found.screenshot || allowRemove) changed = setMediaCapability('screenshot', found.screenshot) || changed
    if (found.record || allowRemove) changed = setMediaCapability('record', found.record) || changed
    if (changed) options.onCaps?.(caps)
    if (!playable && html5CanvasHasFrame(canvas) && !canvasProbeScheduled) {
      canvasProbeScheduled = true
      // 连过两次绘制机会再确认，避免只创建了默认 300×150 空画布就被立即当成可玩。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        canvasProbeScheduled = false
        if (html5CanvasHasFrame(currentCanvas())) markPlayable()
      }))
    }
  }

  const stopMediaMonitoring = (removeCapabilities = false) => {
    mediaObserver?.disconnect()
    mediaObserver = null
    if (mediaPollTimer) window.clearTimeout(mediaPollTimer)
    mediaPollTimer = 0
    if (removeCapabilities) refreshMediaCapabilities(true)
  }

  /**
   * Canvas 常常等 WASM 下载完才出现，所以不能只在 iframe load 那一刻查一次。
   * MutationObserver 接住正常的创建/换尺寸；两分钟的低频轮询接住引擎只改 JS width 属性、
   * 或把真画面藏在后来完成导航的同源子 iframe 这两类观察不到的变化。
   */
  const startMediaMonitoring = () => {
    stopMediaMonitoring(false)
    const doc = frameDocument()
    const win = iframe.contentWindow
    if (!doc || !win) {
      refreshMediaCapabilities(true)
      return
    }

    // 页面自己预先加载了媒体桥时，installAudioTap 会拿回同一个探针；没有就装迟到兜底。
    tapFor(win)
    refreshMediaCapabilities(true)
    if (doc.documentElement && typeof MutationObserver !== 'undefined') {
      mediaObserver = new MutationObserver(() => refreshMediaCapabilities())
      mediaObserver.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['width', 'height'],
      })
    }

    const deadline = Date.now() + 120_000
    const poll = () => {
      if (destroyed) return
      refreshMediaCapabilities()
      // Canvas 一旦可用，后续即使引擎重建它，句柄每次都会现查，不必继续扫描整个 DOM。
      if (caps.has('screenshot') || Date.now() >= deadline) return
      mediaPollTimer = window.setTimeout(poll, 250)
    }
    poll()
  }

  function requestSaveBridge(type: 'export' | 'import', data?: ArrayBuffer): Promise<unknown> {
    if (!saveBridgeReady || !saveBridgeOrigin || !iframe.contentWindow) return Promise.reject(new Error('网页游戏存档尚未就绪'))
    const requestId = ++saveRequestId
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingSaveRequests.delete(requestId)
        reject(new Error('网页游戏存档响应超时'))
      }, SAVE_BRIDGE_TIMEOUT_MS)
      pendingSaveRequests.set(requestId, { resolve, reject, timer })
      const message = { source: SAVE_BRIDGE_SOURCE, version: SAVE_BRIDGE_VERSION, type, requestId, data }
      try {
        iframe.contentWindow?.postMessage(message, saveBridgeOrigin, data ? [data] : [])
      } catch (error) {
        pendingSaveRequests.delete(requestId)
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  let loaded = false
  iframe.addEventListener('load', () => {
    if (destroyed) return
    // 门户页跳进真正游戏页也会再次 load；就绪只报一次，媒体来源却必须跟着换到新文档。
    startMediaMonitoring()
    if (loaded) {
      // 游戏页整页跳转时废弃旧文档的能力令牌与未完成请求，迟到消息不能冒充新一局。
      gameSdkReady = false
      gameSdkLiveCapable = false
      gameSdkToken = ''
      clearRemoteLiveCanvas()
      const removedShot = setMediaCapability('screenshot', false)
      const removedRecord = setMediaCapability('record', false)
      if (removedShot || removedRecord) options.onCaps?.(caps)
      for (const pending of pendingGameSdkRequests.values()) {
        window.clearTimeout(pending.timer)
        pending.reject(new Error('网页游戏页面已跳转'))
      }
      pendingGameSdkRequests.clear()
    }
    /**
     * 只认第一次 load。
     *
     * 门户式的 HTML5 游戏会在自己的 iframe 里做整页跳转（菜单页 → 游戏页、关卡之间
     * location.href）。每跳一次就再触发一次 load：以前会再报一次 onReady ——
     * 播放器那边等于**再记一次游玩**（游玩次数虚高），还会把焦点从玩家正在打字的
     * 评论框里抢进 iframe，后面敲的字全打进游戏里。
     */
    options.onIframeLoaded?.()
    // 跨源页面的 load 只能证明入口文档到达，父页读不到画布与加载错误；把这种限制告知漏斗，
    // 后续由播放器将 watchdog 结果记为“无法观测”，而不是错误地认定游戏失败。
    options.onReadinessVisibilityChange?.(Boolean(frameDocument()))
    if (loaded) return
    loaded = true
    // 这里只撤加载遮罩。真实成功必须等运行时桥或同源 canvas 探针，不能再拿 load 冒充。
    options.onSurfaceReady?.()
  })
  // 跨域 iframe 读不到内部事件；用户亲手点进去时浏览器会把焦点交给 iframe，这仍是可靠的首次操作信号。
  iframe.addEventListener('focus', reportFirstInteraction)
  iframe.addEventListener('error', () => {
    if (destroyed) return
    options.onError?.('HTML5 游戏页面加载失败。请检查入口地址，以及目标站点是否允许被 iframe 嵌入。', 'runtime')
  })

  options.onCaps?.(caps)
  options.onProgress?.({ phase: 'starting' })
  // replaceChildren 到 Safari 13.1 才有；播放器容器本来就应该只剩这一项。
  container.textContent = ''
  container.appendChild(iframe)

  if (typeof options.game === 'string') {
    iframe.src = frameEntry as string
  } else {
    // 单文件 HTML 可以直接运行；需要其它素材的项目应部署完整目录并绑定 index.html。
    objectUrl = URL.createObjectURL(options.game)
    iframe.src = objectUrl
  }

  return {
    caps,
    saveExt: saveFormat.ext,
    saveMetadata: { core: 'html5-bridge', format: saveFormat.ext },
    async saveState() {
      const data = await requestSaveBridge('export')
      if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('网页游戏返回了空存档')
      return new Blob([data], { type: saveFormat.mime })
    },
    async loadState(data: ArrayBuffer) {
      // 转移给 iframe 后这份 buffer 会被 detach；复制一份，别改掉调用方手里的云存档缓存。
      await requestSaveBridge('import', data.slice(0))
      saveBridgeReady = false
      caps.delete('saveState')
      options.onCaps?.(caps)
      // PvZ 和 Digiverse 都只在启动时读取玩家资料；导入后原地重载才会使用新进度。
      iframe.contentWindow?.location.reload()
    },
    /**
     * 直播 / 录像的画面来源。
     *
     * HTML5 游戏跑在 iframe 里，能不能抓到画面完全取决于**同不同源**：
     *
     *   同源（游戏部署在自家域名下，或走 server/src/routes/play.js 那条整页路由）
     *     → 能读到 iframe 的文档，把里面的 <canvas> 拿出来交给上层 captureStream，
     *       和别的引擎走的是同一条路。
     *   跨源（游戏是独立部署的）
     *     → 浏览器不让读 contentDocument。明确接入 SDK 的 Pages 游戏会在开播时以限帧 ImageBitmap
     *       把画面交给本页；其它跨源游戏仍返回 null，保留分享标签页兜底。
     *
     * **跨源 SDK 优先转移可用音轨**：已接入的 Pages 游戏会在运行前装媒体桥；浏览器不支持
     * MediaStreamTrack 转移时只推画面，不能让音频能力拖垮游戏或整个直播。
     *
     * 纯 DOM/CSS 做的游戏（压根没有 canvas）同样抓不到 —— 这类占比很小，
     * 不值得为它上 html2canvas 那种逐帧重绘的方案。
     */
    focus: () => focusFrame(iframe),
    gamepads: () => frameGamepads(iframe),
    /**
     * 跨源就是永远抓不到，没必要让直播那边再等九秒：加载完之后 contentDocument 读不出来
     * （null 或者直接抛）就是跨源。加载完之前先说「不知道」，别误判。
     */
    captureBlocked(): boolean {
      if (destroyed || !loaded) return false
      try {
        return iframe.contentDocument === null
      } catch {
        return true
      }
    },
    captureSources(): CaptureSources | null {
      if (destroyed) return null
      if (remoteLiveCanvas && remoteLiveCanvas.width >= 16 && remoteLiveCanvas.height >= 16) {
        if (!remoteLiveStream && typeof remoteLiveCanvas.captureStream === 'function') {
          try {
            remoteLiveStream = remoteLiveCanvas.captureStream(30)
            if (remoteLiveAudioTrack?.readyState === 'live') remoteLiveStream.addTrack(remoteLiveAudioTrack)
          } catch {
            remoteLiveStream = null
          }
        }
        return remoteLiveStream ? { stream: remoteLiveStream } : { canvas: remoteLiveCanvas }
      }
      const canvas = currentCanvas()
      if (!html5CanvasCapabilities(canvas).screenshot || !canvas) return null

      const sourceWindow = canvas.ownerDocument.defaultView
      const bridge = html5MediaBridge(sourceWindow)
      let bridged: CaptureSources | null = null
      try {
        bridged = bridge?.captureSources?.() ?? null
      } catch {
        /* 游戏桥坏了只降级成外层自动发现，不能让录制/直播一起挂 */
      }
      const tap = tapFor(sourceWindow)
      return {
        canvas,
        audioNode: bridged?.audioNode ?? tap?.node ?? null,
        audioContext: bridged?.audioContext ?? tap?.ctx ?? null,
      }
    },
    async screenshot() {
      const canvas = currentCanvas()
      if (!canvas) {
        if (!gameSdkReady) return null
        const remote = await requestGameSdk('request-screenshot')
        return remote && typeof remote === 'object' && Number((remote as Blob).size) > 0 && Number((remote as Blob).size) <= 24 * 1024 * 1024 && typeof (remote as Blob).arrayBuffer === 'function'
          ? remote as Blob
          : null
      }
      if (!html5CanvasCapabilities(canvas).screenshot) return null

      const bridge = html5MediaBridge(canvas.ownerDocument.defaultView)
      if (bridge?.screenshot) {
        try {
          const shot = await bridge.screenshot()
          // Blob 来自子 iframe 的 realm，不能用父窗口的 instanceof Blob 判断。
          if (shot && typeof shot.size === 'number' && shot.size > 0 && typeof shot.arrayBuffer === 'function') {
            return new Blob([await shot.arrayBuffer()], { type: shot.type || 'image/png' })
          }
        } catch {
          /* 自定义截图失败就走下面的 Canvas 合成帧，不让扩展点拖垮通用能力 */
        }
      }
      return captureCanvasScreenshot(canvas)
    },
    async startRemoteRecording() {
      // 同源游戏优先继续使用播放器原有的采集 / 录制链路。
      if (frameDocument() || !gameSdkReady) return false
      return (await requestGameSdk('record-start')) === true
    },
    async stopRemoteRecording() {
      if (!gameSdkReady) return null
      const result = await requestGameSdk('record-stop')
      if (!result || typeof result !== 'object' || Number((result as Blob).size) <= 0 || Number((result as Blob).size) > 96 * 1024 * 1024 || typeof (result as Blob).arrayBuffer !== 'function') return null
      return result as Blob
    },
    async startRemoteLiveCapture() {
      if ((!isManagedPvzEntry() && !isManagedMinecraftEntry() && !isManagedCs16Entry()) || frameDocument()) return false
      if (remoteLiveSession && remoteLiveCanvas && remoteLiveCanvas.width >= 16) return true
      if (!gameSdkReady) return null
      if (!gameSdkLiveCapable) return false
      const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      clearRemoteLiveCanvas()
      remoteLiveSession = sessionId
      let started = false
      try {
        started = await requestGameSdk('live-start', { sessionId, fps: 30 }) === true
      } catch {
        started = false
      }
      if (!started || remoteLiveSession !== sessionId || !remoteLiveCanvas || remoteLiveCanvas.width < 16) {
        if (remoteLiveSession === sessionId) clearRemoteLiveCanvas()
        return false
      }
      return true
    },
    stopRemoteLiveCapture,
    destroy() {
      if (remoteLiveSession && gameSdkReady && gameSdkOrigin) {
        try {
          iframe.contentWindow?.postMessage({
            source: '8bitgo-host',
            version: GAME_SDK_VERSION,
            type: 'live-stop',
            token: gameSdkToken,
            requestId: ++gameSdkRequestId,
            options: { sessionId: remoteLiveSession },
          }, gameSdkOrigin)
        } catch {
          /* iframe 随后会导航，失败时浏览器也会回收该文档 */
        }
      }
      clearRemoteLiveCanvas()
      destroyed = true
      stopMediaMonitoring(false)
      window.removeEventListener('message', onSaveBridgeMessage)
      window.removeEventListener('message', onRuntimeBridgeMessage)
      window.removeEventListener('message', onGameSdkMessage)
      for (const pending of pendingGameSdkRequests.values()) {
        window.clearTimeout(pending.timer)
        pending.reject(new Error('网页游戏已关闭'))
      }
      pendingGameSdkRequests.clear()
      for (const pending of pendingSaveRequests.values()) {
        window.clearTimeout(pending.timer)
        pending.reject(new Error('网页游戏已关闭'))
      }
      pendingSaveRequests.clear()
      try {
        iframe.src = 'about:blank'
      } catch {
        /* ignore */
      }
      // 页面正常导航会自己关；异常启动时再兜一次，避免 WebAudio 线程留到 GC 才释放。
      for (const tap of liveMediaTaps) {
        const ctx = tap.ctx
        if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
      }
      liveMediaTaps.clear()
      iframe.remove()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    },
  }
}
