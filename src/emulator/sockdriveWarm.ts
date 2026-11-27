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

// 生产 Fallout 清单有 245 个热点范围；即使总字节不大，也不能让几十次 RTT 挡住 DOSBox-X 开机。
// 小型清单最多预取 32 个对象；长清单只预取 8 个开局热点，其余由 Sockdrive 按需读取。
export const SOCKDRIVE_WARM_MAX_FILES = 32
const SOCKDRIVE_LARGE_PROFILE_THRESHOLD = 64
export const SOCKDRIVE_LARGE_PROFILE_STARTUP_FILES = 8

/** 长清单通常记录了一段完整游玩过程；开局只挡住最先触达的一小段，其余块由客体按需读取。 */
export function sockdriveWarmFileLimit(profileRangeCount: number): number {
  if (!Number.isSafeInteger(profileRangeCount) || profileRangeCount < 0) return SOCKDRIVE_WARM_MAX_FILES
  return profileRangeCount > SOCKDRIVE_LARGE_PROFILE_THRESHOLD
    ? SOCKDRIVE_LARGE_PROFILE_STARTUP_FILES
    : SOCKDRIVE_WARM_MAX_FILES
}

/** 预热只计数不留字节；元数据给出的长度是硬上限，不能信任代理的 Content-Length。 */
export async function drainSockdriveWarmResponse(
  response: Response,
  expectedBytes: number,
  onChunk?: () => void,
): Promise<number> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new RangeError('Sockdrive 预热长度无效')
  const encoding = response.headers.get('content-encoding')
  const declaredLength = Number(response.headers.get('content-length'))
  const hasDeclaredLength = Number.isSafeInteger(declaredLength) && declaredLength >= 0
  if (!encoding && hasDeclaredLength && declaredLength > expectedBytes) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`长度超过 ${expectedBytes}`)
  }

  if (!response.body) {
    // 没有流时只能接受未压缩且长度已精确声明的对象，才可证明 arrayBuffer 不会超出硬上限。
    if (encoding || !hasDeclaredLength || declaredLength !== expectedBytes) {
      throw new Error('浏览器不支持安全流式读取 Sockdrive 分块')
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength !== expectedBytes) throw new Error(`长度 ${bytes.byteLength}，应为 ${expectedBytes}`)
    return bytes.byteLength
  }

  const reader = response.body.getReader()
  let loaded = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (loaded + value.byteLength > expectedBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`长度超过 ${expectedBytes}`)
      }
      loaded += value.byteLength
      onChunk?.()
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* body 终止时无需二次释放 */ }
  }
  if (loaded !== expectedBytes) throw new Error(`长度 ${loaded}，应为 ${expectedBytes}`)
  return loaded
}

/** 只读启动清单也要按流量上限逐块读；缺 Content-Length 的代理响应不能用 arrayBuffer 无界分配。 */
export async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('响应体上限无效')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new RangeError(`响应体超过 ${maxBytes} 字节`)
  }
  const body = response.body
  // 热点清单只是投机优化；不支持流的旧环境直接退回主清单，不能为它冒险整块申请未知大小。
  if (!body) throw new Error('浏览器不支持安全流式读取 Sockdrive 清单')

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (loaded + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new RangeError(`响应体超过 ${maxBytes} 字节`)
      }
      chunks.push(value)
      loaded += value.byteLength
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* body 终止时无需二次释放 */ }
  }

  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// 官方 sockify 2.0.10 最大模板是 FAT32 2GB。更大的声明不是本站合法产物，若继续按它循环找块，
// 一份几 KB 的损坏元数据就能让主线程执行数十亿次循环并假死。
const SOCKDRIVE_MAX_DISK_BYTES = 2 * 1024 ** 3
// Sockify 的正常分块是 256 KiB；16 MiB 留足发布余量，同时避免坏清单让一个启动读请求占满手机内存。
const SOCKDRIVE_MAX_BLOCK_BYTES = 16 * 1024 * 1024
const SOCKDRIVE_WARM_DESKTOP_BYTES = 8 * 1024 * 1024
const SOCKDRIVE_WARM_3G_BYTES = 8 * 1024 * 1024

/**
 * 弱网也要尽量在进客体前装齐启动热点。《天之痕》实际清单是 27 个 256KB 块（6.75MB），
 * 旧 4MB 预算只覆盖前 16 块，并让 js-dos 关闭 OPFS 预载；剩余 11 块在剧情开始后同步等网络。
 * 8MiB 足够覆盖这份清单；长清单通常含整段试玩轨迹，只在启动前读前 8 个对象（通常 2MiB），
 * 其余对象交给客体按需读取，避免冷启动固定等待整段网络传输。
 * 省流量 / 2G 仍不主动拉正文。
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
  if (aheadRead > SOCKDRIVE_MAX_BLOCK_BYTES) {
    throw new Error('Sockdrive 单个分块超过 16MB，拒绝在启动时读取')
  }
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
 * 外置热点清单只是预热提示；坏 JSON 或越界范围不能让本来可按需读取的游戏整局失败。
 * 主清单仍由 parseSockdriveWarmPlan 严格校验，只有这份可选覆盖允许回退到主清单。
 */
export function parseOptionalSockdrivePreloadJson(
  text: string,
  rangeCount: number,
  dropped: ReadonlySet<number>,
): { ranges: number[] | null; error: string | null } {
  try {
    return {
      ranges: parseSockdrivePreload(JSON.parse(text), rangeCount, dropped),
      error: null,
    }
  } catch (error) {
    return {
      ranges: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 把热点扇区映射成真正的对象文件，并按预算截断。
 * small_ranges 共用一份 preload.raw，必须去重；预算防止一份异常清单在点击时抢拉整张盘。
 */
export function planSockdriveWarmFiles(
  plan: SockdriveWarmPlan,
  override: readonly number[] | null,
  budgetBytes: number,
  maxFiles = Number.MAX_SAFE_INTEGER,
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
    if (files.size >= maxFiles) break
  }
  return [...files].map(([name, expectedBytes]) => ({ name, expectedBytes }))
}

/**
 * js-dos 的 `default` 会把整份 preload_ranges.metaj 再以四路并发全部读取，并不知道本站的
 * 8MiB / 32 个对象 / 省流量限制。只有清单涉及的对象已经全进 HTTP 缓存时才让它继续：此时它只是
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
