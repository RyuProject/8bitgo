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
