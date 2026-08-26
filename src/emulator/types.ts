/**
 * 运行时（模拟器引擎）抽象。
 *
 * 一个「运行时」负责把某类 ROM 跑起来。播放器只面向这个接口，不关心背后是谁：
 *   EmulatorJS  主机 / 掌机 / 街机 / DOS（RetroArch 核心）
 *   Ruffle      Flash (.swf)
 *   jsnes       NES (.nes)
 *   J2ME        Java 手机游戏 (.jar) —— 需自托管，见 adapters/j2me.ts
 *   Cloud       远程联机：游戏跑在 cloud-game 服务器上，见 adapters/cloudgame.ts
 *
 * 新增一个引擎只要三步：
 *   1. 在 adapters/ 下实现 Runtime 接口
 *   2. 在 registry.ts 的 runtimes 里注册
 *   3.（可选）在 src/config/emulators.ts 里把某个扩展名指过去
 */
import type { PlatformId } from '@/types'
import type { CloudSession } from './adapters/cloudgame'

export type RuntimeId = 'emulatorjs' | 'ruffle' | 'jsnes' | 'j2me' | 'cloudgame'

export interface MountOptions {
  /** 平台 id（运行时据此选择核心等参数） */
  platform: PlatformId
  /** ROM：本地文件或可跨域访问的 URL */
  game: File | string
  /** 显示名（存档 / 截图命名用） */
  gameName: string
  /** 联机会话（仅 cloudgame 运行时使用；游戏由服务器运行，此时 game 字段被忽略） */
  cloud?: CloudSession
  onReady?: () => void
  onStart?: () => void
  onError?: (message: string) => void
}

/** 解析运行时时能用到的线索 */
export interface ResolveContext {
  platform: PlatformId
  /** 文件扩展名，不带点、小写。来自本地文件名或云端 ROM 的 key */
  ext?: string
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
  /** 在容器内挂载并开始运行，返回销毁函数 */
  mount: (container: HTMLElement, options: MountOptions) => () => void
}
