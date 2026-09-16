/**
 * Ruffle 运行时：Flash（.swf）。
 *
 * Ruffle 是用 Rust 编写、编译为 WebAssembly 的开源 Flash 播放器（MIT / Apache-2.0）。
 * 同样放进独立 iframe 里运行，便于销毁与隔离。
 *
 * 资源路径：默认 /ruffle/（由 scripts/copy-ruffle.mjs 从 npm 包复制到 public/ruffle/），
 * 也可设置 VITE_RUFFLE_PATH 指向 CDN，例如 https://unpkg.com/@ruffle-rs/ruffle/
 */
import type { CaptureSources, Capability, MountOptions, PadButton, RuntimeHandle } from '../types'
import { flashKeysFor, keyDesc, type KeyDesc } from '../flashKeys'
import { loadGameBytes } from '../romLoader'
import { assertSwf } from '@/lib/romValidation'
import { canvasToBlob } from '../recorder'
import { usableVideoSize } from '../videoTuning'
import { focusFrame } from '../frameFocus'
import { isTyping } from '../hotkeyBridge'
import { installAudioTap, type AudioTap } from '../audioTap'
import {
  FLASH_SAVE_FORMAT, LEGACY_FLASH_PREFIX, flashMovieUrl, flashSavePrefix,
  readFlashEntries, readLegacyFlashEntries, restoreFlashEntries, validFlashEntries,
} from '../ruffleSaves'
import { getT, fmt } from '@/services/i18n'
import { flashOnlineSaveRuffleConfig, prepareFlashOnlineSave } from '@/services/flashOnlineSave'
import { prepareSfsRuffleConfig } from '@/services/sfs'

export { RUFFLE_PATH } from '../paths'
import { RUFFLE_PATH } from '../paths'

/* ---------------- 设备字体（中文不显示的根因）---------------- */

/**
 * Flash 里的文字分两种：**嵌入字体**（字形打包在 SWF 里）和**设备字体**
 * （只写一个字体名，播放时用系统里的字）。当年的中文 Flash 几乎都用设备字体 ——
 * 一套中文字库上万个字形，嵌进去 SWF 会大到没法在拨号网络上传播。
 *
 * Ruffle 的 deviceFontRenderer 默认是 'embedded'，它自己的说明写得很清楚：
 *   "It cannot access device fonts and uses fonts provided in the configuration
 *    and the default Noto Sans font as a fallback."
 * Noto Sans 是纯拉丁字库，**一个汉字都没有** —— 所以中文菜单直接渲染成空白，
 * 而标题那种做成图形/嵌入字体的反而正常。这就是「网页版文字不见了」的全部原因。
 *
 * 换成 'canvas' 之后，Ruffle 用一块离屏画布走浏览器的字体栈来画字，
 * 系统里有的中文字就能出来。官方标它为 experimental（字形按位图渲染，
 * 极端缩放 / 旋转下可能不如矢量锐利），但对「有字」和「没字」来说这个代价很划算。
 *
 * 想退回官方默认：VITE_RUFFLE_FONT_RENDERER=embedded
 */
const FONT_RENDERER: string = import.meta.env.VITE_RUFFLE_FONT_RENDERER || 'canvas'

/**
 * 可选：自带字体，不靠访客机器上有没有中文字库。
 *
 * Ruffle 的 fontSources 只认 **SWF**（官方原话 "Currently only SWFs are supported"），
 * 里面嵌的每个字体都会被当作设备字体。所以要用的话得先把 ttf 打成一个字体 SWF。
 * 代价是体积：一套中文字库动辄几 MB，除非做子集化，否则每个 Flash 游戏都要先下这一坨。
 *
 *   VITE_RUFFLE_FONT_SOURCES=/ruffle/fonts/noto-sans-sc.swf
 *   VITE_RUFFLE_FONT_SANS=Noto Sans SC
 *
 * 配了 FONT_SOURCES 就说明是想要确定性的排版，这时默认切回 'embedded' 渲染器
 * （矢量、跨机器一致），除非显式指定了 VITE_RUFFLE_FONT_RENDERER。
 */
const FONT_SOURCES: string[] = (import.meta.env.VITE_RUFFLE_FONT_SOURCES || '')
  .split(',')
  .map((u: string) => u.trim())
  .filter(Boolean)

const FONT_SANS: string = import.meta.env.VITE_RUFFLE_FONT_SANS || ''

/** 拼出这次加载要用的字体相关配置 */
function fontConfig(): Record<string, unknown> {
  const renderer = import.meta.env.VITE_RUFFLE_FONT_RENDERER || (FONT_SOURCES.length ? 'embedded' : FONT_RENDERER)
  const cfg: Record<string, unknown> = { deviceFontRenderer: renderer }
  if (FONT_SOURCES.length) {
    cfg.fontSources = FONT_SOURCES
    if (FONT_SANS) {
      const names = FONT_SANS.split(',').map((n) => n.trim()).filter(Boolean)
      // _sans / _serif / _等幅 都指向同一套中文字体：中文 Flash 基本只用 _sans，
      // 但偶尔有写 _serif 的，与其让它掉回没有汉字的 Noto Sans，不如都指过去
      cfg.defaultFonts = { sans: names, serif: names, typewriter: names, japaneseGothic: names }
    }
  }
  return cfg
}

/**
 * Ruffle 的播放器接口。
 *
 * 注意这里有两套命名并存：老的门面叫 play() / pause()，
 * 新的 PlayerV1 门面叫 resume() / suspend()（对应的只读属性也从 isPlaying 变成 suspended）。
 * 发行包里两套都可能拿到，所以全部写成可选，调用时挨个试。
 */
interface RufflePlayerApi {
  load: (options: Record<string, unknown>) => Promise<void> | void
  reload?: () => Promise<void>
  play?: () => void
  resume?: () => void
  pause?: () => void
  suspend?: () => void
  isPlaying?: boolean
  volume?: number
}
/** 新版通过 player.ruffle() 取 API，旧版直接在元素上调用 load() */
interface RufflePlayerElement extends HTMLElement, Partial<RufflePlayerApi> {
  ruffle?: () => RufflePlayerApi
}
interface RuffleSource {
  createPlayer: () => RufflePlayerElement
}
interface RuffleGlobal {
  newest: () => RuffleSource | null
}

/* ---------------- Flash 存档（SharedObject）---------------- */

interface FlashSaveFile {
  format: string
  version: number
  game?: string
  slug?: string
  savedAt?: string
  /** v1 是完整 localStorage 键；v2 是当前游戏路径下的槽名。 */
  entries: Record<string, string>
}

/**
 * 等一个 <video> 真的拿到一帧。
 *
 * captureStream 出来的流挂到 video 上之后，videoWidth 要等第一帧解码完才有值，
 * 这之前 drawImage 画出来是空的。有 requestVideoFrameCallback 就用它（最准），
 * 没有就退回 loadeddata + 一小段安置时间。无论如何 1.5 秒后放行 —— 截图不能卡死。
 */
function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, 1500)
    const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
      .requestVideoFrameCallback
    if (typeof rvfc === 'function') rvfc.call(video, finish)
    else video.addEventListener('loadeddata', () => window.setTimeout(finish, 120), { once: true })
  })
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  /** 加载成功后才知道能不能暂停 / 调音量，先空着，等 load() 回来再报 */
  const caps = new Set<Capability>()
  /** 播放器元素与它的 API 门面（两者都可能带 volume / pause） */
  let player: RufflePlayerElement | null = null
  let api: RufflePlayerApi | null = null
  let volume = 1

  /**
   * 这款游戏读哪几个键。Flash 没有统一手柄，只能逐游戏配（见 flashKeys.ts）。
   * null = 表里没有这款 —— 不画屏幕手柄，也不注入任何按键。
   */
  const keys = flashKeysFor(options.gameSlug)
  /**
   * 已经按下、还没松开的键（按 code 记）。
   * 只为去重：Flash 游戏是轮询 Key.isDown 的，补发一次 down 没用，
   * 而漏掉一次 up 就是角色卡着一直往一个方向走。
   * 不用在 destroy 里补松开 —— 屏幕手柄自己卸载时会 releaseAll，剩下的跟着 iframe 一起没。
   */
  const downKeys = new Set<string>()

  /**
   * 取 Ruffle 的画布。
   *
   * ⚠️ 它在 <ruffle-player> 的 **shadow DOM** 里（Ruffle 内部 attachShadow({mode:'open'})，
   *    画布挂在 shadow 里的 #container 上），所以 iframe.contentDocument.querySelector('canvas')
   *    **永远返回 null** —— 这条路我实测过，走不通。必须从 player.shadowRoot 找。
   *    同源播放框加上 shadow 是 open 模式，所以这里拿得到。
   *
   * 每次现查、不缓存：读档会调 player.reload()，画布会被换掉。
   */
  const stageCanvas = (): HTMLCanvasElement | null => {
    try {
      return player?.shadowRoot?.querySelector('canvas') ?? null
    } catch {
      return null
    }
  }

  /**
   * 舞台画布，而且**画面是有意义的**。
   *
   * Ruffle 的画布尺寸 = `<ruffle-player>` 元素的 CSS 尺寸 × devicePixelRatio（2026-09-06 实测，
   * 元素为 0 时才退回 SWF 舞台尺寸），所以播放器还没被布局出来的那一刻它可能只有 2×2。
   * 那种画布抓出来是**纯黑**，推流和截图都不该用它 —— 线上出过一次：
   * 观众收到 2×2 黑屏，全程零报错（见 videoTuning 的 `MIN_VIDEO_EDGE`）。
   *
   * 不缓存、每次现查：元素长大之后 Ruffle 会重建画布，等得到就会等到。
   */
  const usableStageCanvas = (): HTMLCanvasElement | null => {
    const c = stageCanvas()
    return c && usableVideoSize(c.width, c.height) ? c : null
  }

  /** Ruffle 的 data 模式按播放框地址和文件名造虚拟 URL，和下载网址无关。 */
  let movieUrl: URL | null = null
  let lastLoadOptions: Record<string, unknown> | null = null
  const saveId = options.gameSlug || (typeof options.game === 'string' ? options.game : `local:${options.game.name}`)
  // 会话申请和 ROM 下载并行；普通 Flash 游戏会立刻得到 null，不增加任何请求。
  const flashOnlineSave = prepareFlashOnlineSave(options.gameSlug)
  // SFS 是可选旁路。后端没开或 Java sidecar 故障时得到空对象，不阻塞其余 Flash 游戏。
  const sfsRuffleConfig = prepareSfsRuffleConfig()
  const storage = (): Storage => {
    try { return localStorage } catch { throw new Error(rt.flashStorageUnavailable) }
  }

  /** 元素和门面上都可能有这些成员，挨个找第一个有的 */
  const canPause = (): boolean =>
    [api, player].some((x) => x && (typeof x.pause === 'function' || typeof x.suspend === 'function'))
  const hasVolume = (): boolean => [api, player].some((x) => x && typeof x.volume === 'number')
  const applyVolume = () => {
    for (const target of [api, player]) {
      if (!target || typeof target.volume !== 'number') continue
      try {
        target.volume = volume
      } catch {
        /* 换下一个门面 */
      }
    }
  }

  /** 音频探针（见 ../audioTap）。ruffle.js 加载前装上，销毁时跟着 iframe 一起没 */
  let audioTap: AudioTap | null = null

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.flashTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0b0f'
  iframe.setAttribute('allow', 'fullscreen; autoplay; clipboard-write')
  // srcdoc 的 location 是 about:srcdoc；Ruffle 会拿它当 SWF 地址，所有游戏的
  // SharedObject 因而落到同一条 /srcdoc/ 路径。用同源静态壳和逐游戏历史地址隔开。
  // 2026-09-13 用自制 SWF 在真实浏览器量到的键：
  // 127.0.0.1/flash-frames/smoke/save-smoke.swf/slot1；旧版则是 /srcdoc/slot1。
  iframe.src = '/flash-frame.html'

  let destroyed = false
  /** SWF 下载的取消把手：换游戏后别让旧会话继续拉完整个 SWF（见 jsnes 同款注释） */
  const aborter = new AbortController()
  /** Ruffle 会在 load() resolve 后继续换内部节点；焦点补刷必须可取消，避免旧会话回头抢焦点。 */
  let focusRaf = 0
  let focusTimer = 0

  const cancelFocusRetry = () => {
    if (focusRaf) cancelAnimationFrame(focusRaf)
    if (focusTimer) window.clearTimeout(focusTimer)
    focusRaf = 0
    focusTimer = 0
  }

  /**
   * 把焦点交给播放器元素本身。
   *
   * ⚠️ 光 focusFrame(iframe) **不够**。Ruffle 只处理「它自己那个元素有焦点」时的键盘事件，
   * 用 Playwright 在「外层页面 + 同源 iframe」这套真实结构上量过（2026-09-04）：
   *
   *   焦点在外层按钮上                → 事件根本不进 iframe
   *   只 iframe.focus()（内部焦点在 body）→ 事件到了 iframe 的 window，但 defaultPrevented 是
   *                                      false —— Ruffle 看都不看，**真键盘也一样**
   *   再 player.focus()                → defaultPrevented 变 true，Ruffle 吃下了
   *
   * 也就是说别的运行时「把焦点还给 iframe」就够了，Flash 得多走一步。
   * preventScroll 两处都要给：手机上没有它会把页面猛地滚到播放器（见 frameFocus.ts）。
   *
   * 8BG 让这条竞态更容易复现：解密完成后才调 Ruffle.load()，等 load() resolve 时，
   * Ruffle 仍可能在随后一两帧重建 shadow DOM / 自动播放浮层。只抢一次焦点会被它马上
   * 覆盖，玩家看到的就是「画面正常，但键盘要先点一下才认」。所以即时交一次，再在
   * 下一帧和短延时各确认一次；如果玩家已经点到评论框等外层控件，补刷必须立刻停，
   * 不能为了游戏把正在输入的光标抢走。
   */
  const focusPlayerNow = () => {
    focusFrame(iframe)
    try {
      if (!player) return
      // 自定义元素没有 tabindex 时 HTMLElement.focus() 在部分浏览器里是空操作。
      // 只在 Ruffle 自己没声明时补，避免覆盖它未来版本选择的 tab 顺序。
      if (!player.hasAttribute('tabindex')) player.tabIndex = 0
      player.focus({ preventScroll: true })
    } catch {
      /* 元素已经拆了就算了 */
    }
  }

  const focusPlayer = (force = false) => {
    // 8BG 解密可能持续几秒；玩家等候期间已经点进评论框时，游戏就绪不能把输入光标抢走。
    // 读档完成是例外：文件选择器 / 工具栏仍持有焦点，必须明确交还给刚重载的游戏。
    if (destroyed || (!force && isTyping(document.activeElement))) return
    cancelFocusRetry()
    focusPlayerNow()

    const retry = () => {
      if (destroyed) return
      const active = document.activeElement
      // 第一次 focus 成功后，外层 activeElement 应该是 iframe。body / html / null 是浏览器
      // 尚未落定焦点的过渡态，也可以补；其它元素说明玩家已经主动去操作页面，不能再抢。
      if (active && active !== iframe && active !== document.body && active !== document.documentElement) return
      focusPlayerNow()
    }
    focusRaf = requestAnimationFrame(() => {
      focusRaf = 0
      retry()
    })
    focusTimer = window.setTimeout(() => {
      focusTimer = 0
      retry()
    }, 180)
  }

  /**
   * 把一次按键打进 Ruffle。
   *
   * 和 js-dos 那边的做法正好相反：那边**不能**合成事件（它的键盘处理挂在页面上，
   * 合成事件会撞上别的监听，keyCode 各浏览器也对不齐），所以走引擎自己的 sendKeyEvent。
   * Ruffle 没有对应的公开接口，但合成事件在它这儿成立，有三个依据：
   *   1. 它自己就这么干 —— 虚拟键盘（发行包 ruffle.js 的 virtualKeyboardInput）
   *      正是往 this.element 上 dispatch 一个 new KeyboardEvent(..., { key, bubbles: true })
   *   2. 发行包里 isTrusted 出现 0 次，它不区分真按键和合成事件
   *   3. Ruffle 跑在自己的同源 iframe 文档里，撞不到外层页面的监听
   *
   * 派发目标是 <ruffle-player> 元素本身：画布在它的 shadow 里，往下派发不到；
   * 而 Ruffle 0.5.0 的监听实测挂在 iframe 的 **window** 上，所以必须 bubbles:true 让它冒上去。
   *
   * ⚠️ 但事件到得了不等于它会理 —— 见 focusPlayer 那段，注入前必须先把焦点要回来。
   */
  const dispatchKey = (desc: KeyDesc, down: boolean) => {
    const win = iframe.contentWindow as (Window & typeof globalThis) | null
    const target: EventTarget | null = player ?? iframe.contentDocument
    if (!win || !target) return
    try {
      // 用 iframe 自己的构造函数，事件和目标同一个 realm
      target.dispatchEvent(
        new win.KeyboardEvent(down ? 'keydown' : 'keyup', {
          key: desc.key,
          code: desc.code,
          // 废弃字段，但老代码还看它；浏览器的 event.which 也跟着它走
          keyCode: desc.keyCode,
          bubbles: true,
          cancelable: true,
          // shadow DOM 边界：Ruffle 的监听可能在 shadow 外面
          composed: true,
          view: win,
        }),
      )
    } catch {
      /* 实例已经拆了就忽略 */
    }
  }

  iframe.addEventListener('load', () => {
    if (destroyed) return
    const win = iframe.contentWindow as (Window & { RufflePlayer?: RuffleGlobal }) | null
    const doc = iframe.contentDocument
    if (!win || !doc) {
      options.onError?.(rt.flashInitFailed)
      return
    }
    try {
      win.history.replaceState(null, '', `/flash-frames/${encodeURIComponent(saveId)}/frame.html`)
    } catch {
      options.onError?.(rt.flashInitFailed)
      return
    }

    /*
      音频探针要赶在 ruffle.js 之前装：它一加载就会自己 new AudioContext，晚一步就接不着了。
      装的是**这个 iframe 自己的 realm**，不碰父页面，销毁时跟着 iframe 一起没。
      拿不到就是拿不到 —— captureSources 那边照旧只给画面，和以前一样是静音，不会更糟。
    */
    audioTap = installAudioTap(win as unknown as Window & Record<string, unknown>)

    const script = doc.createElement('script')
    script.src = `${RUFFLE_PATH}ruffle.js`
    script.onerror = () => {
      // 给运维看的细节（路径 / 该配哪个 env）进控制台；红字只说玩家能理解的那句
      console.warn(`[ruffle] failed to load ${RUFFLE_PATH}ruffle.js — run \`npm run ruffle\` or set VITE_RUFFLE_PATH`)
      if (!destroyed) options.onError?.(fmt(rt.ruffleLoadFailed, { path: RUFFLE_PATH }))
    }
    script.onload = async () => {
      if (destroyed) return
      try {
        const source = win.RufflePlayer?.newest()
        if (!source) throw new Error(rt.ruffleNotInit)
        player = source.createPlayer()
        const host = doc.getElementById('host')
        host?.appendChild(player)
        // ruffle.js 只是加载器，核心与自定义元素是按需异步注册的，需等元素升级完成
        await win.customElements.whenDefined(player.tagName.toLowerCase())
        // 极少数情况下（例如浏览器 locale 异常导致构造函数抛错）元素不会被升级，重建一次
        if (typeof player.ruffle !== 'function' && typeof player.load !== 'function') {
          player.remove()
          player = source.createPlayer()
          host?.appendChild(player)
        }

        const [onlineSave, sfsConfig] = await Promise.all([flashOnlineSave, sfsRuffleConfig])
        const base = {
          autoplay: 'on',
          unmuteOverlay: 'visible',
          letterbox: 'on',
          /**
           * ⚠️ 千万别在这里填颜色。
           *
           * Ruffle 的 backgroundColor **不是**「没有背景色时的兜底」，而是**强行覆盖**
           * SWF 自己的舞台背景色（官方文档原话：specify a color … it will override the
           * SWF file's native background color；默认 null 才是用 SWF 自己的）。
           * 以前这里填了 #0b0b0f，于是每一个 Flash 游戏的舞台底色都被涂成近黑 ——
           * 当年大量 Flash 游戏是「白底 + 黑线稿」或者靠舞台底色当背景画的，
           * 一涂就变成整片黑屏，看起来像模拟器没跑起来。
           *
           * 播放器周围留白的深色由 iframe 和 #host 的 CSS 负责，和这里无关。
           */
          backgroundColor: null,
          splashScreen: false,
          warnOnUnsupportedContent: false,
          publicPath: RUFFLE_PATH,
          // SAS3.swf 写死 sas3server.ninjakiwi.com:444；Ruffle 用这张表把它改送同源 WSS 桥。
          ...sfsConfig,
          ...flashOnlineSaveRuffleConfig(onlineSave),
          // 中文 / 日文这类设备字体文本要靠它才画得出来，见文件顶部的说明
          ...fontConfig(),
        }
        const isFile = typeof options.game !== 'string'
        let loadOptions: Record<string, unknown>
        if (isFile) {
          const loaded = await loadGameBytes(options.game, options.onProgress, aborter.signal)
          assertSwf(loaded.data)
          movieUrl = flashMovieUrl(win.location.href, loaded.name)
          loadOptions = { ...base, data: loaded.data, swfFileName: loaded.name }
        } else {
          /**
           * 远程 SWF 自己下，而不是把 url 丢给 Ruffle —— 这样才拿得到真实的下载字节数。
           *
           * 代价是 Ruffle 不再知道这个 SWF 是从哪来的，而当年不少 Flash 游戏会用
           * loadMovie / XML 之类去取同目录的外部素材，相对路径会从「SWF 所在目录」
           * 变成「当前页面」，素材全 404。所以必须显式把 base 设回 SWF 的目录 ——
           * base 是 Ruffle 的正式配置项（DEFAULT_CONFIG 里 base:null），给了 url 时
           * 它本来也是这么推的，这里只是把同一件事写明白。
           */
          const url = options.game as string
          const loaded = await loadGameBytes(url, options.onProgress, aborter.signal)
          assertSwf(loaded.data)
          movieUrl = flashMovieUrl(win.location.href, loaded.name)
          loadOptions = {
            ...base,
            data: loaded.data,
            swfFileName: loaded.name,
            base: new URL('.', new URL(url, location.href)).href,
          }
        }

        api = typeof player.ruffle === 'function' ? player.ruffle() : typeof player.load === 'function' ? (player as RufflePlayerApi) : null
        if (!api) throw new Error(rt.ruffleNoApi)
        // 上面一连串 await（等自定义元素注册、读文件）之间玩家可能已经换了 ROM，
        // 这里要重新确认一次，别把旧会话的结果算到新会话头上
        if (destroyed) return
        options.onProgress?.({ phase: 'starting', ratio: 1 })
        lastLoadOptions = loadOptions
        await api.load(loadOptions)
        if (destroyed) return
        // onReady 必须在 load 完成之后 —— 以前放在 load 之前，播放器会在 SWF 还没解析完
        // 就把加载遮罩撤掉，玩家对着空白舞台点半天
        options.onReady?.()
        // 不只依赖外层播放器下一次 React effect：解密后的异步启动链较长，Ruffle 自己还会
        // 在 load resolve 后换内部节点。这里从适配器内部钉住真正接键盘的元素。
        focusPlayer()

        // 能力要等实例真的建起来才作数：SWF 加载之前 volume 的 setter 是空转的
        if (canPause()) caps.add('pause')
        // 存档能力恒定有：导出时再看有没有内容
        caps.add('saveState')
        // 屏幕手柄由播放器画（TouchPad.tsx），按下走下面的 sendButton。
        // 两个条件：
        //   1. 放在 load 之后而不是挂载时 —— sendButton 要有 player 元素才发得出去，
        //      早一步把手柄画出来，玩家按了没反应
        //   2. **只有键位表里认得这款游戏才画**。Flash 里一大半是纯鼠标游戏，
        //      给它们画一套没反应的十字键（外加一句「手柄在下面」的开局提示）比不画糟得多
        if (keys) caps.add('touchpad')
        // 录像 / 开播 / 截图都靠画布，画布是在 load() 完成的那一刻出现的（实测），
        // 所以在这儿判断刚好，早一步查是 null
        if (stageCanvas()) {
          caps.add('record')
          caps.add('screenshot')
        }
        if (hasVolume()) {
          caps.add('volume')
          applyVolume()
        }
        options.onCaps?.(caps)
        options.onStart?.()
      } catch (err) {
        // 销毁之后的报错不再上报：否则玩家刚拖进来的新游戏会被上一个的错误顶掉，
        // 画面消失、只剩一条红色提示，而新的模拟器其实还在后台出声
        if (destroyed) return
        options.onError?.(fmt(rt.flashLoadFailed, { msg: err instanceof Error ? err.message : String(err) }))
      }
    }
    doc.head.appendChild(script)
  })

  container.appendChild(iframe)
  options.onCaps?.(caps)

  /**
   * Ruffle 重载前会销毁旧实例；销毁时旧 SharedObject 可能再写一次。
   * 所以先从 DOM 拿掉播放器让旧实例落盘，再替换 localStorage，最后接回并重载。
   */
  const restoreGame = async (entries: Record<string, string>, replace: boolean): Promise<void> => {
    if (!player || !api || !movieUrl || !lastLoadOptions || destroyed) throw new Error(rt.flashReloadFailed)
    const currentPlayer = player
    const currentApi = api
    const parent = currentPlayer.parentElement
    if (!parent) throw new Error(rt.flashReloadFailed)
    const store = storage()
    const prefix = flashSavePrefix(movieUrl)
    const reload = async () => {
      const target = [currentApi, currentPlayer].find((item) => typeof item.reload === 'function')
      if (target?.reload) await target.reload()
      else await currentApi.load(lastLoadOptions!)
    }
    currentPlayer.remove()
    let before: Record<string, string> | null = null
    try {
      before = readFlashEntries(store, prefix)
      restoreFlashEntries(store, prefix, entries, replace)
      parent.appendChild(currentPlayer)
      await reload()
      downKeys.clear()
      applyVolume()
      // 读档由外层工具栏发起，焦点此时在按钮上；状态仍是 running，不会再触发通用聚焦 effect。
      focusPlayer(true)
    } catch (error) {
      // 读档失败不能把半份新进度留在浏览器；回到旧值后尽量把原游戏重开。
      currentPlayer.remove()
      try { if (before) restoreFlashEntries(store, prefix, before, true) } finally {
        parent.appendChild(currentPlayer)
        try { await reload() } catch { /* 原始错误更有用 */ }
      }
      throw error
    }
  }

  return {
    caps,
    volume,
    // Flash 游戏也在 iframe 里，键盘操作的那些（横版过关、打字游戏）不交焦点就是死的。
    // 注意是 focusPlayer 不是 focusFrame —— 只把焦点给到 iframe，Ruffle 照样不收键盘
    focus: focusPlayer,
    setPaused(next: boolean) {
      // 两套门面轮流试：老的 play/pause，新的 resume/suspend
      for (const target of [api, player]) {
        if (!target) continue
        try {
          const fn = next ? (target.pause ?? target.suspend) : (target.play ?? target.resume)
          if (typeof fn === 'function') {
            fn.call(target)
            return
          }
        } catch {
          /* 换下一个门面 */
        }
      }
    },
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      applyVolume()
    },
    /** 屏幕手柄只画这款游戏真的读的那几颗键；表里没有这款就一颗都不画 */
    padButtons: keys ? (Object.keys(keys.p1) as PadButton[]) : [],
    /**
     * 2P 位读哪几颗键。有这一项直播那边才会把「让观众上场」开出来（见 coopSeat.ts）——
     * 同屏双打的游戏才在 flashKeys 里配了 p2，别的 Flash 游戏这里是空的，入口也就不出现。
     */
    coopButtons: keys?.p2 ? (Object.keys(keys.p2) as PadButton[]) : [],
    /**
     * 屏幕手柄按下 / 松开。player 是座位号：0 = 1P（本机的屏幕手柄永远是它），
     * 1 = 2P（同屏双打的第二套键，留给「把观众提成 2P」那一步）。
     */
    sendButton(button, down, seat = 0) {
      if (!keys) return
      // 参数叫 seat 不叫 player：外面那个 player 是 <ruffle-player> 元素，别遮住它
      const pad = seat === 1 ? keys.p2 : keys.p1
      const name = pad?.[button]
      // 这款游戏用不上这颗键（屏幕上本来也不该画出来）
      if (!name) return
      const desc = keyDesc(name)
      if (!desc) {
        console.warn('[ruffle] 键位表里有个认不出来的键名：', name)
        return
      }
      if (down === downKeys.has(desc.code)) return
      // 按下时顺手把焦点要回来（松开不要 —— 松手去抢焦点没道理）。
      // 玩家可能刚点过页面上别的东西，那时候注入进去 Ruffle 是不理的
      if (down) focusPlayer()
      if (down) downKeys.add(desc.code)
      else downKeys.delete(desc.code)
      dispatchKey(desc, down)
    },
    captureSources(): CaptureSources | null {
      const canvas = usableStageCanvas()
      if (!canvas) return null
      /**
       * 画面 + 声音。
       *
       * Ruffle 的音频跑在它自己 new 出来的 AudioContext 里，没有任何公开接口把 AudioNode
       * 交出来 —— 所以在装上探针之前，Flash 的录像和直播一律是**静音**的。
       *
       * 现在走 `../audioTap`：在 ruffle.js 加载之前换掉这个 iframe realm 里的
       * AudioContext 构造函数和 AudioNode.prototype.connect，把接到扬声器的那一路
       * 旁路一份到我们自己的 GainNode 上。EmulatorJS 那条路早就是这么干的，
       * 这次只是把同一份实现抽出来共用。
       *
       * ⚠️ 原来这里的注释担心「patch 一旦有闪失就是全站 Flash 没声音」。那个顾虑
       * 建立在「改的是公共音频通路」上，而实际落点是**每一局自己那个 iframe**：
       * 换游戏就是新 realm，销毁时整个 realm 跟着没，patch 不会外溢到父页面或别的运行时。
       * 加上探针内部每一步都兜住了失败，最坏的结果就是回到今天 —— 没声音。
       *
       * ⚠️ AudioContext 是**懒建**的（Ruffle 要等第一声才建，而且受自动播放策略约束）。
       * 所以这个函数第一次被调时 tap 很可能还是空的 —— 调用方要重试，
       * 见 LiveControls 里等声音的那几轮。
       */
      return { canvas, audioNode: audioTap?.node ?? null, audioContext: audioTap?.ctx ?? null }
    },
    async screenshot() {
      // 同样要过尺寸这一关：2×2 的画布截出来是一张 2×2 的图，
      // 当封面用会一路存进对象存储，比截图失败糟得多
      const canvas = usableStageCanvas()
      if (!canvas || typeof canvas.captureStream !== 'function') return null
      /**
       * 为什么不直接 canvas.toBlob()：
       * Ruffle 用 WebGL 渲染且没开 preserveDrawingBuffer，绘制之外的时刻读回来是
       * **全透明**的 —— 实测 toDataURL / drawImage 拿到的中心像素是 rgba(0,0,0,0)，
       * 放在 requestAnimationFrame 里读也一样。
       * 绕一圈走 captureStream：合成器交出来的帧是有内容的（实测像素与 SWF 舞台底色一致），
       * 落到一个隐藏 <video> 上再画一次就拿到真画面。代价是多等一帧。
       */
      let stream: MediaStream | null = null
      const video = document.createElement('video')
      try {
        stream = canvas.captureStream()
        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
        document.body.appendChild(video)
        await video.play().catch(() => {})
        await waitForFrame(video)
        if (!video.videoWidth) return null
        const out = document.createElement('canvas')
        out.width = video.videoWidth
        out.height = video.videoHeight
        const ctx = out.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(video, 0, 0)
        return await canvasToBlob(out)
      } catch {
        return null
      } finally {
        stream?.getTracks().forEach((t) => t.stop())
        video.srcObject = null
        video.remove()
      }
    },
    saveExt: 'flashsave.json',
    async saveState() {
      if (!movieUrl) throw new Error(rt.flashNoSave)
      const entries = readFlashEntries(storage(), flashSavePrefix(movieUrl))
      if (!Object.keys(entries).length) throw new Error(rt.flashNoSave)
      // 只存当前游戏路径下的槽名；完整键含站点域名，跨设备/测试站恢复时会失效。
      const file: FlashSaveFile = {
        format: FLASH_SAVE_FORMAT,
        version: 2,
        game: options.gameName,
        slug: saveId,
        savedAt: new Date().toISOString(),
        entries,
      }
      return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    },
    async loadState(data: ArrayBuffer) {
      let file: FlashSaveFile
      try {
        file = JSON.parse(new TextDecoder().decode(data)) as FlashSaveFile
      } catch {
        throw new Error(rt.flashSaveBad)
      }
      if (file?.format !== FLASH_SAVE_FORMAT || !validFlashEntries(file.entries) || !movieUrl) throw new Error(rt.flashSaveBad)
      let entries: Record<string, string>
      if (file.version === 2) {
        if (file.slug !== saveId) throw new Error(rt.flashSaveForeign)
        entries = file.entries
      } else if (file.version === 1) {
        // 旧版文件只有显示名称而没有 slug，先核对名称，再把旧完整键映射到独立路径。
        // 混入其它游戏的键一律整份拒绝，不能只导入其中一部分却提示成功。
        if (file.game !== options.gameName) throw new Error(rt.flashSaveForeign)
        const prefix = flashSavePrefix(movieUrl)
        entries = Object.create(null)
        for (const [key, value] of Object.entries(file.entries)) {
          const source = key.startsWith(prefix) ? prefix : key.startsWith(LEGACY_FLASH_PREFIX) ? LEGACY_FLASH_PREFIX : null
          if (!source || key.length === source.length) throw new Error(rt.flashSaveForeign)
          entries[key.slice(source.length)] = value
        }
      } else throw new Error(rt.flashSaveBad)
      if (!Object.keys(entries).length) throw new Error(rt.flashSaveBad)
      await restoreGame(entries, file.version === 2)
      return rt.flashSaveImported
    },
    hasLegacyFlashSave() {
      try { return Object.keys(readLegacyFlashEntries(storage())).length > 0 } catch { return false }
    },
    async recoverLegacyFlashSave() {
      const entries = readLegacyFlashEntries(storage())
      if (!Object.keys(entries).length) throw new Error(rt.flashNoSave)
      await restoreGame(entries, true)
      return rt.flashSaveImported
    },
    destroy() {
      destroyed = true
      cancelFocusRetry()
      aborter.abort()
      player = null
      api = null
      // realm 跟着 iframe 一起没，不用还原 patch；只是别留着指向死 realm 的节点
      audioTap = null
      try {
        iframe.src = 'about:blank'
      } catch {
        /* ignore */
      }
      iframe.remove()
    },
  }
}
