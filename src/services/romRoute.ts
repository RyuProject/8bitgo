/**
 * ROM 主、备用源的轻量测速。
 *
 * 这里只在两个地址代表同一语言槽时选路，绝不跨语言比较，更不会把两个来源的 Range 分片混用。
 * 测速读取每个来源开头的一小段并立即取消响应；大文件才值得付这点额外流量，小 ROM 继续直接用主源。
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

function worthRacing(primary: RomRouteSource, backup: RomRouteSource, hints: RomRouteHints): boolean {
  const effectiveType = String(hints.effectiveType ?? '').toLowerCase()
  if (hints.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return false
  const primaryRoute = routeId(primary.url)
  const backupRoute = routeId(backup.url)
  if (!primaryRoute || !backupRoute || primaryRoute === backupRoute) return false
  const knownLargest = Math.max(primary.size ?? 0, backup.size ?? 0)
  return knownLargest >= ROM_ROUTE_RACE_MIN_BYTES
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
  if (!worthRacing(primary, backup, hints)) return 'primary'
  const [primarySpeed, backupSpeed] = await Promise.all([
    measureRoute(primary, options),
    measureRoute(backup, options),
  ])
  if (backupSpeed > 0 && primarySpeed === 0) return 'backup'
  return backupSpeed > primarySpeed * FASTER_MARGIN ? 'backup' : 'primary'
}

export function clearRomRouteSpeedCache(): void {
  routeSpeeds.clear()
}
