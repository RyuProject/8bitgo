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

export type RuntimeId = 'emulatorjs' | 'ruffle' | 'jsnes' | 'j2me' | 'jsdos' | 'webretro' | 'cloudgame'

export interface MountOptions {
  /** 平台 id（运行时据此选择核心等参数） */
  platform: PlatformId
  /** ROM：本地文件或可跨域访问的 URL */
  game: File | string
  /** 显示名（存档 / 截图命名用） */
  gameName: string
  /**
   * P2P 联机会话（EmulatorJS netplay）：游戏在房主自己的浏览器里跑，
   * 画面经 WebRTC 直推给其他玩家，不经过服务器。这是默认的联机方案。
   */
  netplay?: NetplaySession
  /** 云端联机会话（cloudgame 运行时）：游戏由服务器运行，此时 game 字段被忽略 */
  cloud?: CloudSession
  /** DOS 联机（jsdos 运行时） */
  ipx?: IpxSession
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

/** 解析运行时时能用到的线索 */
export interface ResolveContext {
  platform: PlatformId
  /** 文件扩展名，不带点、小写。来自本地文件名或云端 ROM 的 key */
  ext?: string
}

/** 运行时能提供的能力。播放器按这个集合决定显示哪些按钮 —— 支持才亮，不支持不显示 */
export type Capability = 'pause' | 'saveState' | 'volume' | 'gamepad' | 'screenshot' | 'record'

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
