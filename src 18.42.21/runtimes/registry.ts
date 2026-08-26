/**
 * 运行时注册表：平台 → 运行时 的唯一入口。
 *
 *   resolveRuntime('gba')   -> EmulatorJS（core: gba）
 *   resolveRuntime('flash') -> Ruffle
 *   resolveRuntime('java')  -> undefined（暂无运行时）
 *
 * 平台与运行时的对应关系写在 src/data/platforms.ts 的 `runtime` 字段里；
 * 这里只负责按 id 找到实现，并做一次「该运行时是否真的支持此平台」的校验。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import type { Runtime, RuntimeId } from './types'
import { emulatorJsRuntime } from './emulatorjs'
import { ruffleRuntime } from './ruffle'

export const runtimes: Record<RuntimeId, Runtime> = {
  emulatorjs: emulatorJsRuntime,
  ruffle: ruffleRuntime,
}

export function getRuntime(id: RuntimeId | null | undefined): Runtime | undefined {
  return id ? runtimes[id] : undefined
}

/** 某平台对应的运行时；平台未配置或运行时不支持时返回 undefined */
export function resolveRuntime(platform: PlatformId): Runtime | undefined {
  const rt = getRuntime(platformMap[platform]?.runtime)
  return rt && rt.supports(platform) ? rt : undefined
}

/** 平台是否可在线运行 */
export function isPlayable(platform: PlatformId): boolean {
  return Boolean(resolveRuntime(platform))
}

export type { Runtime, RuntimeId, MountOptions } from './types'
