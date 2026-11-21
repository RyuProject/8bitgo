/**
 * ROM 线路记分板：每个资源域（origin）一份「真实下载吞吐 + 连续失败」，外加短时熔断。
 *
 * 为什么要统一（2026-11-18《西游释厄传》浏览器实测）：rom.8bitgo.com 的 HEAD 4 秒超时，才轮到
 * download.8bitgo.com（0.17 秒就回了）；可下一局、BIOS、光盘照样先去撞 rom.8bitgo.com。
 * 以前每处各记各的，互相看不见：
 *   - HEAD 探测：备用域结论记 5 分钟（roms.ts 的 ALTERNATE_PROBE_TTL_MS）；
 *   - BIOS：reachableRomOrigins 记 60 秒可达 / 8 秒不可达（romHosts.ts）；
 *   - chooseRomHost：64KB 探针记 30 分钟、真实下载记 5 分钟（romRoute.ts）；
 *   - 下载器：每局从零开始，首段慢了才去测另一域（loadProgress.ts）。
 * 现在 HEAD、BIOS、ROM 分片、光盘候选都往这里写、从这里读同一份排序。
 *
 * 只记两类事实：
 *   - 吞吐：**响应头之后**的正文字节 / 耗时，不含握手和首字节。64KB 小探针量的是延迟、量不出吞吐
 *     （AGENTS.md §2.36 的《仙剑》），所以探针结论只作冷启动的先验，不写进这里的速率；
 *   - 线路故障：网络层失败、超时、正文失速、5xx / 429。HTTP 404 这类「对象不在」不算线路的错：
 *     几条线路读同一个 R2 桶，换线路也一样没有。
 *
 * 连续 2 次故障熔断 1 分钟，之后每多一次翻倍，最长 5 分钟；任何一次成功立即恢复。熔断只是把这条线路
 * 排到最后，**不会**把它从候选里删掉 —— 全部熔断时仍按原顺序试，最坏退化成没有记分板的老行为。
 *
 * 不 import 任何业务模块：romHosts / romRoute / loadProgress / roms 都引用它。
 */

export type RomRouteFailure = 'network' | 'timeout' | 'stall' | 'server'

interface RouteStat {
  /** 正文吞吐 EWMA，字节 / 毫秒 */
  rate?: number
  rateAt?: number
  /** 连续故障次数 */
  failures: number
  failedAt?: number
  /** 熔断到期时间（Date.now() 毫秒） */
  openUntil?: number
}

const STORAGE_KEY = '8bitgo.rom-route-health.v1'
/** 吞吐结论的有效期：线路状况按小时级变化，半小时前的测量不再可信 */
export const ROUTE_RATE_TTL_MS = 30 * 60 * 1000
/** 连续故障记录的有效期：十分钟没再出事就当它好了 */
const FAILURE_TTL_MS = 10 * 60 * 1000
const OPEN_AFTER_FAILURES = 2
/**
 * 同一条线路在这么短的时间里接连失败只算一次。2026-11-18 线上实测：一个详情页同时向一条线路问明文和 8BG 两个候选，
 * 线路慢时两个 HEAD 一起超时，记成两次故障，一次开页就熔断；第二次开页累计到 4 次，熔断 4 分钟。
 * 同一批请求一起失败说明的是同一件事。窗口从这一批的第一次失败算起、不随后续失败顺延，
 * 否则持续每几秒失败一次的线路永远只记一次。
 */
const FAILURE_COALESCE_MS = 5_000
const OPEN_BASE_MS = 60 * 1000
const OPEN_MAX_MS = 5 * 60 * 1000
/** 有效吞吐样本的下限：太小的样本主要是调度抖动 */
export const ROUTE_MIN_SAMPLE_BYTES = 64 * 1024
const MIN_SAMPLE_MS = 20
const EWMA_ALPHA = 0.4
/** 排序时另一条线路要快这么多才算「更快」，免得两条差不多的线路来回换（BIOS 缓存按 URL 存） */
export const ROUTE_FASTER_MARGIN = 1.15

const stats = new Map<string, RouteStat>()
let loaded = false

/**
 * 外部观察者（真实用户回报，见 romRouteReport.ts）：每次记下的成功 / 计入的失败都通知一次。
 * 用注入而不是 import，保持本模块不依赖任何业务模块。
 */
type RouteListener = (origin: string, ok: boolean, kind?: RomRouteFailure) => void
let routeListener: RouteListener | null = null
export function setRomRouteListener(listener: RouteListener | null): void {
  routeListener = listener
}
const notify = (origin: string, ok: boolean, kind?: RomRouteFailure) => {
  try {
    routeListener?.(origin, ok, kind)
  } catch {
    /* 观察者出错不影响记分 */
  }
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(storage()?.getItem(STORAGE_KEY) || '{}') as Record<string, RouteStat>
    if (!parsed || typeof parsed !== 'object') return
    for (const [origin, stat] of Object.entries(parsed)) {
      if (!/^https?:\/\//.test(origin) || !stat || typeof stat !== 'object') continue
      const failures = Number.isFinite(stat.failures) && stat.failures > 0 ? Math.min(20, Math.floor(stat.failures)) : 0
      const rate = Number.isFinite(stat.rate) && (stat.rate ?? 0) > 0 ? stat.rate : undefined
      stats.set(origin, {
        rate,
        rateAt: rate ? Number(stat.rateAt) || 0 : undefined,
        failures,
        failedAt: failures ? Number(stat.failedAt) || 0 : undefined,
        openUntil: Number(stat.openUntil) || undefined,
      })
    }
  } catch {
    /* 存储坏了就当没记过 */
  }
}

function save(): void {
  try {
    const out: Record<string, RouteStat> = {}
    for (const [origin, stat] of stats) out[origin] = stat
    storage()?.setItem(STORAGE_KEY, JSON.stringify(out))
  } catch {
    /* 无痕模式写不进去：本页内存里仍有记录 */
  }
}

/** 线路身份：完整 origin（协议 + 主机 + 端口）。认不出的地址返回空串，不参与记分 */
export function romRouteOrigin(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url, typeof location === 'undefined' ? 'https://8bitgo.invalid' : location.href)
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : ''
  } catch {
    return ''
  }
}

function statFor(origin: string): RouteStat {
  load()
  let stat = stats.get(origin)
  if (!stat) {
    stat = { failures: 0 }
    stats.set(origin, stat)
  }
  return stat
}

/** 读出某条线路「此刻」的状态：过期的吞吐和故障记录按没有处理 */
function freshStat(origin: string, now: number) {
  load()
  const stat = stats.get(origin)
  if (!stat) return { rate: undefined, failures: 0, open: false }
  const rate = stat.rate && stat.rateAt !== undefined && now - stat.rateAt < ROUTE_RATE_TTL_MS ? stat.rate : undefined
  const failures = stat.failures && stat.failedAt !== undefined && now - stat.failedAt < FAILURE_TTL_MS ? stat.failures : 0
  const open = Boolean(stat.openUntil && stat.openUntil > now)
  return { rate, failures, open }
}

/**
 * 一段真实传输：bytes 是响应头之后读到的正文字节，elapsedMs 从响应头到读完。
 * 同时算一次成功（清零故障、解除熔断）。
 */
export function recordRomRouteTransfer(url: string, bytes: number, elapsedMs: number, now = Date.now()): void {
  const origin = romRouteOrigin(url)
  if (!origin) return
  const stat = statFor(origin)
  stat.failures = 0
  stat.failedAt = undefined
  stat.openUntil = undefined
  if (bytes >= ROUTE_MIN_SAMPLE_BYTES && elapsedMs >= MIN_SAMPLE_MS && Number.isFinite(bytes / elapsedMs)) {
    const sample = bytes / elapsedMs
    const fresh = stat.rate && stat.rateAt !== undefined && now - stat.rateAt < ROUTE_RATE_TTL_MS
    stat.rate = fresh ? stat.rate! * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA : sample
    stat.rateAt = now
  }
  save()
  notify(origin, true)
}

/** 线路答复了（HEAD 成功、Range 头对上），但没有可用的吞吐样本 */
export function recordRomRouteSuccess(url: string): void {
  recordRomRouteTransfer(url, 0, 0)
}

export function recordRomRouteFailure(url: string, kind: RomRouteFailure, now = Date.now()): void {
  const origin = romRouteOrigin(url)
  if (!origin) return
  const stat = statFor(origin)
  const sinceLast = stat.failedAt === undefined ? Infinity : now - stat.failedAt
  if (stat.failures > 0 && sinceLast >= 0 && sinceLast < FAILURE_COALESCE_MS) return
  const recent = sinceLast < FAILURE_TTL_MS
  stat.failures = (recent ? stat.failures : 0) + 1
  stat.failedAt = now
  if (stat.failures >= OPEN_AFTER_FAILURES) {
    const span = Math.min(OPEN_MAX_MS, OPEN_BASE_MS * 2 ** (stat.failures - OPEN_AFTER_FAILURES))
    stat.openUntil = now + span
  }
  save()
  notify(origin, false, kind)
}

/** 这条线路是否在熔断中 */
export function isRomRouteOpen(url: string, now = Date.now()): boolean {
  const origin = romRouteOrigin(url)
  return origin ? freshStat(origin, now).open : false
}

/** 这条线路最近的正文吞吐（字节 / 毫秒）；没测过或已过期返回 undefined */
export function romRouteRate(url: string, now = Date.now()): number | undefined {
  const origin = romRouteOrigin(url)
  return origin ? freshStat(origin, now).rate : undefined
}

/**
 * 把同一对象的几种线路写法排个序：没熔断的在前；同组里按「吞吐 × 0.5^近期故障次数」，
 * 要快 15% 以上才越过排在它前面的线路，否则保持调用方给的原顺序（原顺序就是默认偏好）。
 *
 * 没测过的线路按「和已知最快的一样快」处理：它要么就是快，要么这一局测出来以后自然排到后面；
 * 若按 0 处理，一条从没被选中过的线路永远测不到，排序就永远修正不了。
 */
export function rankRomRoutes(urls: readonly string[], now = Date.now()): string[] {
  const unique = urls.filter((url, index) => url && urls.indexOf(url) === index)
  if (unique.length < 2) return unique
  const entries = unique.map((url, index) => {
    const origin = romRouteOrigin(url)
    const fresh = origin ? freshStat(origin, now) : { rate: undefined, failures: 0, open: false }
    return { url, index, ...fresh, score: 0 }
  })
  const known = entries.map((entry) => entry.rate ?? 0).filter((rate) => rate > 0)
  const optimistic = known.length ? Math.max(...known) : 1
  for (const entry of entries) entry.score = (entry.rate ?? optimistic) * 0.5 ** Math.min(entry.failures, 6)
  const beats = (a: typeof entries[number], b: typeof entries[number]) => {
    if (a.open !== b.open) return !a.open
    if (a.score > b.score * ROUTE_FASTER_MARGIN) return true
    if (b.score > a.score * ROUTE_FASTER_MARGIN) return false
    return a.index < b.index
  }
  // 逐个挑「能胜过其余所有候选」的那一个；只有几条线路，O(n²) 无所谓，结果只取决于原顺序，确定可复现
  const remaining = [...entries]
  const ranked: string[] = []
  while (remaining.length) {
    let best = 0
    for (let i = 1; i < remaining.length; i++) if (beats(remaining[i], remaining[best])) best = i
    ranked.push(remaining[best].url)
    remaining.splice(best, 1)
  }
  return ranked
}

/** 诊断包用的一行摘要：每条线路的吞吐（Mbps）、近期故障、是否熔断 */
export function romRouteHealthSummary(now = Date.now()): string {
  load()
  const parts: string[] = []
  for (const origin of stats.keys()) {
    const fresh = freshStat(origin, now)
    if (!fresh.rate && !fresh.failures && !fresh.open) continue
    const host = origin.replace(/^https?:\/\//, '')
    const rate = fresh.rate ? `${((fresh.rate * 8) / 1000).toFixed(1)}Mbps` : '未测'
    parts.push(`${host} ${rate}${fresh.failures ? ` 失败${fresh.failures}` : ''}${fresh.open ? ' 熔断中' : ''}`)
  }
  return parts.join('；')
}

/** 测试与「重置」用 */
export function resetRomRouteHealth(): void {
  stats.clear()
  loaded = true
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
