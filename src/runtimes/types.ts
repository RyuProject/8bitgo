/**
 * 运行时（模拟器）抽象。
 *
 * 一个「运行时」负责把某类 ROM 跑起来：EmulatorJS 跑主机 / 掌机 / 街机 / DOS，
 * Ruffle 跑 Flash。每个运行时实现同一个接口，播放器组件不关心具体是谁。
 * 新增运行时只需：实现 Runtime 接口 → 在 registry.ts 注册 → 在 platforms.ts 把平台指向它。
 */
import type { PlatformId } from '@/types'

export type RuntimeId = 'emulatorjs' | 'ruffle'

export interface MountOptions {
  /** 平台 id（运行时据此选择核心等参数） */
  platform: PlatformId
  /** ROM：本地文件或可跨域访问的 URL */
  game: File | string
  /** 显示名（存档 / 截图命名用） */
  gameName: string
  onReady?: () => void
  onStart?: () => void
  onError?: (message: string) => void
}

export interface Runtime {
  id: RuntimeId
  /** 展示名 */
  name: string
  /** 一句话说明 */
  description: string
  /** 该运行时是否能跑这个平台 */
  supports: (platform: PlatformId) => boolean
  /** 该平台下用于显示的「核心 / 引擎」名，例如 EmulatorJS 的 core */
  engineLabel: (platform: PlatformId) => string
  /** 在容器内挂载并开始运行，返回销毁函数 */
  mount: (container: HTMLElement, options: MountOptions) => () => void
}
