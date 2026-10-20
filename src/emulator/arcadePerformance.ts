import type { ArcadeButtonCount, PlatformId } from '@/types'

/**
 * FBNeo 街机的音频排期窗口。引擎默认 64ms，网页主线程一次稍长的布局 / GC 就会把它抽空；
 * 80ms 只增加一帧左右的缓冲，却能覆盖多数短毛刺。MAME Current / 普通 NDS 更重，均用 128ms。
 */
export const FBNEO_ARCADE_AUDIO_LATENCY_MS = 80

/** 48kHz、双声道、Float32 下核心日志应该打印的缓冲字节数。 */
export const FBNEO_ARCADE_AUDIO_BUFFER_BYTES_48K = FBNEO_ARCADE_AUDIO_LATENCY_MS / 1000 * 48_000 * 2 * 4

const METAL_SLUG_SLUG = /(?:^|-)metal-slug(?:-|$)|^mslug\d*(?:-|$)/

export function isFbneoArcadeCore(platform: PlatformId, core: string): boolean {
  return platform === 'arcade' && core === 'fbneo'
}

/** 较轻的街机核心共用 80ms 音频窗口；mame-current 单独走 128ms。 */
export function isLightArcadeCore(platform: PlatformId, core: string): boolean {
  return platform === 'arcade' && (core === 'fbneo' || core === 'mame2003' || core === 'mame2003_plus')
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
): ArcadeButtonCount {
  if (explicit === 2 || explicit === 4 || explicit === 6) return explicit
  return biosName?.trim().toLowerCase() === 'neogeo' ? 4 : 6
}

/**
 * 街机核心的全站性能默认值。这里只放经过核心源码取证、且可以被玩家设置覆盖的选项。
 *
 * FBNeo 官方把 cpu-speed-adjust 定义为“提高后修复部分游戏的原机降速”的入口，所以不能只给
 * 《合金弹头 X》开：其它 Neo Geo / CPS / PGM 游戏同样会在精灵、爆炸或音效繁忙时触发真实街机
 * 的 CPU 饱和。这里按宿主线程数给 110%~130%，已知降速更重的《合金弹头》系列再加一档；
 * 同时把采样率和插值调到更轻的档位，给超频腾出预算。玩家明确保存的核心选项仍会覆盖这些默认值。
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
  hardwareConcurrency: number | undefined,
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

  const threads = Number.isFinite(hardwareConcurrency) ? Math.max(1, Number(hardwareConcurrency)) : 4
  const slug = gameSlug?.trim().toLowerCase() ?? ''
  const hasHeavyNativeSlowdown = METAL_SLUG_SLUG.test(slug)
  const cpuClock = hasHeavyNativeSlowdown
    ? threads >= 8 ? '150%' : threads >= 4 ? '130%' : '110%'
    : threads >= 8 ? '130%' : threads >= 4 ? '120%' : '110%'
  const defaults: Record<string, string> = {
    'fbneo-cpu-speed-adjust': cpuClock,
    'fbneo-frameskip-type': 'disabled',
    'fbneo-samplerate': '44100',
    'fbneo-sample-interpolation': '2-point 1st order',
  }

  // 32 位色深有些街机必须开，不能为省性能全站关闭；Neo Geo 的《合金弹头》不依赖它，才单独关。
  if (hasHeavyNativeSlowdown) defaults['fbneo-allow-depth-32'] = 'disabled'
  return defaults
}
