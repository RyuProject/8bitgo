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
const PVZ_SHELL_VERSION = '20260924-resume1'

/**
 * PvZ 的 HTML 外壳是固定文件名，Cloudflare 允许旧副本继续服务一小段时间。
 * 后台游戏详情同样有边缘缓存：即使数据库已经换成带版本号的地址，详情接口仍可能短暂
 * 返回不带查询串的旧地址。播放器在最后一跳补上发布代次，避免新增的存档按钮再次被旧壳吞掉。
 *
 * 只改本站精确的中英文入口；第三方 HTML5 游戏和 PvZ 的资源子路径都保持原样。
 */
export function versionHtml5Entry(value: string, base = location.href): string {
  try {
    const baseUrl = new URL(base)
    const url = new URL(value, baseUrl)
    if (url.origin !== baseUrl.origin || !/^\/web\/PvZ\/(?:cn|en)\/?$/.test(url.pathname)) return value
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

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const caps = new Set<Capability>()
  let destroyed = false
  let objectUrl = ''
  let saveBridgeReady = false
  let saveRequestId = 0
  let mediaObserver: MutationObserver | null = null
  let mediaPollTimer = 0
  let firstFrame = false
  let playable = false
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
   * 消息同时校验 source 和 origin：第三方跨源 HTML5 游戏即使伪造同名消息也接不进来；
   * 只有本站同源、明确实现 v1 协议的页面（当前是 PvZ）才会获得 saveState 能力。
   */
  const onSaveBridgeMessage = (event: MessageEvent) => {
    if (destroyed || event.source !== iframe.contentWindow || event.origin !== location.origin) return
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
    else if (signal.type === 'first-interaction') options.onFirstInteraction?.()
    else options.onError?.(signal.detail || 'HTML5 游戏报告启动失败')
  }
  window.addEventListener('message', onRuntimeBridgeMessage)

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
    if (!saveBridgeReady || !iframe.contentWindow) return Promise.reject(new Error('网页游戏存档尚未就绪'))
    const requestId = ++saveRequestId
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingSaveRequests.delete(requestId)
        reject(new Error('网页游戏存档响应超时'))
      }, SAVE_BRIDGE_TIMEOUT_MS)
      pendingSaveRequests.set(requestId, { resolve, reject, timer })
      const message = { source: SAVE_BRIDGE_SOURCE, version: SAVE_BRIDGE_VERSION, type, requestId, data }
      try {
        iframe.contentWindow?.postMessage(message, location.origin, data ? [data] : [])
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
    /**
     * 只认第一次 load。
     *
     * 门户式的 HTML5 游戏会在自己的 iframe 里做整页跳转（菜单页 → 游戏页、关卡之间
     * location.href）。每跳一次就再触发一次 load：以前会再报一次 onReady ——
     * 播放器那边等于**再记一次游玩**（游玩次数虚高），还会把焦点从玩家正在打字的
     * 评论框里抢进 iframe，后面敲的字全打进游戏里。
     */
    options.onIframeLoaded?.()
    if (loaded) return
    loaded = true
    // 这里只撤加载遮罩。真实成功必须等运行时桥或同源 canvas 探针，不能再拿 load 冒充。
    options.onSurfaceReady?.()
  })
  // 跨域 iframe 读不到内部事件；用户亲手点进去时浏览器会把焦点交给 iframe，这仍是可靠的首次操作信号。
  iframe.addEventListener('focus', () => options.onFirstInteraction?.())
  iframe.addEventListener('error', () => {
    if (destroyed) return
    options.onError?.('HTML5 游戏页面加载失败。请检查入口地址，以及目标站点是否允许被 iframe 嵌入。')
  })

  options.onCaps?.(caps)
  options.onProgress?.({ phase: 'starting' })
  // replaceChildren 到 Safari 13.1 才有；播放器容器本来就应该只剩这一项。
  container.textContent = ''
  container.appendChild(iframe)

  if (typeof options.game === 'string') {
    iframe.src = versionHtml5Entry(options.game)
  } else {
    // 单文件 HTML 可以直接运行；需要其它素材的项目应部署完整目录并绑定 index.html。
    objectUrl = URL.createObjectURL(options.game)
    iframe.src = objectUrl
  }

  return {
    caps,
    saveExt: 'pvzsave.zip',
    async saveState() {
      const data = await requestSaveBridge('export')
      if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('网页游戏返回了空存档')
      return new Blob([data], { type: 'application/zip' })
    },
    async loadState(data: ArrayBuffer) {
      // 转移给 iframe 后这份 buffer 会被 detach；复制一份，别改掉调用方手里的云存档缓存。
      await requestSaveBridge('import', data.slice(0))
      saveBridgeReady = false
      caps.delete('saveState')
      options.onCaps?.(caps)
      // PvZ 只在启动时读取玩家资料；导入后原地重载 iframe 才会真正使用新进度。
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
     *   跨源（游戏是第三方独立部署的）
     *     → 浏览器不让读 contentDocument。真要抓只剩 getDisplayMedia，
     *       那需要玩家点一次并亲手选中标签页 —— 和「玩就是播」的静默前提冲突，
     *       所以这里老实返回 null，上层重试几次拿不到就安静地不开播。
     *
     * **只给画面不给声音**：游戏的 AudioContext 是在 iframe 自己的 realm 里 new 出来的，
     * 想接一根线出来必须赶在它的脚本跑起来**之前**把 AudioContext 构造函数换掉，
     * 而我们拿到 contentWindow 的时候游戏早就在加载了。和 Ruffle 是同一个坑
     * （见 adapters/ruffle.ts 里的长注释），先按静音处理。
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
      if (!html5CanvasCapabilities(canvas).screenshot || !canvas) return null

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
    destroy() {
      destroyed = true
      stopMediaMonitoring(false)
      window.removeEventListener('message', onSaveBridgeMessage)
      window.removeEventListener('message', onRuntimeBridgeMessage)
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
