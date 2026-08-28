/**
 * 运行时（模拟器引擎）抽象。
 *
 * 一个「运行时」负责把某类 ROM 跑起来。播放器只面向这个接口，不关心背后是谁：
 *   EmulatorJS  主机 / 掌机 / 街机 / DOS（RetroArch 核心）
 *   Ruffle      Flash (.swf)
 *   jsnes       NES (.nes)
 *   J2ME        Java 手机游戏 (.jar) —— 需自托管，见 adapters/j2me.ts
 *   js-dos      DOS 游戏 —— DOSBox 的浏览器移植，见 adapters/jsdos.ts
 *   webretro    任天堂 DS（melonDS）—— RetroArch 的 WASM 移植，需自托管，见 adapters/webretro.ts
 *   Cloud       云端联机：游戏跑在 cloud-game 服务器上，见 adapters/cloudgame.ts
 *
 * 联机有两条路：默认走 EmulatorJS 自带的 P2P netplay（房主的浏览器跑游戏，零服务器成本），
 * cloud-game 是另一条（游戏跑在服务器上，成本高，留给付费会员）。
 *
 * 新增一个引擎只要三步：
 *   1. 在 adapters/ 下实现 Runtime 接口
 *   2. 在 registry.ts 的 runtimes 里注册
 *   3.（可选）在 src/config/emulators.ts 里把某个扩展名指过去
 */
import type { PlatformId } from '@/types'
import type { CloudSession } from './adapters/cloudgame'
import type { NetplaySession } from './adapters/emulatorjs'
import type { LiveSession } from './adapters/liveview'

export type RuntimeId = 'emulatorjs' | 'ruffle' | 'jsnes' | 'j2me' | 'jsdos' | 'webretro' | 'cloudgame' | 'liveview'

export interface MountOptions {
  /** 平台 id（运行时据此选择核心等参数） */
  platform: PlatformId
  /** ROM：本地文件或可跨域访问的 URL */
  game: File | string
  /** 显示名（存档 / 截图命名用） */
  gameName: string
  /**
   * 模拟器核心覆盖。不传就用平台默认（src/data/platforms.ts 的 core）。
   *
   * 街机这类「一个平台底下其实是好几套硬件」的场景必须能按游戏覆盖：
   * 拳皇是 Neo Geo 走 fbneo，街霸 2 是 CPS2 走 fbalpha2012_cps2，
   * 更老的板子可能只有 mame2003_plus 跑得动 —— 一个平台默认值盖不住。
   */
  core?: string
  /**
   * BIOS 文件地址（平台级，见 services/platformBios.ts）。
   * Neo Geo 这类平台没有它引擎根本起不来，和 ROM 对不对无关。
   */
  biosUrl?: string
  /**
   * 游戏 slug —— 存档就是按它归档的。
   * 玩家自己上传的 ROM 没有 slug，调用方会给个 `local:文件名`（见 services/saves.ts）。
   * 不传就没有存档能力。
   */
  gameSlug?: string
  /**
   * P2P 联机会话（EmulatorJS netplay）：游戏在房主自己的浏览器里跑，
   * 画面经 WebRTC 直推给其他玩家，不经过服务器。这是默认的联机方案。
   */
  netplay?: NetplaySession
  /** 云端联机会话（cloudgame 运行时）：游戏由服务器运行，此时 game 字段被忽略 */
  cloud?: CloudSession
  /** DOS 联机（jsdos 运行时） */
  ipx?: IpxSession
  /**
   * 观看直播（liveview 运行时）：本机不跑游戏，只收主播推过来的画面和声音。
   * 此时 game 字段被忽略。
   */
  live?: LiveSession
  /**
   * 加载进度。
   *
   * onReady 之前会被调很多次，播放器据此画进度条。**只有拿得到真实字节数的引擎才报数**：
   * 适配器自己 fetch 的（jsnes / jsdos / ruffle 的远程 SWF）有 loaded/total；
   * EmulatorJS 的下载走它 iframe 里的 XHR，包一层同样拿得到；
   * webretro 同源，读它自己那根 <progress> 得到 ratio；其余的只报 phase，
   * ratio 为 undefined 表示「不知道还剩多少」，UI 转不确定态。
   */
  onProgress?: (progress: LoadProgress) => void
  /**
   * 资源齐了、这局可以真正开始玩了。
   *
   * ⚠️ 语义是「玩家可以动手了」，不是「iframe 的 document 加载完了」。
   * 播放器就是靠它把加载遮罩撤掉的，早调一步玩家就会对着黑屏乱按。
   */
  onReady?: () => void
  onStart?: () => void
  onError?: (message: string) => void
  /** 引擎加载完、拿到新能力时调用，播放器据此刷新工具栏 */
  onCaps?: (caps: Set<Capability>) => void
}

/**
 * DOS 联机（js-dos 的 IPX）。当年的 DOS 局域网游戏靠 IPX 协议互相通信，
 * js-dos 把它隧道化了，有两种拓扑：
 *   - 中继：所有人连同一台 IPX 服务器（server/src/ipx.js），穿透性最好，流量过服务器
 *   - P2P：一个人的浏览器当 IPX 服务器，其他人经 WebRTC 直连过去（需要一台撮合服务器）
 * 详见 adapters/jsdos.ts。
 */
export interface IpxSession {
  /** P2P：本机当 IPX 服务器，别人连过来 */
  host?: boolean
  /** P2P：要连的对方（peer id 或别名） */
  connectTo?: string
  /**
   * 显示 js-dos 自带的界面。
   * 中继模式必须打开 —— js-dos 没有对外暴露「连接到 IPX 服务器」的接口，
   * 只能由玩家自己在它的设置面板里填 Server 和 Room。
   */
  showUi?: boolean
}

/**
 * 加载阶段。播放器把它翻成给玩家看的一句话。
 *   engine —— 在下模拟器本体（wasm / 核心 / 运行时脚本）
 *   assets —— 在下引擎的配套资源（字体、着色器、手柄配置这类）
 *   rom    —— 在下这一款游戏本身
 *   starting —— 东西都齐了，引擎正在启动
 */
export type LoadPhase = 'engine' | 'assets' | 'rom' | 'starting'

export interface LoadProgress {
  phase: LoadPhase
  /** 0~1。拿不到总量时为 undefined —— UI 应转成不确定态，而不是显示 0% */
  ratio?: number
  /** 已下载字节数 */
  loaded?: number
  /** 总字节数。服务器没给 Content-Length、或响应被压缩过时没有 */
  total?: number
}

/** 解析运行时时能用到的线索 */
export interface ResolveContext {
  platform: PlatformId
  /** 文件扩展名，不带点、小写。来自本地文件名或云端 ROM 的 key */
  ext?: string
}

/** 运行时能提供的能力。播放器按这个集合决定显示哪些按钮 —— 支持才亮，不支持不显示 */
/**
 * 运行时能提供的能力。播放器按这个集合决定显示哪些按钮 —— 支持才亮，不支持不显示。
 *
 * 存档为什么是两种能力：
 *   saveState  内存快照 —— 精确到某一帧，随时能存能读，还能导出成文件（EmulatorJS / 云联机）
 *   fsSave     文件系统持久化 —— 存的是盘上被改过的文件，玩家得**先在游戏里存盘**，
 *              点了只是把这些改动固化下来，没有「某一帧」这个概念（js-dos）
 * 混在一起会误导玩家：他在关卡中间点存档，回来却退回上一个存盘点。
 */
export type Capability = 'pause' | 'saveState' | 'fsSave' | 'volume' | 'gamepad' | 'screenshot' | 'record'

/** 录制 / 截屏要用到的画面与声音来源，由各适配器提供 */
export interface CaptureSources {
  canvas?: HTMLCanvasElement | null
  stream?: MediaStream | null
  audioNode?: AudioNode | null
  audioContext?: AudioContext | null
}

/**
 * mount() 的返回值。
 *
 * 以前只返回一个销毁函数，引擎明明有暂停 / 存档 / 截屏的接口也传不到 UI。
 * 现在返回一个句柄：能力是异步就绪的（引擎要先加载），所以 caps 是可变集合，
 * 拿到新能力时调 MountOptions.onCaps 通知播放器重新渲染。
 */
export interface RuntimeHandle {
  destroy: () => void
  /** 当前可用的能力 */
  caps: Set<Capability>
  /** 暂停 / 继续 */
  setPaused?: (paused: boolean) => void
  /** 存档：返回一个可下载的文件；读档：吃回同样的文件 */
  /**
   * 'local'：saveState() 返回存档文件，由播放器下载到本地；
   * 'remote'：存档在服务器上（云联机），saveState() 只表示成功与否。
   */
  saveMode?: 'local' | 'remote'
  /** 存档文件的扩展名（默认 state）。Flash 导出的是一个 json 包，就写成 flashsave.json */
  saveExt?: string
  saveState?: () => Promise<Blob | null>
  /**
   * 文件系统式存档（DOS）：把盘上的改动固化下来，成功返回 true。
   * 没有可下载的文件，也没有对应的「读档」—— 下次进游戏时引擎会自动把改动装回去。
   */
  fsSave?: () => Promise<{ ok: boolean; where?: 'cloud' | 'local' }>
  /** 返回一句话时，工具栏用它代替默认的「读档完成」（比如 Flash 要说明游戏被重载了） */
  loadState?: (data: ArrayBuffer) => Promise<string | void>
  /** 音量 0~1 */
  /** 引擎当前音量（0~1），工具栏用它初始化滑块，避免显示 100% 实际却是 60% */
  volume?: number
  setVolume?: (volume: number) => void
  /** 截屏 */
  screenshot?: () => Promise<Blob | null>
  /** 录制用的画面 / 声音来源 */
  captureSources?: () => CaptureSources | null
  /**
   * 引擎自己打出来的最近若干行日志（错误 / 警告）。
   *
   * 街机 ROM 出问题时，「缺哪个文件、哪个 CRC 对不上」这句话只在引擎的 console 里，
   * 而它跑在 iframe 内部，外面拿不到。适配器把它接出来存在这儿，
   * 排查时在浏览器控制台里读得到，将来也可以做成界面上的「详细信息」。
   */
  engineLog?: () => string[]
}

export interface Runtime {
  id: RuntimeId
  /** 展示名 */
  name: string
  /** 一句话说明 */
  description: string

  /** 该运行时能跑的扩展名（不带点、小写）。用于「按格式选引擎」 */
  extensions: string[]
  /**
   * 多个引擎都能处理同一格式时，数字大的先被选中。
   * 例：.nes 既能给 EmulatorJS 也能给 jsnes，靠这个和 config/emulators.ts 的覆盖表决定。
   */
  priority: number

  /**
   * 引擎当前是否可用。
   * 需要自托管资源的引擎（如 J2ME）在没配置路径时返回 false，
   * 这样解析阶段就会跳过它，而不是等到挂载时才报错。
   */
  available: () => boolean

  /** 该运行时是否能跑这个平台 */
  supports: (platform: PlatformId) => boolean
  /** 该平台下用于显示的「核心 / 引擎」名 */
  engineLabel: (platform: PlatformId) => string
  /** 在容器内挂载并开始运行，返回控制句柄（含销毁函数与能力集合） */
  mount: (container: HTMLElement, options: MountOptions) => RuntimeHandle
}
