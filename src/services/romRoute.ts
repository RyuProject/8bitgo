/**
 * ROM 主、备用源的轻量测速。
 *
 * 这里只在两个地址代表同一语言槽时选路，绝不跨语言比较，更不会把两个来源的 Range 分片混用。
 * 测速读取每个来源开头的一小段并立即取消响应；默认只有大文件才测，调用方可用 minBytes 放开（见 roms.ts）。
 */

// 128 KiB 已足够把 DNS/TLS/TTFB 和明显带宽差拉开；旧值 256 KiB 会让“检查版本”
// 在移动网下额外等更久、还为两个源各付一份流量。真正下载开始后仍会用 8 MiB 实测自适应并发。
export const ROM_ROUTE_SAMPLE_BYTES = 128 * 1024
export const ROM_ROUTE_RACE_MIN_BYTES = 16 * 1024 * 1024
const ROUTE_SPEED_TTL_MS = 5 * 60 * 1000
const FASTER_MARGIN = 1.15

export interface RomRouteSource {
  url: string
  size?: number
}

export interface RomRouteHints {
  saveData?: boolean
  effectiveType?: string
}

interface RouteSpeed {
  bytesPerMs: number
  expiresAt: number
}

export interface RouteRaceOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  sampleBytes?: number
  hints?: RomRouteHints
  signal?: AbortSignal
  /** 测试注入的 fetch 不应污染真实浏览器会话的域名测速缓存。 */
  cacheResults?: boolean
  /**
   * 文件至少多大才测速，默认 ROM_ROUTE_RACE_MIN_BYTES。传 0 = 不论大小都测：
   * 小 ROM（NES 几十 KB）样本就是整份文件，测出来主要是首字节延迟，正是小文件开局时真正的瓶颈；
   * 测速结果按域名缓存 5 分钟，同一会话后续开局不再重测。
   */
  minBytes?: number
}

const routeSpeeds = new Map<string, RouteSpeed>()

const routeId = (url: string): string => {
  try {
    return new URL(url, typeof location === 'undefined' ? 'https://8bitgo.invalid' : location.href).origin
  } catch {
    return ''
  }
}

const runtimeHints = (): RomRouteHints => {
  if (typeof navigator === 'undefined') return {}
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection
  return { saveData: connection?.saveData, effectiveType: connection?.effectiveType }
}

function worthRacing(
  primary: RomRouteSource,
  backup: RomRouteSource,
  hints: RomRouteHints,
  minBytes = ROM_ROUTE_RACE_MIN_BYTES,
): boolean {
  const effectiveType = String(hints.effectiveType ?? '').toLowerCase()
  if (hints.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return false
  const primaryRoute = routeId(primary.url)
  const backupRoute = routeId(backup.url)
  if (!primaryRoute || !backupRoute || primaryRoute === backupRoute) return false
  const knownLargest = Math.max(primary.size ?? 0, backup.size ?? 0)
  return knownLargest >= minBytes
}

async function measureRoute(source: RomRouteSource, options: RouteRaceOptions): Promise<number> {
  const id = routeId(source.url)
  if (!id) return 0
  const now = options.now ?? (() => typeof performance !== 'undefined' ? performance.now() : Date.now())
  const cacheResults = options.cacheResults ?? !options.fetchImpl
  const cached = cacheResults ? routeSpeeds.get(id) : undefined
  if (cached && cached.expiresAt > Date.now()) return cached.bytesPerMs

  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abortFromParent, { once: true })
  // 测速只是优化，不能反过来成为开局门槛；3 秒还没取到样本就保守走主源。
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000)
  const sampleBytes = options.sampleBytes ?? ROM_ROUTE_SAMPLE_BYTES
  const startedAt = now()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await (options.fetchImpl ?? fetch)(source.url, {
      method: 'GET',
      headers: { Range: `bytes=0-${sampleBytes - 1}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok || !response.body) return 0
    reader = response.body.getReader()
    let loaded = 0
    while (loaded < sampleBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) loaded += Math.min(value.byteLength, sampleBytes - loaded)
    }
    const elapsedMs = Math.max(1, now() - startedAt)
    const bytesPerMs = loaded > 0 ? loaded / elapsedMs : 0
    if (cacheResults && bytesPerMs > 0) {
      routeSpeeds.set(id, { bytesPerMs, expiresAt: Date.now() + ROUTE_SPEED_TTL_MS })
    }
    return bytesPerMs
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromParent)
    await reader?.cancel().catch(() => {})
  }
}

/** 返回测速后应该采用哪一个完整来源；调用方仍只会从该来源下载全部分片。 */
export async function chooseFasterRomRoute(
  primary: RomRouteSource,
  backup: RomRouteSource,
  options: RouteRaceOptions = {},
): Promise<'primary' | 'backup'> {
  const hints = options.hints ?? runtimeHints()
  if (!worthRacing(primary, backup, hints, options.minBytes)) return 'primary'
  /*
    先到先得：两边样本一样大，先取完的就是更快的那条路，不必再等另一边跑满 3 秒超时
    （小 ROM 开局总共才几百毫秒，白等 3 秒得不偿失）。
    · 主域先完成：镜像要快 15% 才能赢，此时它已不可能赢，立刻取消；
    · 镜像先完成（用时 t）：主域只要在 t×1.15 内完成就仍算主域，过了这个点就取消、改走镜像。
  */
  const now = options.now ?? (() => typeof performance !== 'undefined' ? performance.now() : Date.now())
  const startedAt = now()
  const linked = () => {
    const c = new AbortController()
    if (options.signal?.aborted) c.abort()
    else options.signal?.addEventListener('abort', () => c.abort(), { once: true })
    return c
  }
  const primaryCtl = linked()
  const backupCtl = linked()
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const primaryRun = measureRoute(primary, { ...options, signal: primaryCtl.signal }).then((speed) => {
    if (speed > 0) backupCtl.abort()
    return speed
  })
  const backupRun = measureRoute(backup, { ...options, signal: backupCtl.signal }).then((speed) => {
    if (speed > 0) {
      const grace = Math.max(0, (now() - startedAt) * (FASTER_MARGIN - 1))
      graceTimer = setTimeout(() => primaryCtl.abort(), grace)
    }
    return speed
  })
  try {
    const [primarySpeed, backupSpeed] = await Promise.all([primaryRun, backupRun])
    if (backupSpeed > 0 && primarySpeed === 0) return 'backup'
    return backupSpeed > primarySpeed * FASTER_MARGIN ? 'backup' : 'primary'
  } finally {
    clearTimeout(graceTimer)
  }
}

export function clearRomRouteSpeedCache(): void {
  routeSpeeds.clear()
}

/* ───────────────────────── 主域 / 加速镜像的线路选择 ─────────────────────────
 *
 * 2026-11-07 起所有平台都在开局前选一次 assets.<裸域>（Cloudflare）还是 cn-assets.<裸域>（EdgeOne），
 * 不再只给 NES / Flash / 16MB 以上的大文件测。
 *
 * 为什么不再拿 ROM 自己的前 128KB 测：EdgeOne 上一份没人玩过的 ROM 第一次必然 MISS（实测样本
 * 先 MISS 后 HIT），测到的是「EdgeOne 回源」而不是「EdgeOne 线路」，冷门游戏会系统性地偏向主域。
 * 现在两边取同一个 64KB 的固定探针（R2 `roms/_route-probe/v1.bin`，带 `?v=1` 长缓存，两边边缘都常驻），
 * 量的是纯线路：TLS + 首字节 + 一小段吞吐。结论按「主域 + 镜像」这一对存 30 分钟（内存 + localStorage），
 * 同一会话、刷新页面、换游戏都不重测。
 *
 * 线路定了以后 ROM 本身照旧走 fetchBlobWithProgress 的 8MB 对齐 Range（带 romv 的都是），EdgeOne
 * 免费版按片缓存（实测 98MB 的 8BG 冷片 12.6s → 再取 3.1s HIT），不会因为整包太大被拒缓存。
 *
 * 有先验：边缘已经判定是大陆访客（cn 入口，或 Cloudflare 按国家改写过的页面，见 coverCdnHint）时
 * 默认镜像，否则默认主域；非默认的一方必须快 15% 才能赢，两边都测不出就用默认。省流量 / 2G 不测，直接用默认。
 */
export const ROM_ROUTE_PROBE_PATH = '/roms/_route-probe/v1.bin?v=1'
const HOST_CHOICE_STORAGE_KEY = '8bitgo.rom-host.v1'
export const HOST_CHOICE_TTL_MS = 30 * 60 * 1000
const HOST_PROBE_TIMEOUT_MS = 2500

export type RomHost = 'primary' | 'mirror'

interface StoredHostChoice {
  pair: string
  host: RomHost
  at: number
}

export interface RomHostOptions {
  /** 测不出结论时用哪边；也决定「谁需要快 15% 才能赢」 */
  prefer?: RomHost
  fetchImpl?: typeof fetch
  now?: () => number
  hints?: RomRouteHints
  timeoutMs?: number
  /** 测试注入：不读写真实 localStorage / 内存缓存 */
  cacheResults?: boolean
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

const hostChoices = new Map<string, StoredHostChoice>()
const hostInflight = new Map<string, Promise<RomHost>>()

const browserStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readHostChoice(pair: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null): RomHost | null {
  const fresh = (choice: StoredHostChoice | undefined | null) =>
    choice && choice.pair === pair && (choice.host === 'primary' || choice.host === 'mirror') &&
    Date.now() - choice.at >= 0 && Date.now() - choice.at < HOST_CHOICE_TTL_MS
  const memory = hostChoices.get(pair)
  if (fresh(memory)) return memory!.host
  try {
    const parsed = JSON.parse(storage?.getItem(HOST_CHOICE_STORAGE_KEY) || 'null') as StoredHostChoice | null
    if (fresh(parsed)) {
      hostChoices.set(pair, parsed!)
      return parsed!.host
    }
  } catch {
    /* 存储坏了就当没测过 */
  }
  return null
}

function writeHostChoice(pair: string, host: RomHost, storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
  const choice = { pair, host, at: Date.now() }
  hostChoices.set(pair, choice)
  try {
    storage?.setItem(HOST_CHOICE_STORAGE_KEY, JSON.stringify(choice))
  } catch {
    /* 无痕模式写不进去：本页内存里仍有结论 */
  }
}

/** 取完整个探针的耗时（毫秒）；失败 / 超时 / 被取消返回 null */
async function timeProbe(url: string, signal: AbortSignal, options: RomHostOptions): Promise<number | null> {
  const now = options.now ?? (() => typeof performance !== 'undefined' ? performance.now() : Date.now())
  const startedAt = now()
  try {
    // no-store 只绕开浏览器自己的缓存；两边 CDN 仍从边缘回，测的就是线路
    const response = await (options.fetchImpl ?? fetch)(url, { cache: 'no-store', signal })
    if (!response.ok) return null
    const body = await response.arrayBuffer()
    if (!body.byteLength) return null
    return Math.max(1, now() - startedAt)
  } catch {
    return null
  }
}

async function raceHosts(primaryBase: string, mirrorBase: string, prefer: RomHost, options: RomHostOptions): Promise<RomHost | null> {
  const other: RomHost = prefer === 'primary' ? 'mirror' : 'primary'
  const base = (host: RomHost) => (host === 'primary' ? primaryBase : mirrorBase)
  const controllers = { primary: new AbortController(), mirror: new AbortController() }
  const deadline = setTimeout(() => {
    controllers.primary.abort()
    controllers.mirror.abort()
  }, options.timeoutMs ?? HOST_PROBE_TIMEOUT_MS)
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const now = options.now ?? (() => typeof performance !== 'undefined' ? performance.now() : Date.now())
  const startedAt = now()
  try {
    const preferredRun = timeProbe(`${base(prefer)}${ROM_ROUTE_PROBE_PATH}`, controllers[prefer].signal, options).then((ms) => {
      // 默认方先到：另一方不可能再快 15%，立刻停掉，省一个连接
      if (ms !== null) controllers[other].abort()
      return ms
    })
    const otherRun = timeProbe(`${base(other)}${ROM_ROUTE_PROBE_PATH}`, controllers[other].signal, options).then((ms) => {
      // 另一方先到（用时 t）：默认方只要在 t×1.15 内到就仍算默认方，过了这个点就不必再等
      if (ms !== null) graceTimer = setTimeout(() => controllers[prefer].abort(), Math.max(0, (now() - startedAt) * (FASTER_MARGIN - 1)))
      return ms
    })
    const [preferredMs, otherMs] = await Promise.all([preferredRun, otherRun])
    if (preferredMs === null && otherMs === null) return null
    if (otherMs !== null && (preferredMs === null || otherMs * FASTER_MARGIN < preferredMs)) return other
    return prefer
  } finally {
    clearTimeout(deadline)
    clearTimeout(graceTimer)
  }
}

/**
 * 这次开局走主域还是加速镜像。同一对域名同时只测一次，结论缓存 30 分钟；
 * 调用方被取消时不影响别人在等的同一轮测速（两次 64KB，很便宜）。
 */
export async function chooseRomHost(primaryBase: string, mirrorBase: string, options: RomHostOptions = {}): Promise<RomHost> {
  const prefer = options.prefer ?? 'primary'
  if (!mirrorBase || !primaryBase || routeId(primaryBase) === routeId(mirrorBase)) return 'primary'
  const cacheResults = options.cacheResults ?? !options.fetchImpl
  const storage = cacheResults ? (options.storage === undefined ? browserStorage() : options.storage) : null
  const pair = `${routeId(primaryBase)}|${routeId(mirrorBase)}`
  if (cacheResults) {
    const cached = readHostChoice(pair, storage)
    if (cached) return cached
  }
  const hints = options.hints ?? runtimeHints()
  const effectiveType = String(hints.effectiveType ?? '').toLowerCase()
  if (hints.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return prefer

  const key = `${pair}|${prefer}`
  const running = cacheResults ? hostInflight.get(key) : undefined
  if (running) return running
  const run = raceHosts(primaryBase, mirrorBase, prefer, options).then((winner) => {
    // 两边都没测出来：这次用默认，不写缓存，下一局再测
    if (winner && cacheResults) writeHostChoice(pair, winner, storage)
    return winner ?? prefer
  })
  if (cacheResults) {
    hostInflight.set(key, run)
    void run.finally(() => hostInflight.delete(key))
  }
  return run
}

export function clearRomHostChoice(): void {
  hostChoices.clear()
  hostInflight.clear()
  try {
    browserStorage()?.setItem(HOST_CHOICE_STORAGE_KEY, 'null')
  } catch {
    /* ignore */
  }
}
