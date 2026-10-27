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
