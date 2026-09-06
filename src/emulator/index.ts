/**
 * 模拟器模块的对外入口 —— **只放轻的东西**。
 *
 * 外部从 '@/emulator' 引入解析用的函数和常量，不要直接摸 adapters/。
 *
 *   import { resolveRuntime, isPlayable, p2pPlayable } from '@/emulator'
 *
 * ⚠️ **播放器本体不在这里导出**，而且不能加回来。
 *
 * 这个文件以前从各个重适配器里转导出常量（`EJS_PATH` / `p2pPlayable` /
 * `cloudPlayable` …），顺带还导出 `EmulatorPlayer`。后果是：谁从 '@/emulator'
 * 引入**任何一个符号**，整套模拟器实现（EmulatorJS、js-dos、Ruffle、J2ME、
 * webretro、云联机、看直播）就跟着进了主包 —— 房间列表页只想要两个布尔判断，
 * 首页和博客根本不跑游戏，一样得下载。
 *
 * 现在：常量在 paths.ts、元数据在 runtimeMeta.ts、解析在 registry.ts，全都是轻的；
 * 挂载实现只在 runtimes.ts 里静态引入，而它只被 EmulatorPlayer 引用。
 * 页面这样懒加载播放器：
 *
 *   const EmulatorPlayer = lazyNamed(() => import('@/emulator/EmulatorPlayer'), 'EmulatorPlayer')
 */
export { runtimes, getRuntime, resolveRuntime, isPlayable, runtimesFor, extOf } from './registry'
export type { Runtime, RuntimeId, RuntimeMount, MountOptions, ResolveContext } from './types'

// 轻量常量与判断（不会拖进任何适配器实现，见 paths.ts）
export {
  EJS_PATH,
  RUFFLE_PATH,
  J2ME_PATH,
  WEBRETRO_PATH,
  CLOUDGAME_URL,
  CLOUDGAME_ZONE,
  CLOUD_PLATFORM_CORES,
  p2pPlayable,
  cloudPlayable,
} from './paths'

// 会话参数只是类型，`import type` 不产生运行时依赖
export type { NetplaySession } from './adapters/emulatorjs'
export type { CloudSession, CloudState } from './adapters/cloudgame'
