/**
 * 运行时注册表：决定「这个 ROM 该用哪个引擎跑」。
 *
 * 解析优先级（resolveRuntime）：
 *   1. 逐游戏 runtime 覆盖可用 → 用它
 *   2. NES 按明确的 iNES / mapper 能力选择；未知容器默认 EmulatorJS
 *   3. 其它格式命中覆盖表 → 用指定引擎
 *   4. 否则在支持该扩展名的引擎中按 priority 选择，再退回平台默认
 *
 * 只传平台、不传扩展名时（比如详情页还没选文件），直接退回平台默认。
 *
 * 注意：cloudgame（远程联机）不参与上面的解析 —— 它不由文件格式决定，
 * 而是用户在播放器里显式切到「联机模式」时才使用（见 EmulatorPlayer）。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { EXT_RUNTIME_OVERRIDES } from '@/config/emulators'
import type { ResolveContext, Runtime, RuntimeId } from './types'
import { runtimeMetas } from './runtimeMeta'
import { preferredNesRuntime } from './nesRuntimePolicy'
import { romArchiveRef } from '@/lib/romArchiveUrl'
import { romPackInnerName } from '../../shared/rom-pack-format.js'

/**
 * 全部运行时。**这里放的是元数据，不含 mount** —— 挂载实现在 runtimes.ts，
 * 由懒加载的 EmulatorPlayer 按选中的运行时取用。
 *
 * 这么分是为了让「该用哪个引擎」这个问题不必把引擎本身下载下来才能回答：
 * 详情页、游戏库、房间列表、后台表单都要调下面这几个函数，
 * 以前它们因此各自拖进了七八个适配器的完整实现。
 */
export const runtimes: Record<RuntimeId, Runtime> = runtimeMetas

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
  // 外层是 ZIP，但选运行时要看实际交给引擎的内层文件。
  const wrapped = typeof nameOrUrl === 'string'
    ? (romArchiveRef(nameOrUrl)?.name || nameOrUrl.split(/[?#]/)[0])
    : nameOrUrl.name
  const name = romPackInnerName(wrapped)
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

  // AwayFL 只作为显式兼容回退；必须先于后台固定的 Ruffle 覆盖，因为 Ruffle 仍依赖 WebAssembly。
  if (platform === 'flash' && ctx.flashAwayfl) {
    const fallback = getRuntime('awayfl')
    if (fallback?.available()) return fallback
  }

  // Gambatte 的 RetroArch 画面路径需要 WebGL，Gambatte 本身又是 WebAssembly：没有 WebGL 或没有 WebAssembly
  // 时 GB/GBC 都切到纯 2D 的 binjgb（没有 WebAssembly 时它自己换纯 JavaScript 构建，见 adapters/binjgb.ts），
  // 不让逐游戏的 emulatorjs 固定配置或扩展名优先级把玩家送回注定起不来的核心。
  if ((platform === 'gb' || platform === 'gbc') && (ctx.webglUnavailable || ctx.wasmUnavailable)) {
    const fallback = getRuntime('binjgb')
    if (fallback?.available() && fallback.supports(platform)) return fallback
  }

  // IodineGBA 是 GBA 在无 WebAssembly 浏览器中的纯 JS 退路，不能被逐游戏固定的 EmulatorJS 覆盖拦回去。
  if (platform === 'gba' && ctx.gbaWasmUnavailable) {
    const fallback = getRuntime('iodinegba')
    if (fallback?.available() && fallback.supports(platform)) return fallback
  }

  // 逐游戏覆盖优先：但必须可用且支持本平台，否则回落默认逻辑。
  // 后台固定的 EmulatorJS 在 NES / GB / GBC 上也必须满足各自的画面与运行时要求；能力不足时已先选备用运行时。
  const overrideNeedsWebgl = (platform === 'nes' || platform === 'gb' || platform === 'gbc') &&
    ctx.webglUnavailable && ctx.runtimeOverride === 'emulatorjs'
  if (ctx.runtimeOverride && !overrideNeedsWebgl) {
    const forced = getRuntime(ctx.runtimeOverride)
    if (forced?.available() && forced.supports(platform)) return forced
  }

  if (ext) {
    // 0. NES 不能按文件大小选引擎：线上拿到的经常是 `.8bg` / ZIP 外层大小，压缩参数一变
    //    就会换引擎，按运行时隔离的存档也会像“丢了”。现在只有明确可读的 iNES mapper 才走
    //    轻量 jsnes；格式不明、mapper 不支持或容器包默认走 EmulatorJS。后台 runtime 覆盖仍最优先。
    if (platform === 'nes') {
      const preferred = preferredNesRuntime(ctx)
      const order: RuntimeId[] = preferred === 'jsnes'
        ? ['jsnes', 'emulatorjs']
        : ['emulatorjs', 'jsnes']
      for (const id of order) {
        const candidate = getRuntime(id)
        if (candidate?.available() && candidate.supports('nes')) return candidate
      }
    }

    // 1. 覆盖表优先
    const forced = getRuntime(EXT_RUNTIME_OVERRIDES[ext])
    if (forced?.available() && forced.supports(platform)) return forced

    // 2. 声明支持该扩展名的引擎里挑 priority 最高的
    const candidates = localRuntimes()
      // Play! 的 arcade 支持必须由后台逐游戏显式启用；普通 ZIP romset 不能被它抢走。
      .filter((r) => !(r.id === 'play' && platform === 'arcade') && r.available() && r.extensions.includes(ext) && r.supports(platform))
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
