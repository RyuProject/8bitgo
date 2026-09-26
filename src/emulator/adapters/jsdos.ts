/**
 * js-dos 运行时：DOS 游戏（GPL-2.0，自托管在 public/jsdos/）。
 *
 * 相比走 EmulatorJS 的 dosbox_pure 核心，js-dos 是 DOSBox 的原生浏览器移植：
 * 启动更快、DOS 兼容性更好（它本来就是干这个的），而且自带 IPX over WebRTC 的联机能力
 * —— 当年那批 DOS 局域网游戏（毁灭战士、毁灭公爵、魔兽争霸 2）真正能联机就靠它。
 *
 * ⚠️ js-dos 只认「带 .jsdos/dosbox.conf 的 zip」，普通 zip 丢进去是起不来的。
 * 所以本地文件会先经 lib/jsdosBundle.ts 现场重打一个包（不解压，只补一份配置）。
 *
 * 资源默认从 /jsdos/v<version>/ 加载（由 scripts/copy-jsdos.mjs 从 npm 包复制过来）。
 * 想换成官方 CDN 就设 VITE_JSDOS_PATH=https://v8.js-dos.com/latest/
 */
import type { Capability, CaptureSources, LoadProgress, MountOptions, PadButton, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import {
  hideJsdosConfigForLayer,
  makeJsdosBundle,
  makeWindowsGameLayer,
  mergeExtraFiles,
  WINDOWS_GAME_ROOT,
  type ExtraFile,
} from '@/lib/jsdosBundle'
import {
  buildWindowsGuestConfig,
  readWindowsSystemConfig,
  windowsGuestLaunchCommand,
  type WindowsGuestConfig,
} from '@/lib/windowsGuest'
import { imageDataToBlob } from '../recorder'
import { GP, startGamepadBridge, hasGamepadApi, type GamepadBridge } from '../gamepad'
import { deleteSave, pullSave, pushSave } from '@/services/saves'
import { loadGameBytes } from '../romLoader'
import { loadSystemBytes, systemSourcesFor } from '../systemSource'
import { armJspi } from '../jspiFlag'
import {
  DOS_PAD_BUTTONS,
  DOS_PAD_DEFAULT,
  dosPadCustomized,
  glfwKeyForPress,
  glfwKeyLabel,
  loadDosPadKeys,
  resetDosPadKeys,
  saveDosPadKeys,
  type DosPadKeys,
} from '../dosPad'
import { normalizeDosStartupCommands } from '../../../shared/dos-startup-commands.js'
import { fetchWithProgress, STARTING_MILESTONE, windowsGuestStartupBudgetMs } from '../loadProgress'
import { assertTypeable, scheduleWindowsLaunch, windows3xLaunchCommands, type WindowsLaunchCi } from '../windowsLaunch'
import { JSDOS_PATH } from '../paths'
import {
  DOS_MOUSE_SENSITIVITY_DEFAULT,
  needsLockedAbsoluteDosMouse,
  normalizeDosMouseSensitivity,
} from '../dosMouse'
import {
  advanceLockedAbsolutePointer,
  lockedAbsoluteContentRect,
  lockedAbsolutePointerAtClientPosition,
} from '../lockedAbsoluteMouse'

/** P2P 模式的撮合服务器。自建的话见 https://github.com/caiiiycuk/WebRTC-NET（Go） */
export const JSDOS_PEER_SERVER: string = import.meta.env.VITE_JSDOS_PEER_SERVER || 'https://net.dos.zone'

/** TURN / STUN 从自家后端拿（和 P2P 联机共用同一个接口） */
async function fetchIceServers(): Promise<RTCIceServer[]> {
  const base = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
  if (!base) return []
  try {
    const res = await fetch(`${base}/api/netplay/ice`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { iceServers?: RTCIceServer[] }
    return data.iceServers ?? []
  } catch {
    return []
  }
}

/* ---------------- 音频探针 ---------------- */

/**
 * 把 js-dos 的声音拿出来给直播 / 录像用。
 *
 * js-dos 没有对外暴露音频节点，但它的声音链在**主线程**上：
 * `new AudioContext({sampleRate})` → `createScriptProcessor` → `GainNode` → `destination`。
 * 所以在它建上下文之前，包一层 `AudioContext` 构造器记下新建的上下文，再包一层
 * `AudioNode.prototype.connect` 记下「最后一个接到 destination 的节点」—— 那就是它的总输出。
 * `captureSources()` 把这个节点和它的上下文交出去，broadcast.ts / recorder 那边会再接一个
 * `createMediaStreamDestination()`，不影响本机播放。
 *
 * 以前这里写的是「音频在 AudioWorklet 里，外面拿不到」—— 不对，`audioWorklet: true` 只是
 * 传给 worker 侧的开关，主线程的输出链一直都是 ScriptProcessor。结果 DOS 直播和录像一直是哑的。
 *
 * 只装一次、装在全局上（js-dos 跑在主页面，不在 iframe 里）。记录用 WeakMap，不拖住上下文。
 */
/**
 * ⚠️ 存 WeakRef，不是强引用。
 *
 * 这个 patch 一装就永不撤，而且装在全局上 —— 此后**页面上任何模块**
 * （EmulatorJS / J2ME / webretro / jsnes）new 出来的 AudioContext 都会被记进来。
 * 以前是强引用数组：被钉住的上下文没法回收，连带它整条音频图
 * （ScriptProcessorNode 及其 onaudioprocess 闭包里捕获的 js-dos 内部对象）一起活着，
 * `destroy()` 也带不走。上限 8 条不是无界泄漏，但代价是最多 8 份「已销毁会话的完整音频链」常驻，
 * 而且浏览器对每文档的 AudioContext 数量是有上限的，撞上了新的一局就没声音。
 * 文件头那句「记录用 WeakMap，不拖住上下文」以前只对 audioOutOf 成立。
 */
const audioCreated: Array<{ ref: WeakRef<AudioContext>; at: number }> = []
const audioOutOf = new WeakMap<BaseAudioContext, AudioNode>()
let audioTapInstalled = false

function installAudioTap() {
  if (audioTapInstalled || typeof window === 'undefined') return
  audioTapInstalled = true
  try {
    const Native = window.AudioContext
    // WeakRef 无法可靠 polyfill；旧 Safari 选择「游戏照常有声、只是直播抓不到 DOS 声音」，
    // 不能为了附加能力把 AudioContext 构造本身变成一次 ReferenceError。
    if (typeof Native === 'function' && typeof WeakRef === 'function') {
      const Tapped = class extends Native {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args)
          audioCreated.push({ ref: new WeakRef(this as AudioContext), at: Date.now() })
          // 只留最近几条：一局游戏就一个上下文，多的都是历史
          while (audioCreated.length > 8) audioCreated.shift()
        }
      }
      window.AudioContext = Tapped
    }
    const proto = AudioNode.prototype as unknown as { connect: (...a: unknown[]) => unknown }
    const nativeConnect = proto.connect
    proto.connect = function (this: AudioNode, ...args: unknown[]) {
      const dest = args[0]
      if (typeof AudioDestinationNode === 'function' && dest instanceof AudioDestinationNode) audioOutOf.set(this.context, this)
      return nativeConnect.apply(this, args)
    }
  } catch {
    // 装不上（老浏览器、被 CSP 冻结的原型）就算了：直播照常只是没声音，和以前一样
  }
}

/** 这一局 js-dos 建出来的声音链：挂载之后新建的、且有节点接到了 destination 的那个上下文 */
function findAudioOut(since: number): { audioNode: AudioNode; audioContext: AudioContext } | null {
  for (let i = audioCreated.length - 1; i >= 0; i--) {
    const { ref, at } = audioCreated[i]
    if (at < since) break
    const ctx = ref.deref()
    // 已经被回收了 —— 那它显然不是这一局正在响的那个
    if (!ctx || ctx.state === 'closed') continue
    const node = audioOutOf.get(ctx)
    if (node) return { audioNode: node, audioContext: ctx }
  }
  return null
}

type DosProps = {
  stop: () => Promise<void> | void
  /**
   * 把盘上的改动固化下来。js-dos v8 的 Player API。
   *
   * ⚠️ 返回值**不是**「存成功了没有」。看 js-dos 的实现：盘上一点改动都没有时
   * （persist() 返回 null），它只弹一句 no_changes_to_save 的提示，然后照样 return true，
   * 而 fsChanges.push 钩子压根不会被调用。只有它自己抛异常才返回 false。
   * 所以「到底存下来了没有」只能看 push 钩子有没有被调过 —— 见 fsSave()。
   */
  save?: () => Promise<boolean>
  setPaused?: (paused: boolean) => void
  setVolume?: (volume: number) => void
  setMouseSensitivity?: (sensitivity: number) => void
}

/** js-dos 的底层接口，ci-ready 事件里给出来 */
interface DosCi extends WindowsLaunchCi {
  pause: () => void
  resume: () => void
  width?: () => number
  height?: () => number
  screenshot: () => Promise<ImageData>
  sendKeyEvent: (keyCode: number, pressed: boolean) => void
  /** 相对鼠标位移（指针锁定 / 触屏拖动那一路）。js-dos 的界面层在事件发生时调它 */
  sendMouseRelativeMotion?: (x: number, y: number) => void
  /** 0～1 的绝对鼠标坐标；Windows 客体里的 DOSBox-X 集成鼠标驱动消费这一条。 */
  sendMouseMotion?: (x: number, y: number) => void
  exit: () => Promise<void>
}

/**
 * 「鼠标上下反转」按游戏记在浏览器里。
 *
 * 为什么按游戏而不是全局：Build 引擎那批 DOS 射击游戏（毁灭公爵 3D、影武者、血祭、Redneck
 * Rampage）出厂默认是飞行摇杆式 —— 鼠标前推 = 低头（DUKE3D.CFG 里 MouseAimingFlipped = 0），
 * 当年得进 SETUP.EXE 才能翻过来，网页里玩家进不了 SETUP；而雷神之锤默认就是正常方向，
 * 毁灭战士压根没有上下视角。一个全局开关会让玩家在两类游戏之间来回切。
 */
const MOUSE_INVERT_KEY = '8bitgo.dos.mouseInvertY'
const MOUSE_SENSITIVITY_KEY = '8bitgo.dos.mouseSensitivity'
const mouseInvertStore = {
  read(game: string): boolean {
    try {
      return localStorage.getItem(`${MOUSE_INVERT_KEY}:${game}`) === '1'
    } catch {
      return false
    }
  },
  write(game: string, on: boolean) {
    try {
      if (on) localStorage.setItem(`${MOUSE_INVERT_KEY}:${game}`, '1')
      else localStorage.removeItem(`${MOUSE_INVERT_KEY}:${game}`)
    } catch {
      /* 隐私模式 / 存储满了：这一局还是反转的，只是下次记不住 */
    }
  },
}

/**
 * js-dos 自带的灵敏度是全站共用 localStorage，而且 kiosk 模式下玩家看不到它的滑块。
 * 不同游戏自己的鼠标驱动 / 内置速度差异很大，因此另存一份逐游戏值，再显式传给引擎。
 */
const mouseSensitivityStore = {
  read(game: string): number {
    try {
      return normalizeDosMouseSensitivity(localStorage.getItem(`${MOUSE_SENSITIVITY_KEY}:${game}`))
    } catch {
      return DOS_MOUSE_SENSITIVITY_DEFAULT
    }
  },
  write(game: string, value: number) {
    try {
      localStorage.setItem(`${MOUSE_SENSITIVITY_KEY}:${game}`, String(normalizeDosMouseSensitivity(value)))
    } catch {
      /* 无痕模式 / 配额异常只影响记忆，当前这一局仍立即生效 */
    }
  },
}

/**
 * 把 js-dos 送进 DOSBox 的相对鼠标位移包一层，按需把上下取负。
 *
 * js-dos 8 的界面层是在每次指针事件里调 `ci.sendMouseRelativeMotion(dx, dy)`（dist 里看过，
 * dx/dy 直接来自 movementX/Y，没有任何取负），而且调的就是 ci-ready 交出来的这个对象 ——
 * 所以在实例上盖一个同名方法就够了，不用碰引擎。`inverted` 是现读的，切开关立刻生效。
 * 绝对坐标那条 `sendMouseMotion` 不碰：反了 Y 光标会镜像，菜单点不准。
 */
function hookMouseInvert(c: DosCi, inverted: () => boolean) {
  const raw = c.sendMouseRelativeMotion
  if (typeof raw !== 'function') return
  c.sendMouseRelativeMotion = (x, y) => raw.call(c, x, inverted() ? -y : y)
}

/**
 * Windows 客体与少数绝对坐标 DOS 游戏仍然要用 Pointer Lock（玩家点击画面后鼠标不能从边缘
 * 跑出去），但不能把锁定后的相对位移原样送给客体。Windows 的 `dboxmpi.drv` 只消费 0～1
 * 绝对位置；《主题医院》这类界面游戏切到相对包后，软件光标也不能正确跟随屏幕位置。
 *
 * 所以保留 js-dos 的点击捕获，只在 ci 边界把相对位移累积为绝对坐标。第一次点击先用落点校准，
 * Esc 释放后再次点击也会重新对齐。其余 DOS 不走这里，射击游戏仍拿原生相对位移。
 */
function hookLockedAbsoluteMouse(c: DosCi, host: HTMLElement, inverted: () => boolean): () => void {
  const rawRelative = c.sendMouseRelativeMotion
  const rawAbsolute = c.sendMouseMotion
  if (typeof rawRelative !== 'function' || typeof rawAbsolute !== 'function') {
    // 极老的 js-dos 没暴露绝对坐标接口时至少保留原行为；当前自托管版本两条接口都有。
    hookMouseInvert(c, inverted)
    return () => {}
  }

  let pointer = { x: 0.5, y: 0.5 }
  const canvasRect = () => {
    const canvas = host.querySelector('canvas')
    const rect = canvas?.getBoundingClientRect() ?? host.getBoundingClientRect()
    return lockedAbsoluteContentRect(rect, {
      width: c.width?.() ?? 0,
      height: c.height?.() ?? 0,
    })
  }
  const seedFromClick = (event: PointerEvent | MouseEvent) => {
    // 锁定后 clientX/Y 不再代表真实位置；每次点击都重置会让客体光标跳回锁定点。
    if (document.pointerLockElement) return
    const rect = canvasRect()
    pointer = lockedAbsolutePointerAtClientPosition(event.clientX, event.clientY, rect)
    rawAbsolute.call(c, pointer.x, pointer.y)
  }
  const startEvent = typeof PointerEvent === 'function' ? 'pointerdown' : 'mousedown'
  host.addEventListener(startEvent, seedFromClick as EventListener, true)

  c.sendMouseRelativeMotion = (x, y) => {
    const rect = canvasRect()
    pointer = advanceLockedAbsolutePointer(pointer, x, y, rect, inverted())
    rawAbsolute.call(c, pointer.x, pointer.y)
  }

  return () => {
    host.removeEventListener(startEvent, seedFromClick as EventListener, true)
    c.sendMouseRelativeMotion = rawRelative
  }
}

/**
 * DOSBox 的键码（js-dos 的 KBD_* 常量）。DOS 游戏没有统一的手柄标准，
 * 这里按「方向键 + Ctrl/Alt/空格/回车」这套最通用的键位映射，
 * 大部分 DOS 动作游戏（毁灭战士、波斯王子之类）默认键位都在里面。
 */
const KBD = {
  right: 262,
  left: 263,
  down: 264,
  up: 265,
  esc: 256,
  enter: 257,
  tab: 258,
  space: 32,
  leftShift: 340,
  leftCtrl: 341,
  leftAlt: 342,
} as const

const DOS_PAD_MAP: Record<number, number> = {
  [GP.UP]: KBD.up,
  [GP.DOWN]: KBD.down,
  [GP.LEFT]: KBD.left,
  [GP.RIGHT]: KBD.right,
  [GP.A]: KBD.leftCtrl,
  [GP.B]: KBD.leftAlt,
  [GP.X]: KBD.space,
  [GP.Y]: KBD.leftShift,
  [GP.START]: KBD.enter,
  [GP.SELECT]: KBD.esc,
  [GP.L1]: KBD.tab,
}
/**
 * 屏幕手柄（TouchPad）的键位**不在这里写死** —— 和 DOS_PAD_MAP 不同，它是可以改的
 * （主机模拟器的按钮是 A/B，DOS 的按钮是「键盘上的某个键」，每款游戏都不一样）。
 * 默认表、换算、以及按游戏存取都在 ../dosPad.ts，这里只负责读出来喂给引擎。
 */

type DosFn = (el: HTMLElement, options: Record<string, unknown>) => DosProps

/** js-dos 是全局脚本，整页只加载一次 */
let loading: Promise<DosFn> | null = null
function loadJsDos(): Promise<DosFn> {
  if (loading) return loading
  loading = new Promise<DosFn>((resolve, reject) => {
    const win = window as unknown as { Dos?: DosFn }
    if (win.Dos) return resolve(win.Dos)

    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = `${JSDOS_PATH}js-dos.css`
    document.head.appendChild(css)

    /*
      ⚠️ 必须在 <script> 插进去**之前**：js-dos 的 store 在模块求值时就把 jspi 开关
      从 localStorage 读死了，之后没有任何 Dos() 参数能改它。见 ../jspiFlag.ts。
    */
    // 这里还没选本局的后端；JSPI 只对 DOSBox-X 生效，不能把普通 DOS 局误报成 Windows 客体。
    armJspi()

    const script = document.createElement('script')
    script.src = `${JSDOS_PATH}js-dos.js`
    script.onload = () => (win.Dos ? resolve(win.Dos) : reject(new Error('js-dos 已加载但没有暴露 Dos()')))
    script.onerror = () => reject(new Error(`加载失败：${JSDOS_PATH}js-dos.js`))
    document.head.appendChild(script)
  }).catch((e) => {
    loading = null // 允许下次重试
    throw e
  })
  return loading
}

async function readRom(
  game: File | string,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<{ name: string; buf: ArrayBuffer }> {
  const loaded = await loadGameBytes(game, onProgress, signal)
  return { name: loaded.name, buf: loaded.data }
}

/**
 * 取回后台配的附加文件（资料片 / 补丁），见 lib/dosExtras.ts。
 *
 * ⚠️ 取不到就**抛错**，不静默跳过。这份清单是后台一条条配上去的：少一条要么是 key 填错
 * （永远不会自己好），要么这一局本来就跑不成预期的样子。静默继续的结果是玩家进游戏找不到
 * 资料片关卡，回来说「你们这个扩展包是假的」，而日志里干干净净什么都没有。
 * 真·网络抖动那一路本来也会先把游戏 ROM 本身打掉，不会单独卡在这里。
 *
 * 最多三路并行。资料片已不全是几 MB（有的接近 500MB），完全串行会把开局时间直接相加；
 * 全部一起开又会抢系统镜像的连接和内存。每条仍单独包装错误，所以后台能看到准确文件名。
 * 下载走共用的失速保护，避免一个永远不结束的 fetch 把加载遮罩永久钉住。
 */
async function loadExtras(
  list: readonly { url: string; path: string }[] | undefined,
  signal: AbortSignal,
): Promise<ExtraFile[]> {
  if (!list?.length) return []
  const out: ExtraFile[] = []
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= list.length) return
      const { url, path } = list[index]
      if (!url) throw new Error(`附加文件「${path}」没有可用地址（ROM 存储没配好？）`)
      let buf: ArrayBuffer
      try {
        buf = await fetchWithProgress(url, { signal, phase: 'assets' })
      } catch (e) {
        throw new Error(`附加文件「${path}」下载失败（${e instanceof Error ? e.message : String(e)}）`)
      }
      if (!buf.byteLength) throw new Error(`附加文件「${path}」是空的`)
      out[index] = { path, data: new Uint8Array(buf) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker))
  return out
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  // 必须先于 js-dos 建 AudioContext；它是在挂载之后的某个 effect 里建的，这里来得及
  installAudioTap()
  const mountedAt = Date.now()
  let destroyed = false
  let props: DosProps | null = null
  let ci: DosCi | null = null
  let pad: GamepadBridge | null = null
  const objectUrls: string[] = []
  let cancelWindowsLaunch: (() => void) | null = null
  let cancelMouseHook: (() => void) | null = null
  let volume = 1
  let paused = false
  /** onReady 的延时兜底定时器，销毁时要清掉 */
  let readyFallback = 0
  let readySent = false
  /** 玩家切走时把还在下的系统镜像 / ROM 掐掉：近百 MB 的镜像不该在后台继续吞流量、写缓存 */
  const abort = new AbortController()
  /** emu-ready 到过没有（引擎壳起来了）；ci-ready 才是 DOSBox 真的在跑 */
  let engineUp = false
  /** 存档按 slug 归档；见下面 fsChanges 那段的说明 */
  let saveKey = ''
  /** 鼠标上下反转（见 hookMouseInvert）。按游戏记忆，本地文件退回显示名 */
  const mouseKey = options.gameSlug || `local:${options.gameName}`
  let mouseInverted = options.mouseCapture ? mouseInvertStore.read(mouseKey) : false
  let mouseSensitivity = options.mouseCapture
    ? mouseSensitivityStore.read(mouseKey)
    : DOS_MOUSE_SENSITIVITY_DEFAULT
  /**
   * 屏幕手柄的键位，按游戏记（见 ../dosPad.ts）。归档键和鼠标反转共用同一个口径：
   * 「同一个游戏」的判定在两处不一致会让人莫名其妙（这里改了那儿没改）。
   * 读一次缓着用：sendButton 在按下那一刻被调用，不能每次都去碰 localStorage。
   */
  const padKey = options.gameSlug || `local:${options.gameName}`
  let padKeys: DosPadKeys = loadDosPadKeys(padKey)
  /** 最近一次存档落到哪儿了（云端 / 浏览器），给界面显示用 */
  let lastPush: { ok: boolean; where: 'cloud' | 'local' | null; error?: string } | null = null
  /** 最近一次固化出来的字节；导出成文件和「存不进去时退回下载」都用它 */
  let lastBytes: Uint8Array | null = null
  /**
   * 经函数读，别直接读变量。
   * 直接读的话 TypeScript 会顺着 `lastPush = null` 一路把类型收窄成 never ——
   * 它看不出中间那个 await 期间 push 回调把值改掉了。
   */
  const readLastPush = () => lastPush
  const markReady = () => {
    if (destroyed || readySent) return
    readySent = true
    window.clearTimeout(readyFallback)
    options.onReady?.()
  }

  const caps = new Set<Capability>(['pause', 'volume', 'screenshot', 'record'])
  if (hasGamepadApi()) caps.add('gamepad')

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;background:#000'
  container.appendChild(host)

  void (async () => {
    try {
      // js-dos 入口脚本由 loadJsDos() 用 <script> 拉，没有字节进度，只能先报核心阶段；
      // 系统镜像和 ROM 是我们自己 fetch 的，后两段都有真实进度。
      options.onProgress?.({ phase: 'engine' })
      let engineDone = false
      let systemDone = !options.dosSystemUrl
      let latestSystemProgress: LoadProgress | undefined
      let latestRomProgress: LoadProgress | undefined
      let concurrentFailure: unknown = null
      const settled = <T,>(promise: Promise<T>) => promise.then(
        (value) => ({ value, error: null as unknown }),
        (error: unknown) => {
          concurrentFailure ??= error
          // ROM / 资料片已经确定失败时，系统镜像继续下载没有任何价值；让错误立刻出现在界面上。
          if (!abort.signal.aborted) abort.abort(error)
          return { value: null as T | null, error }
        },
      )
      /*
        引擎脚本、系统镜像、游戏包和附加文件互不依赖，必须从同一刻开始取。
        以前虽然后三项并行，最前面仍先 await js-dos.js：弱网下核心 4 秒 + ROM 12 秒就是 16 秒，
        而不是两者较慢的 12 秒。普通 DOS 没有系统镜像，这段串行尤其显眼。

        ROM 的进度在引擎 / 系统镜像完成前先缓住，避免小 ROM 把界面推到 80% 后又长时间不动；
        两者完成后立刻补发最新一帧。这样总耗时取各路最大值，进度仍按核心→镜像→ROM 前进。
        settled 立即接住拒绝，防止某一路先失败、另一条还在下载时出现未处理的 Promise rejection。
      */
      const engineTask = loadJsDos()
      const romTask = settled(readRom(
        options.game,
        (progress) => {
          latestRomProgress = progress
          if (engineDone && systemDone) options.onProgress?.(progress)
        },
        abort.signal,
      ))
      const extrasTask = settled(loadExtras(options.dosExtras, abort.signal))
      /*
        系统镜像走**多源兜底**（见 ../systemSource）：主源是我们自己的资源域名，
        取不到或者卡死就换 js-dos 官方源。它是 Win9x/Win3.x 游戏的硬前提 ——
        拿不到就什么都做不了，而玩家看到的只是一个永远不动的进度条。
      */
      const systemTask = settled(options.dosSystemUrl
        ? loadSystemBytes(
            systemSourcesFor(options.dosSystemUrl),
            (progress) => {
              latestSystemProgress = { ...progress, phase: 'assets' }
              if (engineDone) options.onProgress?.(latestSystemProgress)
            },
            abort.signal,
          )
        : Promise.resolve(null))

      let Dos: DosFn
      try {
        Dos = await engineTask
      } catch (e) {
        // 核心脚本失败时把三路下载一起停掉；settled 会把它们的拒绝接住，避免控制台再冒未处理异常。
        abort.abort(e)
        await Promise.all([romTask, extrasTask, systemTask])
        throw e
      }
      engineDone = true
      options.onProgress?.({ phase: 'engine', ratio: 1 })
      if (latestSystemProgress) options.onProgress?.(latestSystemProgress)
      if (systemDone && latestRomProgress) options.onProgress?.(latestRomProgress)

      const systemResult = await systemTask
      // 并发资源先失败时，AbortError 只是连带结果；玩家真正需要的是最先发生的原始错误。
      if (systemResult.error) throw concurrentFailure ?? systemResult.error
      const loadedSystem = systemResult.value
      // 走了备用源就喊一声：这说明主源出问题了，而玩家那边是完全无感的
      if (loadedSystem?.usedFallback) {
        console.warn(`[jsdos] 主源取不到系统镜像，已改用${loadedSystem.label}`, loadedSystem.url)
      }
      systemDone = true
      options.onProgress?.({ phase: 'assets', ratio: 1 })
      if (latestRomProgress) options.onProgress?.(latestRomProgress)
      const romResult = await romTask
      if (romResult.error) throw romResult.error
      const rom = romResult.value!
      const extrasResult = await extrasTask
      if (extrasResult.error) throw extrasResult.error
      const extras = extrasResult.value ?? []
      options.onProgress?.({ phase: 'starting' })
      if (destroyed) return
      /*
        普通 DOS 和 DOSBox-X 都认识这些硬件 / 性能配置。以前只把覆盖项交给 DOSBox-X，
        导致普通 DOS 后台即使填了 cycles=max、memsize=32 或 ems=false 也会被静默丢掉。
      */
      const dosboxConfig = options.dosboxConfig

      let primaryUrl = ''
      let guest: WindowsGuestConfig | null = null
      let guestLaunchCommand = ''
      let initFs: unknown[] | undefined
      if (loadedSystem) {
        // Windows 客体仍需要一个完整的游戏层；这条路才做整包合并。
        const gameBuf = extras.length ? mergeExtraFiles(rom.buf, extras) : rom.buf
        if (!options.dosExecutable) throw new Error('Windows 客体游戏没有配置自启动 EXE')
        const systemConfig = await readWindowsSystemConfig(loadedSystem.data)
        guest = buildWindowsGuestConfig(systemConfig, dosboxConfig)
        const gameLayer = makeWindowsGameLayer(gameBuf, options.dosExecutable, guest.gameDrive)
        if (!gameLayer.executable) throw new Error('Windows 游戏层没有可启动的 EXE')
        if ((options.dosWindowsVersion ?? '9x') === '3x') {
          const slash = gameLayer.executable.lastIndexOf('/')
          const executableDir = slash >= 0 ? gameLayer.executable.slice(0, slash) : ''
          /*
            File Manager 只需切到游戏盘根目录，因此让盘根直接对应 EXE 的父目录。
            ⚠️ 但只在**包里所有东西都在那一层**时才这么干（gameLayer.singleDir）。
            EXE 在子目录、而数据在别处的包（`BIN/GAME.EXE` + `DATA/`，Win3.x 商业包里很常见）
            一旦收窄，客体的 D:\ 就只等于那一个子目录 —— 兄弟目录和根上的 .INI **整个不存在**，
            游戏能启动然后立刻报「找不到数据文件」。那种情况宁可让盘根留在游戏根上：
            工作目录不对最多是部分游戏读不到相对路径，文件不存在则是必然打不开。
          */
          const gameRoot =
            executableDir && gameLayer.singleDir ? `${WINDOWS_GAME_ROOT}/${executableDir}` : WINDOWS_GAME_ROOT
          guest = buildWindowsGuestConfig(systemConfig, dosboxConfig, gameRoot)
        }
        guestLaunchCommand = windowsGuestLaunchCommand(
          guest,
          gameLayer.executable,
          options.dosWindowsVersion ?? '9x',
          // 盘根没收窄的话，得把子目录也敲进 File > Run，否则在盘根上找不到那个 EXE
          gameLayer.singleDir !== false,
        )
        // 现在就验：以前这两处是在 ci-ready 的回调 / 定时器里才抛，没人接得住，
        // Windows 在屏幕上跑着、遮罩却盖到四分钟超时才报一句不相干的话
        assertTypeable(guestLaunchCommand)
        if ((options.dosWindowsVersion ?? '9x') === '3x') windows3xLaunchCommands(guestLaunchCommand)
        const gameLayerBytes = gameLayer.bytes
        /*
          系统包自己的 conf 必须先改名：它作为后续文件层解开时会覆盖 Dos() 的直接配置。
          改名只动 ZIP 头里的 36 个 ASCII 字节，不复制那一大块 qcow2 数据。

          ⚠️ 走网络来的那份**必须先复制**。hideJsdosConfigForLayer 是原地改字节的
          （把 `.jsdos/dosbox.conf` 改成同样长度的备份名），而 loadSystemBytes 拿到字节之后
          会**不 await 地**往 IndexedDB 写同一块 ArrayBuffer —— 不复制的话存进缓存的就是
          改过名的那份，下次命中直接找不到 conf，客体永远起不来，而且缓存不清不会自愈。

          这一行 09-11 上午被删过一次：当时系统镜像的地址没有 `?romv=`，romCacheKey 恒返回
          空串，那份缓存从来没生效过，于是这个 slice 每次都在白白复制一整个镜像。
          当天下午给系统镜像补上 ETag 缓存（见 systemSource.ts 的 systemCacheUrl）之后，
          前提重新成立，所以又加了回来。缓存命中的那份是 IndexedDB 新给的副本，不用再复制。
        */
        const systemLayer = hideJsdosConfigForLayer(
          loadedSystem.fromCache ? loadedSystem.data : loadedSystem.data.slice(0),
        )
        // 最终配置再放一次到最后，未来 js-dos 即使调整直接配置与 initFs 的合并顺序也不会倒退。
        initFs = [systemLayer, gameLayerBytes, { dosboxConf: guest.dosboxConf, jsdosConf: { version: '8' } }]
      } else {
        // 普通 zip / exe 现场打成 bundle；已经是 bundle 的原样使用。
        // 后台指定了启动程序就按它生成 conf，压过 pickExecutable 的猜测。
        const startupCommands = normalizeDosStartupCommands(options.dosStartupCommands)
        const bundle = await makeJsdosBundle(
          rom.name,
          rom.buf,
          undefined,
          dosboxConfig,
          options.dosExecutable,
          startupCommands,
          // 直接并进最终 bundle，避免「整包复制一次 → 再解析并重打」的双倍峰值内存。
          extras,
        )
        primaryUrl = URL.createObjectURL(bundle.blob)
        objectUrls.push(primaryUrl)
      }

      /**
       * 存档的归档键。
       *
       * ⚠️ 这一步是必须的：js-dos 默认拿 `url + '.changes'` 当键，而我们传进去的 url 是
       * blob URL —— 每次进游戏都重新生成一个。用默认键的话每局都是全新存档，
       * 存了也永远读不回来。所以这里换成稳定的 slug（本地文件退回文件名）。
       */
      saveKey = options.gameSlug || `local:${rom.name}`
      if (destroyed) {
        for (const url of objectUrls) URL.revokeObjectURL(url)
        return
      }

      const ipx = options.ipx
      props = Dos(host, {
        ...(guest
          ? { dosboxConf: guest.dosboxConf, jsdosConf: { version: '8' }, initFs }
          : { url: primaryUrl }),
        // 自托管的 wasm / worker 都在这个目录下
        pathPrefix: `${JSDOS_PATH}emulators/`,
        // Windows 3.x / 9x 仍是装在磁盘镜像里的客体系统；这里切的是能启动该镜像的 DOSBox-X 核心。
        // 新模式把系统 bundle 与游戏 ZIP 分开叠加；没配系统 bundle 时仍兼容旧的完整 .jsdos 包。
        backend: guest || options.dosBackend === 'dosboxX' ? 'dosboxX' : 'dosbox',
        // 播放器外壳是我们自己的，平时隐藏 js-dos 那套 UI；
        // 中继联机时必须放出来，玩家要在它的设置面板里填 IPX 服务器和房间
        kiosk: !ipx?.showUi,
        autoStart: true,
        // 桌面端 DOS 统一用客体自己的光标：点击画面锁定，Esc 释放，系统指针不会跑出窗口。
        mouseCapture: Boolean(options.mouseCapture),
        // 0.5 = 1×。逐游戏保存，避免一款老游戏的高灵敏度把下一款也带偏。
        mouseSensitivity,
        // DOS 游戏会自己绘制软件光标。系统光标叠在上面会出现两只不同步的鼠标。
        noCursor: true,
        // P2P 联机：一方开服，另一方按 peer id 连过去
        startIpxServer: Boolean(ipx?.host),
        connectIpxAddress: ipx?.connectTo ?? null,
        net: {
          peerServer: JSDOS_PEER_SERVER,
          // 打不通洞时要走中继，凭据由我们后端签发
          iceServers: fetchIceServers,
        },
        imageRendering: 'pixelated',
        // Windows 开机最耗时；第一次键盘输入会自动退出倍速，所以不会把游戏本体也加速。
        ...(guest ? { fastForwardOnBoot: 5 } : {}),
        /**
         * 存档。js-dos 存的是**文件系统的变更包**（盘上被改过的文件），
         * 不是内存快照 —— 玩家必须先在游戏里存盘，点存档只是把这些改动固化下来。
         *
         * 三个钩子指向 services/saves.ts：登录了进云端跟着账号走，
         * 没登录就落在浏览器里。pull 会在开机时被自动调用，所以读档是无感的。
         */
        /*
          ⚠️ Windows 客体这条路**不接** fsChanges。
          下面 caps 那里早就写明「qcow2 系统镜像的扇区变化不是普通 js-dos 文件层存档，
          上游也明确把这种包标成不可保存」，所以 guest 拿不到 fsSave 能力。
          可 pull 那一路一直接着 —— 开机时 js-dos 会自动调它，把这款游戏当年按普通 DOS
          配置上线时留下的**文件层变更包**叠到客体盘上：轻则无害，重则遮住系统/游戏文件
          让客体起不来，而玩家连一个能删掉它的入口都没有，只能一直撞。
        */
        ...(guest
          ? {}
          : {
              fsChanges: {
                local: true,
                urlToKey: async () => saveKey,
                /*
                  ⚠️ 三个钩子都必须**自己吞掉异常**。
                  它们的拒绝会顺着 js-dos 的包层变成 bnd-error → onError，而那时 ready 早已为真
                  （玩家正在玩），播放器收到 onError 就是拆会话、进度全丢 —— 玩家只是想存个档。
                  存档失败该走的是 fsSave() 里那套「提示一句、不动会话」的分支。
                */
                pull: async () => {
                  try {
                    return (await pullSave('jsdos', saveKey))?.data ?? null
                  } catch (e) {
                    console.warn('[jsdos] 读取存档失败，按没有存档处理', e)
                    return null
                  }
                },
                push: async (_key: string, data: Uint8Array) => {
                  // 记下这次落到哪儿了，fsSave() 要拿它告诉玩家「存到云端」还是「存在浏览器里」。
                  // 这个钩子被调到过本身就是「盘上真有改动」的唯一证据，fsSave() 也靠它判断。
                  /*
                    ⚠️ 字节要**先留一份**，而且和存储成功与否无关。
                    两边都写不进去（无痕模式、超配额、令牌过期）时，这一包就是玩家进度
                    在这个世界上唯一的副本 —— 工具栏拿它退回「下载成文件」。
                    以前这里失败就只剩一句「存档失败」，字节当场丢掉。
                  */
                  lastBytes = new Uint8Array(data)
                  try {
                    const r = await pushSave('jsdos', saveKey, data)
                    lastPush = { ok: r.ok, where: r.where, error: r.cloudFailed ? r.error : undefined }
                  } catch (e) {
                    lastPush = { ok: false, where: null, error: e instanceof Error ? e.message : String(e) }
                  }
                },
                delete: async () => {
                  try {
                    await deleteSave('jsdos', saveKey)
                  } catch (e) {
                    console.warn('[jsdos] 删除存档失败', e)
                  }
                },
              },
            }),
        onEvent: (event: string, arg?: unknown) => {
          if (destroyed) return
          if (event === 'emu-ready') {
            // 只是模拟器壳起来了：包还没解、DOSBox 还没跑。以前这里就 markReady，第二局起
            // js-dos 已经在内存里，emu-ready 在 Dos() 里同步就到 —— 遮罩当场撤掉，玩家对着黑屏
            // 等大包解压；之后包加载失败的 onError 也落在 ready 之后，直接拆会话而不是自动重试
            engineUp = true
          }
          else if (event === 'bnd-play' || event === 'ci-ready') {
            if (event === 'ci-ready' && arg) {
              ci = arg as DosCi
              /*
                进度条的第一个真实里程碑。
                ci-ready = DOSBox-X 的命令接口建好了，也就是 qcow2 挂载 / 建盘那一段
                （冷启动实测 ~72 秒，整条链上最慢的一段）已经过去了。
                在此之前 80% 之后没有任何真实信号，条子全靠计时器瞎爬。

                ⚠️ 只有客体那条路报。普通 DOS 游戏 ci-ready 的下一句就是 markReady，
                报了不但没用，还会把播放器切进「按里程碑分段」的模式 ——
                而那套分段的前提是后面还有 desktop / launched 两个里程碑会来，
                普通 DOS 一个都不会来。
              */
              if (guest) options.onProgress?.({ phase: 'starting', startup: STARTING_MILESTONE.ci })
              // Windows 客体和已确认的绝对坐标 DOS 游戏先还原绝对位置；FPS 等仍保留无限相对位移。
              if (options.mouseCapture) {
                cancelMouseHook?.()
                cancelMouseHook = guest || needsLockedAbsoluteDosMouse(options.gameSlug)
                  ? hookLockedAbsoluteMouse(ci, host, () => mouseInverted)
                  : (hookMouseInvert(ci, () => mouseInverted), null)
              }
              // DOSBox 真的在跑、命令接口也有了，这才是「玩家可以动手」。Windows 客体另算（等自启动）
              if (!guest) markReady()
              if (guest && !cancelWindowsLaunch) {
                cancelWindowsLaunch = scheduleWindowsLaunch(
                  ci,
                  guestLaunchCommand,
                  options.dosLaunchDelay ?? 24,
                  () => destroyed,
                  markReady,
                  options.dosWindowsVersion ?? '9x',
                  // 确认不了「客体里有反应」。这一定发生在 markReady 之前，
                  // 所以播放器还能自动重试一次；以前这条链根本没有失败出口
                  (msg) => {
                    if (!destroyed && !readySent) options.onError?.(fmt(rt.jsdosRunFailed, { msg }))
                  },
                  // 另外两个里程碑：桌面画完了 / 启动命令敲完了。只推进度条，不参与成败判定
                  (step) => {
                    if (destroyed) return
                    options.onProgress?.({
                      phase: 'starting',
                      startup: step === 'desktop' ? STARTING_MILESTONE.desktop : STARTING_MILESTONE.launched,
                    })
                  },
                )
              }
              // DOS 游戏只认键盘，手柄在这里翻译成按键
              if (caps.has('gamepad') && !pad) {
                pad = startGamepadBridge(DOS_PAD_MAP, (key, pressed) => ci?.sendKeyEvent(key, pressed))
              }
              // 屏幕手柄同理 —— 有了 ci 才有地方送键，所以能力等到这一刻才声明
              caps.add('touchpad')
              options.onCaps?.(caps)
            }
            options.onStart?.()
          }
          else if (event === 'emu-error' || event === 'bnd-error') {
            options.onError?.(fmt(rt.jsdosRunFailed, { msg: String(arg ?? '') }))
          }
        },
      }) as DosProps
      // 挂载前玩家可能已经调过音量/暂停，补一次
      props.setVolume?.(volume)
      if (paused) props.setPaused?.(true)
      // 存档要等 js-dos 起来才有 props.save()，所以能力在这里才补上
      // qcow2 系统镜像的扇区变化不是普通 js-dos 文件层存档；上游也明确把这种包标成不可保存。
      if (props.save && saveKey && !guest) {
        caps.add('fsSave')
        // 导出/导入是 fsSave 的兜底，条件完全一样
        caps.add('fsFile')
      }
      options.onCaps?.(caps)
      /**
       * 兜底：万一 kiosk 模式下不触发 emu-ready，也别让转圈一直转。
       *
       * ⚠️ 不能像原来那样在这里**立刻**调 —— Dos() 一返回 DOSBox 其实还在启动，
       * 立刻调的结果是播放器马上显示「运行中」、加载提示消失，玩家对着黑屏
       * 等好几秒还以为卡死了。改成延时兜底：正常情况下 emu-ready 早就先到了。
       */
      if (!guest) {
        readyFallback = window.setTimeout(() => {
          if (readySent) return
          // 引擎壳起来了只是 ci-ready 没等到（老版本 / 事件漏了）：按老规矩放行。
          // 连壳都没起来（wasm 没下到、包 404），以前也 markReady —— 播放器显示「运行中」，
          // 画面是 kiosk 模式下什么都不显示的黑屏；现在报错，让它走自动重试那条路
          if (engineUp || ci) markReady()
          else options.onError?.(fmt(rt.jsdosRunFailed, { msg: 'DOSBox did not start' }))
        }, 8000)
      } else {
        // CI 创建期间 js-dos 要在 WASM 内挂载近百 MB 的 qcow2；旧的 45 秒宽限会让慢设备
        // 在即将成功前被误判。真实引擎错误仍会立即走 emu-error，这里只拦真正的长时间失联。
        const timeoutMs = windowsGuestStartupBudgetMs(options.dosLaunchDelay)
        readyFallback = window.setTimeout(() => {
          if (!readySent) {
            options.onError?.(fmt(rt.jsdosRunFailed, { msg: 'Windows 客体初始化超时，未能执行自启动程序' }))
          }
        }, timeoutMs)
      }
    } catch (e) {
      if (destroyed) return
      // 任一路失败后，其余并发下载已经没有用途；立即停掉，避免错误页背后继续吞几十 MB。
      abort.abort(e)
      options.onError?.(fmt(rt.jsdosLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
    }
  })()

  options.onCaps?.(caps)

  return {
    caps,
    volume,
    /** 鼠标上下当前反转了没有。写成 getter：工具栏读到的永远是现值，不是挂载时的快照 */
    get mouseInverted() {
      return mouseInverted
    },
    get mouseSensitivity() {
      return mouseSensitivity
    },
    // 只有相对鼠标会话才提供速度 / 反转设置；触屏端引擎会自行降级，不请求 Pointer Lock。
    ...(options.mouseCapture
      ? {
          setMouseInvert(on: boolean) {
            mouseInverted = on
            mouseInvertStore.write(mouseKey, on)
          },
          setMouseSensitivity(value: number) {
            mouseSensitivity = normalizeDosMouseSensitivity(value)
            mouseSensitivityStore.write(mouseKey, mouseSensitivity)
            props?.setMouseSensitivity?.(mouseSensitivity)
          },
        }
      : {}),
    /**
     * 屏幕手柄按下 / 松开。播放器在触屏设备上画那一套浮层，按下就走这里
     * （声明了 'touchpad' 能力才画，见 types.ts 的 Capability）。
     *
     * 送的是**玩家自己绑的键**（没绑过就是默认那套，见 ../dosPad.ts）。
     * 直接送 GLFW 键码，不合成 KeyboardEvent —— js-dos 的键盘处理在它自己的
     * canvas 上，合成事件的 keyCode 在各浏览器上对不齐，而且会撞上页面别的监听。
     */
    sendButton(button, down) {
      const key = padKeys[button]
      if (key === undefined) return
      try {
        ci?.sendKeyEvent(key, down)
      } catch {
        /* 引擎已经拆了就忽略 */
      }
    },
    /**
     * 屏幕手柄的键位可以改（见 ../dosPad.ts）。
     *
     * 换算和存储都留在这一侧：键码是 js-dos 的 GLFW 编号，播放器不该认识它。
     * 播放器只交换两样东西 —— 「这颗按钮现在显示什么」和「玩家刚按了哪个键」。
     */
    padRemap: {
      labels() {
        const out = {} as Record<PadButton, string>
        for (const b of DOS_PAD_BUTTONS) out[b] = glfwKeyLabel(padKeys[b])
        return out
      },
      preview(press) {
        const key = glfwKeyForPress(press)
        return key === null ? null : glfwKeyLabel(key)
      },
      bind(button, press) {
        const key = glfwKeyForPress(press)
        if (key === null) return
        padKeys = { ...padKeys, [button]: key }
        saveDosPadKeys(padKey, padKeys)
      },
      reset() {
        padKeys = { ...DOS_PAD_DEFAULT }
        resetDosPadKeys(padKey)
      },
      customized: () => dosPadCustomized(padKey),
    },
    destroy() {
      destroyed = true
      window.clearTimeout(readyFallback)
      abort.abort()
      try {
        if (document.pointerLockElement && host.contains(document.pointerLockElement)) document.exitPointerLock()
      } catch {
        /* 页面正在切换或浏览器不支持时不用再补救 */
      }
      cancelWindowsLaunch?.()
      cancelWindowsLaunch = null
      cancelMouseHook?.()
      cancelMouseHook = null
      pad?.stop()
      pad = null
      try {
        // stop() 返回 Promise，同步的 try/catch 接不住它的 reject
        Promise.resolve(props?.stop()).catch(() => {})
      } catch {
        /* 已经停了就忽略 */
      }
      props = null
      ci = null
      for (const url of objectUrls) URL.revokeObjectURL(url)
      host.remove()
    },
    setPaused(next: boolean) {
      paused = next
      // 优先用 js-dos 自己的暂停（会连带停掉声音和渲染），拿不到就退回底层接口
      if (props?.setPaused) props.setPaused(next)
      else if (next) ci?.pause()
      else ci?.resume()
    },
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      props?.setVolume?.(volume)
    },
    /**
     * 「保存进度」：让 js-dos 把盘上的改动写出去，走上面 fsChanges.push 那条路。
     * 注意这不是即时存档 —— 玩家得先在游戏里用它自己的存档功能存过盘，这里才有东西可存。
     */
    /**
     * 导出成文件：先固化一次（拿到最新的盘面），再把那一包交出去。
     *
     * ⚠️ **存储失败也照样给文件** —— 兜底的全部意义就在这儿。
     */
    async fsExport() {
      const r = await this.fsSave!()
      const bytes = r.bytes ?? lastBytes
      if (!bytes || bytes.length === 0) {
        return { ok: false, reason: (r.reason ?? 'nothing') as 'nothing' | 'failed', error: r.error }
      }
      return { ok: true, blob: new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), error: r.error }
    },

    /**
     * 从文件导入：写进存储。
     *
     * ⚠️ **不会立刻生效**：js-dos 只在开机时调一次 fsChanges.pull。
     * 所以这里只负责把它放对地方，「要重开这一局」那句话由工具栏去说。
     */
    async fsImport(data: Uint8Array) {
      if (!saveKey) return { ok: false, error: 'no-slug' }
      if (!data || data.length === 0) return { ok: false, error: 'empty' }
      try {
        const r = await pushSave('jsdos', saveKey, data)
        return { ok: r.ok, where: r.where ?? undefined, error: r.cloudFailed ? r.error : undefined }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async fsSave() {
      if (!props?.save) return { ok: false, reason: 'failed' as const }
      try {
        lastPush = null
        const ok = await props.save()
        // false 只在 js-dos 内部抛异常、或者压根不能存（canSave=false）时出现
        if (!ok) return { ok: false, reason: 'failed' as const }

        const done = readLastPush()
        /**
         * push 钩子没被调过 = 盘上没有新写出的文件 = 玩家还没在游戏里存盘。
         *
         * ⚠️ 这里以前是 `done?.ok ?? true` —— 于是「什么都没存」被当成成功，
         * 界面回一句「已存到云端 · 换台设备也能接着玩」。玩家没存盘却以为存住了,
         * 而代码里为这个场景专门写的「请先在游戏里存盘 + 第①步标红」永远不会出现。
         */
        if (!done) return { ok: false, reason: 'nothing' as const }

        // 云端和浏览器都没写进去 —— 把字节交出去，工具栏会退回「下载成文件」
        if (!done.ok) return { ok: false, reason: 'failed' as const, error: done.error, bytes: lastBytes ?? undefined }

        // 写进去了。error 有值 = 本地成了、云端没成（部分成功），要一并说出来
        return { ok: true, where: done.where ?? undefined, error: done.error, bytes: lastBytes ?? undefined }
      } catch {
        return { ok: false, reason: 'failed' as const }
      }
    },
    async screenshot() {
      // js-dos 走 WebGL，直接读画布是空白的，得用它自己的截图接口
      if (!ci) return null
      try {
        return await imageDataToBlob(await ci.screenshot())
      } catch {
        return null
      }
    },
    captureSources(): CaptureSources | null {
      const canvas = host.querySelector('canvas')
      if (!canvas) return null
      // 声音走上面的探针（见 installAudioTap）。探针没抓到就只有画面，和以前一样
      const audio = findAudioOut(mountedAt)
      return audio ? { canvas, ...audio } : { canvas }
    },
  }
}
