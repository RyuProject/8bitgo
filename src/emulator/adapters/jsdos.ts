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
 * 资源默认从 /jsdos/ 加载（由 scripts/copy-jsdos.mjs 从 npm 包复制过来）。
 * 想换成官方 CDN 就设 VITE_JSDOS_PATH=https://v8.js-dos.com/latest/
 */
import type { Capability, CaptureSources, LoadProgress, MountOptions, PadButton, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import {
  buildDosboxConf,
  hideJsdosConfigForLayer,
  makeJsdosBundle,
  makeWindowsGameLayer,
  WINDOWS_GAME_ROOT,
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
import { windowsGuestStartupBudgetMs } from '../loadProgress'
import { scheduleWindowsLaunch, type WindowsLaunchCi } from '../windowsLaunch'

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
const audioCreated: Array<{ ctx: AudioContext; at: number }> = []
const audioOutOf = new WeakMap<BaseAudioContext, AudioNode>()
let audioTapInstalled = false

function installAudioTap() {
  if (audioTapInstalled || typeof window === 'undefined') return
  audioTapInstalled = true
  try {
    const Native = window.AudioContext
    if (typeof Native === 'function') {
      const Tapped = class extends Native {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args)
          audioCreated.push({ ctx: this, at: Date.now() })
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
    const { ctx, at } = audioCreated[i]
    if (at < since) break
    if (ctx.state === 'closed') continue
    const node = audioOutOf.get(ctx)
    if (node) return { audioNode: node, audioContext: ctx }
  }
  return null
}

export const JSDOS_PATH: string = (() => {
  const p = import.meta.env.VITE_JSDOS_PATH || '/jsdos/'
  return p.endsWith('/') ? p : `${p}/`
})()

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
}

/** js-dos 的底层接口，ci-ready 事件里给出来 */
interface DosCi extends WindowsLaunchCi {
  pause: () => void
  resume: () => void
  screenshot: () => Promise<ImageData>
  sendKeyEvent: (keyCode: number, pressed: boolean) => void
  exit: () => Promise<void>
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
 * 屏幕手柄（TouchPad）的八个键 → DOSBox 键码。
 *
 * 和上面 DOS_PAD_MAP 是同一套键位，只是索引不同（那份按 Gamepad API 的按钮下标，
 * 这份按我们自己的 PadButton 名字），所以两边改一处就得改另一处。
 * 手机上没有键盘，不给这一套的话 DOS 游戏在手机上纯属只能看 —— 连菜单都进不去。
 *
 * SELECT 给 Esc 而不是别的：DOS 游戏的暂停 / 退出菜单基本都在 Esc 上，
 * 手机玩家最容易卡住的地方就是「进了游戏出不来」。
 */
const DOS_TOUCH_MAP: Record<PadButton, number> = {
  up: KBD.up,
  down: KBD.down,
  left: KBD.left,
  right: KBD.right,
  a: KBD.leftCtrl,
  b: KBD.leftAlt,
  start: KBD.enter,
  select: KBD.esc,
}

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
): Promise<{ name: string; buf: ArrayBuffer }> {
  const loaded = await loadGameBytes(game, onProgress)
  return { name: loaded.name, buf: loaded.data }
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
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
  let volume = 1
  let paused = false
  /** onReady 的延时兜底定时器，销毁时要清掉 */
  let readyFallback = 0
  let readySent = false
  /** 存档按 slug 归档；见下面 fsChanges 那段的说明 */
  let saveKey = ''
  /** 最近一次存档落到哪儿了（云端 / 浏览器），给界面显示用 */
  let lastPush: { ok: boolean; where: 'cloud' | 'local' | null; error?: string } | null = null
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
      const Dos = await loadJsDos()
      options.onProgress?.({ phase: 'engine', ratio: 1 })
      const systemPromise = options.dosSystemUrl
        ? loadGameBytes(options.dosSystemUrl, (progress) => options.onProgress?.({ ...progress, phase: 'assets' }))
        : Promise.resolve(null)
      // 系统镜像通常远大于游戏 ZIP。以前三路并行时，小 ROM 会先把进度推到 80%，
      // 随后大半分钟都在等镜像，看起来像卡死。按界面约定分段：核心/镜像 0–40%，
      // 它们完成后才让游戏 ROM 进入 40–80%。少一点并行，换来可理解、不会骗人乱跳的进度。
      const loadedSystem = await systemPromise
      options.onProgress?.({ phase: 'assets', ratio: 1 })
      const rom = await readRom(options.game, options.onProgress)
      options.onProgress?.({ phase: 'starting' })
      if (destroyed) return
      // 高级配置属于 DOSBox-X；即使数据库里残留了错误字段，普通 DOSBox 也不能误吃进去。
      const dosboxConfig = options.dosBackend === 'dosboxX' ? options.dosboxConfig : undefined

      let primaryUrl = ''
      let guest: WindowsGuestConfig | null = null
      let guestLaunchCommand = ''
      let initFs: unknown[] | undefined
      if (loadedSystem) {
        if (!options.dosExecutable) throw new Error('Windows 客体游戏没有配置自启动 EXE')
        const systemConfig = await readWindowsSystemConfig(loadedSystem.data)
        guest = buildWindowsGuestConfig(systemConfig, dosboxConfig)
        const gameLayer = makeWindowsGameLayer(rom.buf, options.dosExecutable, guest.gameDrive)
        if (!gameLayer.executable) throw new Error('Windows 游戏层没有可启动的 EXE')
        if ((options.dosWindowsVersion ?? '9x') === '3x') {
          const slash = gameLayer.executable.lastIndexOf('/')
          const executableDir = slash >= 0 ? gameLayer.executable.slice(0, slash) : ''
          // File Manager 只需切到游戏盘根目录，因此让盘根直接对应 EXE 的父目录。
          const gameRoot = executableDir ? `${WINDOWS_GAME_ROOT}/${executableDir}` : WINDOWS_GAME_ROOT
          guest = buildWindowsGuestConfig(systemConfig, dosboxConfig, gameRoot)
        }
        guestLaunchCommand = windowsGuestLaunchCommand(
          guest,
          gameLayer.executable,
          options.dosWindowsVersion ?? '9x',
        )
        const gameLayerBytes = new Uint8Array(await gameLayer.blob.arrayBuffer())
        // 系统包自己的 conf 必须先改名：它作为后续文件层解开时会覆盖 Dos() 的直接配置。
        // 改名只动 ZIP 头里的 36 个 ASCII 字节，不复制那份近百 MB 的 qcow2 数据。
        const systemLayer = hideJsdosConfigForLayer(loadedSystem.data)
        // 最终配置再放一次到最后，未来 js-dos 即使调整直接配置与 initFs 的合并顺序也不会倒退。
        initFs = [systemLayer, gameLayerBytes, { dosboxConf: guest.dosboxConf, jsdosConf: { version: '8' } }]
      } else {
        // 普通 zip / exe 现场打成 bundle；已经是 bundle 的原样使用。
        // 后台指定了启动程序就按它生成 conf，压过 pickExecutable 的猜测。
        const bundle = await makeJsdosBundle(
          rom.name,
          rom.buf,
          options.dosExecutable ? buildDosboxConf(options.dosExecutable) : undefined,
          dosboxConfig,
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
        // 射击类需要相对位移并锁定鼠标；策略等游戏必须保留绝对坐标，否则点击会错位。
        mouseCapture: Boolean(options.mouseCapture),
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
        fsChanges: {
          local: true,
          urlToKey: async () => saveKey,
          pull: async () => (await pullSave('jsdos', saveKey))?.data ?? null,
          push: async (_key: string, data: Uint8Array) => {
            // 记下这次落到哪儿了，fsSave() 要拿它告诉玩家「存到云端」还是「存在浏览器里」。
            // 这个钩子被调到过本身就是「盘上真有改动」的唯一证据，fsSave() 也靠它判断。
            const r = await pushSave('jsdos', saveKey, data)
            lastPush = { ok: r.ok, where: r.where, error: r.cloudFailed ? r.error : undefined }
          },
          delete: async () => {
            await deleteSave('jsdos', saveKey)
          },
        },
        onEvent: (event: string, arg?: unknown) => {
          if (destroyed) return
          if (event === 'emu-ready') {
            // Windows 客体此时只代表模拟器壳已就绪，离系统开机和游戏启动还很远。
            if (!guest) markReady()
          }
          else if (event === 'bnd-play' || event === 'ci-ready') {
            if (event === 'ci-ready' && arg) {
              ci = arg as DosCi
              if (guest && !cancelWindowsLaunch) {
                cancelWindowsLaunch = scheduleWindowsLaunch(
                  ci,
                  guestLaunchCommand,
                  options.dosLaunchDelay ?? 24,
                  () => destroyed,
                  markReady,
                  options.dosWindowsVersion ?? '9x',
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
      if (props.save && saveKey && !guest) caps.add('fsSave')
      options.onCaps?.(caps)
      /**
       * 兜底：万一 kiosk 模式下不触发 emu-ready，也别让转圈一直转。
       *
       * ⚠️ 不能像原来那样在这里**立刻**调 —— Dos() 一返回 DOSBox 其实还在启动，
       * 立刻调的结果是播放器马上显示「运行中」、加载提示消失，玩家对着黑屏
       * 等好几秒还以为卡死了。改成延时兜底：正常情况下 emu-ready 早就先到了。
       */
      if (!guest) {
        readyFallback = window.setTimeout(markReady, 8000)
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
      options.onError?.(fmt(rt.jsdosLoadFailed, { msg: e instanceof Error ? e.message : String(e) }))
    }
  })()

  options.onCaps?.(caps)

  return {
    caps,
    volume,
    /**
     * 屏幕手柄按下 / 松开。播放器在触屏设备上画那一套浮层，按下就走这里
     * （声明了 'touchpad' 能力才画，见 types.ts 的 Capability）。
     *
     * 直接送 DOSBox 键码，不合成 KeyboardEvent —— js-dos 的键盘处理在它自己的
     * canvas 上，合成事件的 keyCode 在各浏览器上对不齐，而且会撞上页面别的监听。
     */
    sendButton(button, down) {
      const key = DOS_TOUCH_MAP[button]
      if (key === undefined) return
      try {
        ci?.sendKeyEvent(key, down)
      } catch {
        /* 引擎已经拆了就忽略 */
      }
    },
    destroy() {
      destroyed = true
      window.clearTimeout(readyFallback)
      cancelWindowsLaunch?.()
      cancelWindowsLaunch = null
      pad?.stop()
      pad = null
      try {
        void props?.stop()
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

        // 云端和浏览器都没写进去
        if (!done.ok) return { ok: false, reason: 'failed' as const, error: done.error }

        // 写进去了。error 有值 = 本地成了、云端没成（部分成功），要一并说出来
        return { ok: true, where: done.where ?? undefined, error: done.error }
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

export const jsdosRuntime: Runtime = {
  id: 'jsdos',
  name: 'js-dos',
  get description() {
    return getT().runtime.jsdosDesc
  },
  extensions: ['jsdos', 'zip', 'exe', 'com'],
  // 高于 EmulatorJS：DOS 这类文件优先交给它
  priority: 25,
  available: () => true,
  supports: (platform) => platform === 'dos',
  engineLabel: () => 'DOSBox',
  mount,
}
