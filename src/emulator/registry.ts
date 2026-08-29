/**
 * 运行时注册表：决定「这个 ROM 该用哪个引擎跑」。
 *
 * 解析优先级（resolveRuntime）：
 *   1. 扩展名命中 src/config/emulators.ts 的覆盖表，且该引擎可用 → 用它
 *   2. 否则在「声明支持该扩展名」的可用引擎里挑 priority 最高的
 *   3. 否则退回平台自己配置的引擎（src/data/platforms.ts 的 runtime 字段）
 *
 * 只传平台、不传扩展名时（比如详情页还没选文件），走第 3 步。
 *
 * 注意：cloudgame（远程联机）不参与上面的解析 —— 它不由文件格式决定，
 * 而是用户在播放器里显式切到「联机模式」时才使用（见 EmulatorPlayer）。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { EXT_RUNTIME_OVERRIDES } from '@/config/emulators'
import type { ResolveContext, Runtime, RuntimeId } from './types'
import { emulatorJsRuntime } from './adapters/emulatorjs'
import { ruffleRuntime } from './adapters/ruffle'
import { html5Runtime } from './adapters/html5'
import { jsnesRuntime } from './adapters/jsnes'
import { j2meRuntime } from './adapters/j2me'
import { jsdosRuntime } from './adapters/jsdos'
import { webretroRuntime } from './adapters/webretro'
import { cloudGameRuntime } from './adapters/cloudgame'
import { liveViewRuntime } from './adapters/liveview'

export const runtimes: Record<RuntimeId, Runtime> = {
  emulatorjs: emulatorJsRuntime,
  ruffle: ruffleRuntime,
  html5: html5Runtime,
  jsnes: jsnesRuntime,
  j2me: j2meRuntime,
  jsdos: jsdosRuntime,
  webretro: webretroRuntime,
  cloudgame: cloudGameRuntime,
  liveview: liveViewRuntime,
}

/** 参与「本地运行」解析的引擎（排除联机与看直播：这两个都不是按文件格式选出来的） */
const localRuntimes = (): Runtime[] =>
  Object.values(runtimes).filter((r) => r.id !== 'cloudgame' && r.id !== 'liveview')

export function getRuntime(id: RuntimeId | null | undefined): Runtime | undefined {
  return id ? runtimes[id] : undefined
}

/** 平台自己配置的引擎（老逻辑，作为兜底） */
function platformDefault(platform: PlatformId): Runtime | undefined {
  const rt = getRuntime(platformMap[platform]?.runtime)
  return rt && rt.available() && rt.supports(platform) ? rt : undefined
}

/** 从文件名 / 对象存储 key 里取扩展名（不带点、小写） */
export function extOf(nameOrUrl: string | File | undefined | null): string | undefined {
  if (!nameOrUrl) return undefined
  const name = typeof nameOrUrl === 'string' ? nameOrUrl.split(/[?#]/)[0] : nameOrUrl.name
  const m = /\.([A-Za-z0-9]+)$/.exec(name)
  return m ? m[1].toLowerCase() : undefined
}

/**
 * 解析该用哪个运行时。
 * 传了 ext 就按格式选，没传就按平台选。
 */
export function resolveRuntime(target: PlatformId | ResolveContext): Runtime | undefined {
  const ctx: ResolveContext = typeof target === 'string' ? { platform: target } : target
  const { platform, ext } = ctx

  if (ext) {
    // 1. 覆盖表优先
    const forced = getRuntime(EXT_RUNTIME_OVERRIDES[ext])
    if (forced?.available() && forced.supports(platform)) return forced

    // 2. 声明支持该扩展名的引擎里挑 priority 最高的
    const candidates = localRuntimes()
      .filter((r) => r.available() && r.extensions.includes(ext) && r.supports(platform))
      .sort((a, b) => b.priority - a.priority)
    if (candidates[0]) return candidates[0]
  }

  // 3. 平台默认
  return platformDefault(platform)
}

/** 平台是否可在线运行（任意一个可用的本地引擎支持它即可） */
export function isPlayable(platform: PlatformId): boolean {
  if (platformDefault(platform)) return true
  return localRuntimes().some((r) => r.available() && r.supports(platform))
}

/** 某平台所有可用引擎，用于界面上展示 / 让用户手动切换 */
export function runtimesFor(platform: PlatformId): Runtime[] {
  return localRuntimes()
    .filter((r) => r.available() && r.supports(platform))
    .sort((a, b) => b.priority - a.priority)
}
