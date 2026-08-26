/**
 * 模拟器模块的唯一对外入口。
 *
 * 外部只从 '@/emulator' 引入，不要直接摸 adapters/ —— 这样以后换引擎、
 * 调整内部结构都不会波及页面代码。
 *
 *   import { EmulatorPlayer, resolveRuntime, detectRom } from '@/emulator'
 */
export { EmulatorPlayer } from './EmulatorPlayer'
export {
  runtimes,
  getRuntime,
  resolveRuntime,
  isPlayable,
  runtimesFor,
  extOf,
} from './registry'
export type { Runtime, RuntimeId, MountOptions, ResolveContext } from './types'
export { EJS_PATH } from './adapters/emulatorjs'
export { RUFFLE_PATH } from './adapters/ruffle'
export { J2ME_PATH } from './adapters/j2me'
export { CLOUDGAME_URL, CLOUD_PLATFORM_CORES, cloudPlayable, cloudGameRuntime } from './adapters/cloudgame'
export type { CloudSession, CloudState } from './adapters/cloudgame'
