/** Sockdrive 清单里与启动热点有关的最小可信视图。 */
export interface SockdriveWarmPlan {
  sizeBytes: number
  aheadRead: number
  rangeCount: number
  dropped: ReadonlySet<number>
  small: ReadonlySet<number>
  preload: readonly number[]
}

export interface SockdriveWarmFile {
  name: string
  expectedBytes: number
}

export type SockdriveRuntimePreload = 'default' | 'none'

// 官方 sockify 2.0.10 最大模板是 FAT32 2GB。更大的声明不是本站合法产物，若继续按它循环找块，
// 一份几 KB 的损坏元数据就能让主线程执行数十亿次循环并假死。
const SOCKDRIVE_MAX_DISK_BYTES = 2 * 1024 ** 3
const SOCKDRIVE_WARM_DESKTOP_BYTES = 16 * 1024 * 1024
const SOCKDRIVE_WARM_3G_BYTES = 8 * 1024 * 1024

/**
 * 弱网也要尽量在进客体前装齐启动热点。《天之痕》实际清单是 27 个 256KB 块（6.75MB），
 * 旧 4MB 预算只覆盖前 16 块，并让 js-dos 关闭 OPFS 预载；剩余 11 块在剧情开始后同步等网络。
 * 8MB 足够覆盖这份清单，又不会把 3G 预热放大到桌面端的 16MB。省流量 / 2G 仍不主动拉正文。
 */
export function sockdriveWarmBudget(effectiveType: string | undefined, saveData: boolean): number {
  if (saveData || /(?:^|-)2g$/i.test(effectiveType ?? '')) return 0
  return effectiveType === '3g' ? SOCKDRIVE_WARM_3G_BYTES : SOCKDRIVE_WARM_DESKTOP_BYTES
}

/**
 * 系统镜像与热点同时下载时保守用两路，避免预热反客为主；纯 DOS 没有大文件竞争，四路才能把
 * HTTP/2 小对象的往返时间藏起来。弱网继续收紧，增加连接数不会凭空增加带宽。
 */
export function sockdriveWarmConcurrency(
  effectiveType: string | undefined,
  saveData: boolean,
  sharesLargeDownload: boolean,
): number {
  if (saveData || /(?:^|-)2g$/i.test(effectiveType ?? '')) return 1
  if (effectiveType === '3g') return 2
  return sharesLargeDownload ? 2 : 4
}

function positiveInteger(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key]
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Sockdrive 元数据字段 ${key} 无效`)
  }
  return Number(value)
}

/**
 * 浏览器启动前只信经过边界检查的清单。Sockdrive 自己遇到坏索引时通常只会继续等盘，
 * 在这里拦住才能把“黑屏”还原成具体的发布错误。
 */
export function parseSockdriveWarmPlan(value: unknown): SockdriveWarmPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sockdrive 元数据根节点不是对象')
  }
  const metadata = value as Record<string, unknown>
  const sizeKb = positiveInteger(metadata, 'size')
  const sizeBytes = sizeKb * 1024
  const aheadRead = positiveInteger(metadata, 'ahead_read')
  const rangeCount = positiveInteger(metadata, 'range_count')
  const sectorSize = positiveInteger(metadata, 'sector_size')
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > SOCKDRIVE_MAX_DISK_BYTES ||
      Math.ceil(sizeBytes / aheadRead) !== rangeCount) {
    throw new Error('Sockdrive 元数据的磁盘大小与分块数量不一致')
  }
  if (aheadRead % sectorSize !== 0) throw new Error('Sockdrive 分块大小不是扇区大小的整数倍')

  const seen = new Set<number>()
  const readRanges = (key: 'dropped_ranges' | 'small_ranges'): Set<number> => {
    const ranges = new Set<number>()
    const items = metadata[key] ?? []
    if (!Array.isArray(items)) throw new Error(`Sockdrive 元数据字段 ${key} 不是数组`)
    for (const raw of items) {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= rangeCount || seen.has(raw)) {
        throw new Error(`Sockdrive 元数据包含越界或重复分块：${String(raw)}`)
      }
      seen.add(raw)
      ranges.add(raw)
    }
    return ranges
  }
  const dropped = readRanges('dropped_ranges')
  const small = readRanges('small_ranges')
  const preload = parseSockdrivePreload(metadata.preload_ranges ?? [], rangeCount, dropped)
  return { sizeBytes, aheadRead, rangeCount, dropped, small, preload }
}

/** 独立的首次运行热点清单与主清单遵守同一组边界。 */
export function parseSockdrivePreload(
  value: unknown,
  rangeCount: number,
  dropped: ReadonlySet<number>,
): number[] {
  if (!Array.isArray(value)) throw new Error('Sockdrive 预取清单不是数组')
  const seen = new Set<number>()
  const out: number[] = []
  for (const raw of value) {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < 0 ||
      raw >= rangeCount ||
      dropped.has(raw) ||
      seen.has(raw)
    ) {
      throw new Error(`Sockdrive 元数据包含无效的预取分块：${String(raw)}`)
    }
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/**
 * 把热点扇区映射成真正的对象文件，并按预算截断。
 * small_ranges 共用一份 preload.raw，必须去重；预算防止一份异常清单在点击时抢拉整张盘。
 */
export function planSockdriveWarmFiles(
  plan: SockdriveWarmPlan,
  override: readonly number[] | null,
  budgetBytes: number,
): SockdriveWarmFile[] {
  const ranges = override ?? plan.preload
  const files = new Map<string, number>()
  let used = 0
  for (const range of ranges) {
    if (plan.dropped.has(range)) continue
    const small = plan.small.has(range)
    const name = small ? 'preload.raw' : `${range}.raw`
    if (files.has(name)) continue
    const expectedBytes = small
      ? plan.small.size * plan.aheadRead
      : Math.min(plan.aheadRead, plan.sizeBytes - range * plan.aheadRead)
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || used + expectedBytes > budgetBytes) continue
    files.set(name, expectedBytes)
    used += expectedBytes
  }
  return [...files].map(([name, expectedBytes]) => ({ name, expectedBytes }))
}

/**
 * js-dos 的 `default` 会把整份 preload_ranges.metaj 再以四路并发全部读取，并不知道本站的
 * 16MB / 4MB / 省流量预算。只有清单涉及的对象已经全进 HTTP 缓存时才让它继续：此时它只是
 * 把缓存字节搬进 OPFS；否则关掉重复预取，预算内的热点仍会在真正读盘时从 HTTP 缓存秒取。
 */
export function sockdriveRuntimePreloadMode(
  plan: SockdriveWarmPlan,
  override: readonly number[] | null,
  warmed: readonly SockdriveWarmFile[],
): SockdriveRuntimePreload {
  /*
    上游没有检查 preload_ranges.metaj 的 HTTP 状态：本站 Worker 的 404 正文又恰好是合法 JSON，
    它会把 `{ error: ... }` 当数组迭代并在挂盘时崩溃。null 表示外置清单没可靠读到，只能由
    本站按主清单做完受限预热后交给按需读取，不能再让上游重复探测。
  */
  if (override === null) return 'none'
  const all = planSockdriveWarmFiles(plan, override, Number.MAX_SAFE_INTEGER)
  const ready = new Map(warmed.map((file) => [file.name, file.expectedBytes]))
  return all.every((file) => ready.get(file.name) === file.expectedBytes) ? 'default' : 'none'
}
