import type { LoadProgress } from './types'

type ProgressFn = (progress: LoadProgress) => void

/**
 * 把 ROM 与 MAME 媒体盘两条下载流合成一条 `phase: 'rom'` 进度。
 *
 * 以前两条流各发自己的 loaded/total：先到 ratio 1 的那条（较小的 ROM，或命中缓存的 CHD）
 * 就让整段 rom 进度满格、触发 download_complete，之后 160MB 的 CHD 下载期间进度条一直停在 85%；
 * 「本局需下载 xx MB」的文案也在 52MB 和 160MB 之间来回跳。CHD 的总大小（storedBytes）开局前就知道。
 */
export function combinedRomProgress(
  onProgress: ProgressFn | undefined,
  seeds: Readonly<Record<string, number>>,
): (id: string) => ProgressFn {
  const streams = new Map<string, { loaded: number; total: number; cached: boolean }>()
  for (const [id, total] of Object.entries(seeds)) streams.set(id, { loaded: 0, total: Math.max(0, total), cached: false })
  return (id) => (progress) => {
    if (progress.phase !== 'rom') return onProgress?.(progress)
    const cur = streams.get(id) ?? { loaded: 0, total: 0, cached: false }
    const total = progress.total && progress.total > 0 ? progress.total : cur.total
    const loaded = progress.loaded ?? (progress.ratio != null && total ? progress.ratio * total : cur.loaded)
    streams.set(id, { loaded: Math.max(cur.loaded, loaded), total, cached: Boolean(progress.cached) })
    const all = [...streams.values()]
    const known = all.every((stream) => stream.total > 0)
    const sumLoaded = all.reduce((n, stream) => n + Math.min(stream.loaded, stream.total || stream.loaded), 0)
    const sumTotal = all.reduce((n, stream) => n + stream.total, 0)
    onProgress?.({
      ...progress,
      loaded: sumLoaded,
      total: known ? sumTotal : undefined,
      ratio: known && sumTotal > 0 ? Math.min(1, sumLoaded / sumTotal) : undefined,
      cached: all.every((stream) => stream.cached),
    })
  }
}

/**
 * 媒体盘没下完之前压住其它阶段的进度（2026-10-27《狂热节拍》）。
 *
 * ROM 只有几 MB、核心又常从缓存里秒解开：单调进度条会被 engine / starting 事件当场推到 99%，
 * 文案变成「正在启动游戏」，可 130MB 的 CHD 才下到一半 —— 玩家对着 99% 干等几分钟，以为卡死了。
 * mameMedia 的进度计划本来就是 rom 在前，所以 rom 没满之前只放行 rom 事件；其它阶段只记住
 * 最后一条，rom 一满立刻补发。
 *
 * 返回两个口子：`other` 替换掉适配器里其它地方用的 onProgress，`rom` 交给 combinedRomProgress。
 */
export function gateProgressUntilRomComplete(sink: ProgressFn | undefined): { other: ProgressFn; rom: ProgressFn } {
  let complete = false
  let held: LoadProgress | null = null
  return {
    other: (progress) => {
      if (complete || progress.phase === 'rom') return sink?.(progress)
      held = progress
    },
    rom: (progress) => {
      sink?.(progress)
      if (complete || progress.phase !== 'rom' || (progress.ratio ?? 0) < 1) return
      complete = true
      const last = held
      held = null
      if (last) sink?.(last)
    },
  }
}
