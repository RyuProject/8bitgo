/**
 * webretro 运行时：RetroArch 的 WebAssembly 移植（BinBashBanana/webretro，GPL-3.0）。
 *
 * 目前只接管 **任天堂 DS**（melonDS 核心）—— EmulatorJS 用的 desmume 分支对 NDS
 * 兼容性一般，melonDS 明显更稳。其余平台维持现状走 EmulatorJS，原因见下面
 * ENABLED_PLATFORMS 的注释。
 *
 * 安装：npm run webretro   （拉取到 public/webretro/，仓库自带编译好的 wasm，不需要 emscripten）
 * 启用：.env 设置 VITE_WEBRETRO_PATH=/webretro/
 *
 * 没设 VITE_WEBRETRO_PATH 时 available() 返回 false，解析阶段直接跳过它，
 * NDS 自动退回 EmulatorJS —— 所以「资源还没部署」不会让 NDS 变成不可玩。
 *
 * ── 加载契约（读 webretro 的 assets/base.js 得来，非文档推测）──────────
 *
 *   index.html?core=<核心名>     指定 libretro 核心，取 cores/<核心名>_libretro.js
 *   index.html?system=<系统名>   按系统名自动挑核心（我们用不上，core 更确定）
 *   index.html?rom=<地址>        ROM 地址
 *   index.html?romname=<文件名>  ← 我们打补丁加的，见下
 *   index.html?noautorefocus     别抢焦点（嵌在 iframe 里必须加，否则会打断外层页面）
 *
 * base.js 里的关键两行（readyRomFetch，759-760）：
 *   var romloc = (/^(https?:)?\/\//i).test(queries.rom) ? queries.rom : relativeBase + "roms/" + queries.rom;
 *   var romFilename = queries.rom.split("/").slice(-1)[0];
 *
 * ⚠️ 这两行有两个坑，scripts/setup-webretro.mjs 会打补丁修掉：
 *
 *   1. 原版只认 http(s):// 开头的地址，blob: 会被当成相对路径拼成 roms/blob:...。
 *      玩家「玩本地 ROM」用的正是 blob:，所以补丁把 blob: 也放进白名单。
 *      注意 blob: 是**同源**资源 —— 这也是必须自托管、不能 iframe 官方站的原因。
 *
 *   2. 文件名从地址末段截取。blob: 没有文件名；带签名参数的 CDN 地址
 *      （…/game.nds?token=abc）截出来是 "game.nds?token=abc"。而 webretro 靠
 *      扩展名决定写进虚拟文件系统的 /rom/rom.<ext> 再交给核心，melonDS 拿到
 *      rom.nds?token=abc 是不认的；存档也按这个名字进 IndexedDB。
 *      所以补丁加了 romname= 参数，我们**总是**显式传，不让它自己猜。
 *
 * ⚠️ 远程 ROM 是 iframe 内的 XHR 去取的，对象存储那边必须允许本站跨域，
 *    否则会走到「加载失败」分支。同源的 /j2me/jar/ 那种代理不适用于这里。
 */
import type { PlatformId } from '@/types'
import type { Capability, MountOptions, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'

export const WEBRETRO_PATH: string = (() => {
  const p = import.meta.env.VITE_WEBRETRO_PATH || ''
  if (!p) return ''
  return p.endsWith('/') ? p : `${p}/`
})()

/**
 * 平台 → libretro 核心名。
 *
 * 这里列的都是 webretro 仓库 installedCores 里确实带了 wasm 的核心，
 * 也就是 `npm run webretro`（不加 --cores）之后本地一定有的。
 */
const PLATFORM_CORES: Partial<Record<PlatformId, string>> = {
  nds: 'melonds',
  n64: 'mupen64plus_next',
  psx: 'mednafen_psx_hw',
  nes: 'nestopia',
  snes: 'snes9x',
  gba: 'mgba',
  gb: 'mgba',
  segaMD: 'genesis_plus_gx',
  ws: 'mednafen_wswan',
}

/**
 * 实际交给 webretro 跑的平台。
 *
 * 上面 PLATFORM_CORES 列了九个平台，这里却只放开 NDS —— 不是漏了，是刻意的：
 * **联机（netplay）是 EmulatorJS 独有的**（房主浏览器跑游戏、画面经 WebRTC 推给
 * 访客，见 adapters/emulatorjs.ts）。webretro 没有这套东西。把 NES / SNES / GBA
 * 这些平台改判给 webretro，等于悄无声息地把它们的联机功能关掉。
 *
 * 想再放开某个平台，先确认该平台的联机不重要，再把 id 加进这个集合。
 */
const ENABLED_PLATFORMS = new Set<PlatformId>(['nds'])

const coreFor = (platform: PlatformId): string | undefined =>
  ENABLED_PLATFORMS.has(platform) ? PLATFORM_CORES[platform] : undefined

/** 核心名 → 展示名，跟 webretro 的 coreNames 保持一致 */
const CORE_LABELS: Record<string, string> = {
  melonds: 'melonDS',
  mupen64plus_next: 'Mupen64Plus-Next',
  mednafen_psx_hw: 'Beetle PSX HW',
  nestopia: 'Nestopia UE',
  snes9x: 'Snes9x',
  mgba: 'mGBA',
  genesis_plus_gx: 'Genesis Plus GX',
  mednafen_wswan: 'Beetle WonderSwan',
}

/** 轮询 iframe 内部加载状态的间隔。200ms 足够让进度条走得顺，也不至于空转太凶 */
const POLL_MS = 200
/** 兜底放行时间：资源下不动时最多让玩家等这么久 */
const READY_TIMEOUT_MS = 90_000

/** 从 URL / 对象存储 key 里取出文件名（去掉查询串与锚点） */
function fileNameOf(url: string): string {
  const clean = url.split(/[?#]/)[0]
  return clean.slice(clean.lastIndexOf('/') + 1)
}

function buildUrl(core: string, romUrl: string, romName: string): string {
  // ⚠️ 这里不能用 URLSearchParams。
  //
  // URLSearchParams 按 application/x-www-form-urlencoded 编码，空格出来是 "+"；
  // 而 webretro 解析查询串用的是 decodeURIComponent（base.js:149）——
  // decodeURIComponent 不把 "+" 还原成空格。结果就是「超级马力欧 赛车.nds」
  // 到了里面变成「超级马力欧+赛车.nds」，扩展名没事，但存档键（romName）跟着歪，
  // 玩家看到的是一堆带加号的名字。用 encodeURIComponent 出来是 %20，能正确还原。
  const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`
  const query = [q('core', core), q('rom', romUrl), q('romname', romName)].join('&')
  // noautorefocus 是个开关参数，base.js 用 hasOwnProperty 判断，不需要给值
  return `${WEBRETRO_PATH}index.html?${query}&noautorefocus`
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const destroy = mountRaw(container, options)
  // 暂停 / 存档 / 音量都在 RetroArch 自己的菜单里（iframe 内按 F1 打开，
  // F2 存档、F3 读档、F4 截图），外层工具栏不重复提供，免得两套状态对不上。
  const caps = new Set<Capability>()
  options.onCaps?.(caps)
  return { destroy, caps }
}

function mountRaw(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime

  if (!WEBRETRO_PATH) {
    options.onError?.(rt.webretroNotConfigured)
    return () => {}
  }

  const core = coreFor(options.platform)
  if (!core) {
    options.onError?.(fmt(rt.webretroUnsupportedPlatform, { platform: options.platform }))
    return () => {}
  }

  let destroyed = false
  /** 本地文件生成的 blob: 地址，销毁时要回收，否则整个 ROM 一直占着内存 */
  let objectUrl = ''

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.emulatorTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.setAttribute('allow', 'fullscreen; gamepad; autoplay; midi')

  /* ---------------- 就绪判定与加载进度 ---------------- */

  /**
   * ⚠️ iframe 的 load 事件**不是**「可以玩了」。
   *
   * 它只代表 index.html 这个文档解析完了；此时 webretro 才刚开始下核心 wasm
   * （melonDS 3MB）和资源包（bundle/，275 个文件共 6.7MB）。以前直接在这里调
   * onReady，播放器立刻把加载遮罩撤掉，玩家对着黑屏按半天，还以为模拟器坏了。
   *
   * 好在 webretro 是自托管的、跟主站同源，父窗口能直接读它内部的状态：
   *   window.wasmReady / bundleReady / biosReady —— 三个都为 true 就是资源齐了
   *   document.getElementById('loadingbar').value —— 资源包下载进度，0 → 1
   *   window.loadStatus —— 当前阶段的英文文案（我们不显示它，只用来判断阶段）
   * 所以这里改成轮询这几个值，齐了才 onReady。
   *
   * 跨源的情况也要兜住：万一有人把 VITE_WEBRETRO_PATH 指到别的域名，读
   * contentWindow 会抛 SecurityError，那就退回老行为（load 即就绪），
   * 至少不会让玩家永远卡在加载界面。
   */
  let srcSet = false
  let poll: ReturnType<typeof setInterval> | null = null
  let readySent = false

  const stopPoll = () => {
    if (poll) {
      clearInterval(poll)
      poll = null
    }
  }
  const sendReady = () => {
    stopPoll()
    if (readySent || destroyed) return
    readySent = true
    options.onReady?.()
  }

  /** 读一次 iframe 内部状态。返回 false 表示读不到（跨源），调用方据此降级 */
  const tick = (): boolean => {
    let win: (Window & Record<string, unknown>) | null
    let doc: Document | null
    try {
      win = iframe.contentWindow as (Window & Record<string, unknown>) | null
      doc = iframe.contentDocument
      // 真正会抛 SecurityError 的是这一下访问，不是上面的取属性
      void win?.location.href
    } catch {
      return false
    }
    if (!win || !doc) return true // 文档还没建好，下一轮再看

    const wasm = Boolean(win.wasmReady)
    const bundle = Boolean(win.bundleReady)
    const bios = Boolean(win.biosReady)

    if (wasm && bundle && bios) {
      options.onProgress?.({ phase: 'starting', ratio: 1 })
      sendReady()
      return true
    }

    // 资源包下载时 webretro 自己那根 <progress> 的 value 就是 0~1 的真实比例
    const bar = doc.getElementById('loadingbar') as HTMLProgressElement | null
    const barRatio = bar && bar.style.display !== 'none' && bar.value > 0 ? Math.min(bar.value, 1) : undefined

    options.onProgress?.(
      wasm
        ? { phase: 'assets', ratio: barRatio }
        : // wasm 还没好：核心是 <script> 标签拉的，没有进度可读，只报阶段
          { phase: 'engine' },
    )
    return true
  }

  iframe.addEventListener('load', () => {
    if (!srcSet || destroyed) return
    if (!tick()) {
      // 跨源，读不到内部状态 —— 退回老行为
      sendReady()
      return
    }
    stopPoll()
    poll = setInterval(() => {
      if (destroyed) return stopPoll()
      if (!tick()) sendReady()
    }, POLL_MS)
    // 兜底：资源真的下不动时（断网、bundle 404），别让玩家永远卡在遮罩后面。
    // 放行之后 webretro 自己的错误提示就能露出来，玩家至少看得见发生了什么。
    setTimeout(() => {
      if (!destroyed && !readySent) sendReady()
    }, READY_TIMEOUT_MS)
  })
  iframe.addEventListener('error', () => {
    if (!destroyed) options.onError?.(fmt(rt.webretroLoadFailed, { path: WEBRETRO_PATH }))
  })
  container.appendChild(iframe)

  const game = options.game
  let romUrl: string
  let romName: string
  if (typeof game === 'string') {
    romUrl = game
    romName = fileNameOf(game) || 'rom.nds'
  } else {
    objectUrl = URL.createObjectURL(game)
    romUrl = objectUrl
    romName = game.name || 'rom.nds'
  }

  srcSet = true
  options.onProgress?.({ phase: 'engine' })
  iframe.src = buildUrl(core, romUrl, romName)
  options.onStart?.()

  return () => {
    destroyed = true
    stopPoll()
    try {
      iframe.src = 'about:blank'
    } catch {
      /* ignore */
    }
    iframe.remove()
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = ''
    }
  }
}

export const webretroRuntime: Runtime = {
  id: 'webretro',
  name: 'webretro',
  get description() {
    return getT().runtime.webretroDesc
  },
  // .srl 是 NDS ROM 的另一种后缀（webretro 的 fileExts 里就这么写的）
  extensions: ['nds', 'srl', 'zip'],
  // 必须高于 EmulatorJS 的 5，才能在 NDS 上顶掉它；
  // 低于 jsdos(25) / ruffle(20) / jsnes(20)，不去碰它们的地盘（supports 也拦着）
  priority: 15,
  // 没装 / 没配置就当作不存在，NDS 会自动退回 EmulatorJS
  available: () => Boolean(WEBRETRO_PATH),
  supports: (platform) => Boolean(coreFor(platform)),
  engineLabel: (platform) => {
    const core = coreFor(platform)
    return core ? (CORE_LABELS[core] ?? core) : '—'
  },
  mount,
}
