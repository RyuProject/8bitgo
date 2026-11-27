import type { ArcadeButtonCount, PlatformId } from '@/types'
import { isFbneoCore } from './arcadeCore'

/**
 * FBNeo 街机的音频排期窗口。引擎默认 64ms，网页主线程一次稍长的布局 / GC 就会把它抽空；
 * 80ms 只增加一帧左右的缓冲，却能覆盖多数短毛刺。MAME Current / 普通 NDS 更重，均用 128ms。
 */
export const FBNEO_ARCADE_AUDIO_LATENCY_MS = 80

/** 48kHz、双声道、Float32 下核心日志应该打印的缓冲字节数。 */
export const FBNEO_ARCADE_AUDIO_BUFFER_BYTES_48K = FBNEO_ARCADE_AUDIO_LATENCY_MS / 1000 * 48_000 * 2 * 4

const METAL_SLUG_SLUG = /(?:^|-)metal-slug(?:-|$)|^mslug\d*(?:-|$)/
const FOUR_BUTTON_ARCADE_GAMES = new Set(['jojos-bizarre-adventure'])
/**
 * Namco 的四键格斗（铁拳 LP RP LK RK、灵魂之刃 / 灵魂能力 横斩 纵斩 踢 防御）。
 * 播放器开局后会从 ROM 内容识别出 namcoMameSets 的 `buttons: 4`，可详情页的键位表和
 * 开局前的按键图拿不到 ROM，只有 slug —— 以前这两处一律画六键，铁拳页写着「按键 5 = Q、
 * 按键 6 = E」，按下去什么也没有（2026-11-06）。与 namcoMameSets 的 FOUR_BUTTON_FIGHTERS 同一组游戏。
 */
const NAMCO_FOUR_BUTTON_SLUG = /^(?:tekken|soul-?edge|soul-?blade|soul-?cal(?:i)?bur)(?:$|[-\d~])/

export function isFbneoArcadeCore(platform: PlatformId, core: string): boolean {
  return platform === 'arcade' && isFbneoCore(core)
}

/** 较轻的街机核心共用 80ms 音频窗口；mame-current 单独走 128ms。 */
export function isLightArcadeCore(platform: PlatformId, core: string): boolean {
  // fbalpha2012_cps1/cps2 是同一族更轻的核心，以前漏了它们，CPS 游戏改用轻核心后反而回到 64ms 窗口
  return platform === 'arcade' && (isFbneoCore(core) || core === 'mame2003' || core === 'mame2003_plus' ||
    core === 'fbalpha2012_cps1' || core === 'fbalpha2012_cps2')
}

/**
 * 一款游戏真正需要多少颗街机动作键。
 *
 * 后台旧数据大多没填 arcadeButtons，以前一律退成六键；Neo Geo 实机只有 A/B/C/D 四键，
 * 结果《合金弹头》手机上白画两颗按钮。明确配置永远优先，只有缺省时才按系统 BIOS 推断，
 * 无法判断的板子继续保守地给六键，避免格斗游戏少键。
 */
export function effectiveArcadeButtons(
  explicit: ArcadeButtonCount | undefined,
  biosName: string | undefined,
  gameSlug?: string,
): ArcadeButtonCount {
  if (explicit === 2 || explicit === 4 || explicit === 6) return explicit
  // 《未来遗产》使用轻拳 / 中拳 / 重拳 / 替身四键；它不是 Neo Geo，旧数据也未必有 BIOS 名，
  // 只按板卡推断会把不存在的 5、6 键画给玩家。配置过的 arcadeButtons 仍始终优先。
  const slug = gameSlug?.trim().toLowerCase() ?? ''
  // 合金弹头各作都是 Neo Geo 的四键板。详情数据有时只有平台级 BIOS，`arcadeBios` 会为空，
  // 不能因此在页面和触屏手柄上多画 5、6 键；复用性能分档识别的系列边界，避免两处判断漂移。
  if (FOUR_BUTTON_ARCADE_GAMES.has(slug) || NAMCO_FOUR_BUTTON_SLUG.test(slug) || METAL_SLUG_SLUG.test(slug)) return 4
  return biosName?.trim().toLowerCase() === 'neogeo' ? 4 : 6
}

/**
 * 街机核心的全站性能默认值。这里只放经过核心源码取证、且可以被玩家设置覆盖的选项。
 *
 * `fbneo-cpu-speed-adjust` 调的是**模拟出来的街机 CPU 时钟**，不是宿主 CPU 加速：大于 100% 会让
 * 核心每帧执行更多工作、改变游戏时序。官方文档把提高时钟限定为修复少数游戏的原机降速，
 * 低端设备反而建议降低时钟；宿主线程数也不能代表单核性能或某款板卡是否需要超频。因此全站
 * 默认固定 100%，不按桌面线程数或触屏状态擅自超频。玩家可以在核心选项里按游戏调整，已保存的值优先。
 * 采样率和插值仍使用较轻档位，降低音频处理成本。
 *
 * MAME 2003/Plus 没有等价的、对全部驱动都安全的 CPU 超频选项，只降低采样成本；本站打包的
 * 普通 MAME 2003 还包含 DCS 声音加速，Plus 构建里实测没有该选项，不能写一项假配置。
 * mame-current 更没有安全的全局去降速开关，不能用 `-nothrottle` 冒充——那会让整款游戏连计时
 * 一起变快。它继续依靠较大的音频窗口和逐游戏选择更轻核心来保证宿主稳帧。
 */
export function arcadePerformanceDefaultOptions(
  platform: PlatformId,
  core: string,
  gameSlug: string | undefined,
): Readonly<Record<string, string>> {
  if (platform !== 'arcade') return {}

  if (core === 'mame2003' || core === 'mame2003_plus') {
    const prefix = core === 'mame2003' ? 'mame2003' : 'mame2003-plus'
    return {
      ...(core === 'mame2003' ? { mame2003_dcs_speedhack: 'enabled' } : {}),
      [`${prefix}_frameskip`]: '0',
      [`${prefix}_sample_rate`]: '44100',
    }
  }

  if (!isFbneoArcadeCore(platform, core)) return {}

  const defaults: Record<string, string> = {
    'fbneo-cpu-speed-adjust': '100%',
    'fbneo-frameskip-type': 'disabled',
    'fbneo-samplerate': '44100',
    'fbneo-sample-interpolation': '2-point 1st order',
  }

  const slug = gameSlug?.trim().toLowerCase() ?? ''
  const hasHeavyNativeSlowdown = METAL_SLUG_SLUG.test(slug)
  // 32 位色深有些街机必须开，不能为省性能全站关闭；Neo Geo 的《合金弹头》不依赖它，才单独关。
  if (hasHeavyNativeSlowdown) defaults['fbneo-allow-depth-32'] = 'disabled'
  return defaults
}
