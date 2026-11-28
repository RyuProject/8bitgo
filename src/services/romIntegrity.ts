import {
  isIntegrityKey,
  type RomIntegrityManifest,
  validateRomIntegrityManifest,
} from './romIntegrityData'
import { withRequestTimeout } from './requestTimeout'

export class RomIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RomIntegrityError'
  }
}

/** 必须校验的对象拿不到清单时，重试 ROM 字节没有意义；有界重取清单后应立即中断下载。 */
export class RomIntegrityManifestUnavailableError extends RomIntegrityError {
  constructor(message: string) {
    super(message)
    this.name = 'RomIntegrityManifestUnavailableError'
  }
}

const manifestCache = new Map<string, { promise: Promise<RomIntegrityManifest | null>; expiresAt: number }>()
const MANIFEST_CACHE_LIMIT = 32
const UNVERSIONED_TTL_MS = 30_000
const MANIFEST_REQUEST_TIMEOUT_MS = 2_500
const MANIFEST_TOTAL_TIMEOUT_MS = 6_000
/** 清单很小；主域短暂无响应时，用一条可信同桶线路并行兜底，避免串行等满请求超时。 */
const MANIFEST_HEDGE_DELAY_MS = 150
const warned = new Set<string>()
/** 只有下载器真的按清单验过的 Blob 才能把证明带入本地大 ROM 缓存。 */
const verifiedBlobProofs = new WeakMap<Blob, { tag: string; manifest: RomIntegrityManifest }>()

function localSetting(key: string): string {
  try { return localStorage.getItem(key)?.trim() || '' } catch { return '' }
}

function configuredBase(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = localSetting('8bitgo.rom.base') || String(env?.VITE_ROM_BASE_URL || '')
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '')
  if (value.startsWith('//')) return `https:${value}`.replace(/\/+$/, '')
  if (value.startsWith('/')) return value.replace(/\/+$/, '')
  return value ? `https://${value.replace(/\/+$/, '')}` : ''
}

function configuredApi(rawUrl: string): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const configured = localSetting('8bitgo.rom.api') || String(env?.VITE_ROM_API_URL || '')
  const raw = configured || new URL(rawUrl, typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href).origin
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
  if (raw.startsWith('//')) return `https:${raw}`.replace(/\/+$/, '')
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '')
  return `https://${raw.replace(/\/+$/, '')}`
}

function isTrustedOrigin(url: URL): boolean {
  if (url.hostname === '8bitgo.com' || url.hostname.endsWith('.8bitgo.com')) return true
  try { return url.origin === new URL(configuredBase(), location.href).origin } catch { return false }
}

/** 只识别本站 R2 的 ROM / BIOS 对象；不猜外链、本地文件或 blob 的内容基线。 */
export function romIntegrityKey(rawUrl: string): string | null {
  try {
    const base = typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href
    const url = new URL(rawUrl, base)
    if (!['http:', 'https:'].includes(url.protocol) || !isTrustedOrigin(url)) return null
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    if (parts[0] !== 'roms' || parts.length < 2 || parts.some((part) => part.includes('/') || part.includes('\\'))) return null
    const key = parts.join('/')
    return isIntegrityKey(key) ? key : null
  } catch { return null }
}

/** 给独立运行页传递同一套清单地址；下载和校验仍在目标页面内并行进行。 */
export function romIntegrityManifestUrl(rawUrl: string): string | null {
  const key = romIntegrityKey(rawUrl)
  if (!key) return null
  try {
    const base = typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href
    const assetUrl = new URL(rawUrl, base)
    const endpoint = new URL(`${configuredApi(rawUrl)}/integrity`)
    endpoint.searchParams.set('key', key)
    const version = assetUrl.searchParams.get('romv') || ''
    if (version) endpoint.searchParams.set('romv', version)
    return endpoint.href
  } catch { return null }
}

/**
 * ROM API 主域暂时不可达时，从同一 R2 对象的可信读取域补取清单。
 * 这些域名由生产配置映射到同一个 Worker / ROM 桶；镜像域只作最后候选，因为它可能经过额外代理。
 */
function romIntegrityManifestUrls(rawUrl: string, key: string, version: string): string[] {
  const primary = romIntegrityManifestUrl(rawUrl)
  if (!primary) return []
  const base = typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const candidates = [
    primary,
    new URL(rawUrl, base).origin,
    String(env?.VITE_ROM_DOWNLOAD_URL || ''),
    String(env?.VITE_ROM_BASE_URL || ''),
    String(env?.VITE_ROM_MIRROR_URL || ''),
  ]
  const urls = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    try {
      const source = new URL(candidate, base)
      if (!['http:', 'https:'].includes(source.protocol)) continue
      // 配置的 API 主地址沿用既有的路径前缀；其它回退项必须是本站可信读取域。
      const isPrimary = candidate === primary
      if (!isPrimary && !isTrustedOrigin(source)) continue
      const endpoint = isPrimary ? new URL(primary) : new URL('/integrity', source.origin)
      endpoint.searchParams.set('key', key)
      if (version) endpoint.searchParams.set('romv', version)
      urls.add(endpoint.href)
    } catch { /* 非法备用地址不影响其它可信线路 */ }
  }
  return [...urls]
}

function etagVersion(etag: string): string {
  return etag.replace(/^W\//, '').replace(/"/g, '').trim()
}

/** 读取缓存中的清单前，要求它仍对应当前本站 ROM key、ETag/romv 与字节长度。 */
export function romIntegrityManifestForUrl(
  rawUrl: string,
  value: unknown,
  size: number,
): RomIntegrityManifest | null {
  const key = romIntegrityKey(rawUrl)
  if (!key || !value || typeof value !== 'object') return null
  const etag = (value as { etag?: unknown }).etag
  if (typeof etag !== 'string') return null
  const manifest = validateRomIntegrityManifest(value, key, etag, size)
  if (!manifest) return null
  try {
    const base = typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href
    const version = new URL(rawUrl, base).searchParams.get('romv')?.trim() || ''
    return !version || etagVersion(manifest.etag) === version ? manifest : null
  } catch {
    return null
  }
}

function warnOnce(key: string, reason: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[ROM integrity] ${key}: ${reason}`)
}

function withTimeout(parent: AbortSignal | undefined, ms: number): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const relay = () => controller.abort(parent?.reason)
  if (parent?.aborted) relay()
  else parent?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('SHA-256 清单请求超时')), ms)
  return { controller, signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', relay) } }
}

/** 与对象下载并行请求小清单；版本化地址可由浏览器长期缓存，不增加反复开局的往返。 */
export function fetchRomIntegrityManifest(
  rawUrl: string,
  parentSignal?: AbortSignal,
  options: { refreshCachedFailure?: boolean; totalTimeoutMs?: number } = {},
): Promise<RomIntegrityManifest | null> {
  const key = romIntegrityKey(rawUrl)
  if (!key) return Promise.resolve(null)
  if (parentSignal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
  const base = typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href
  const assetUrl = new URL(rawUrl, base)
  const version = assetUrl.searchParams.get('romv') || ''
  const cacheKey = `${key}\n${version}`
  const old = manifestCache.get(cacheKey)
  if (old && (old.expiresAt === 0 || old.expiresAt > Date.now())) {
    manifestCache.delete(cacheKey)
    manifestCache.set(cacheKey, old)
    if (options.refreshCachedFailure && old.expiresAt > 0 && Number.isFinite(old.expiresAt)) {
      // 必校验 ROM 已到首片但旁路清单超时：只重取小清单一次，不要为了重试清单重下 8 MiB ROM。
      return old.promise.then((cached) => {
        if (cached) return cached
        if (manifestCache.get(cacheKey) === old) manifestCache.delete(cacheKey)
        return fetchRomIntegrityManifest(rawUrl, parentSignal, { totalTimeoutMs: options.totalTimeoutMs })
      })
    }
    return old.promise
  }
  if (old) manifestCache.delete(cacheKey)

  const pending = (async () => {
    const manifestUrls = romIntegrityManifestUrls(rawUrl, key, version)
    if (!manifestUrls.length) return null
    // 清单请求按 key + romv 共用；不能绑到第一个标签页的 AbortSignal，否则它取消后会连带取消
    // 同一时刻另一个播放器正在等待的请求。调用方取消后只忽略结果，2.5 秒上限仍会回收请求。
    const requestedTotalTimeout = Number(options.totalTimeoutMs)
    const totalTimeout = Number.isFinite(requestedTotalTimeout)
      ? Math.max(500, Math.min(MANIFEST_TOTAL_TIMEOUT_MS, requestedTotalTimeout))
      : MANIFEST_TOTAL_TIMEOUT_MS
    const deadline = Date.now() + totalTimeout
    let lastFailure: unknown
    let integrityFailure: RomIntegrityError | null = null
    let sawMissing = false
    const inFlight = new Set<AbortController>()
    type CandidateResult = { manifest: RomIntegrityManifest } | { manifest: null }
    const attempt = async (manifestUrl: string): Promise<CandidateResult> => {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        lastFailure = new Error('SHA-256 清单总等待时间已到')
        return { manifest: null }
      }
      const timed = withTimeout(undefined, Math.min(MANIFEST_REQUEST_TIMEOUT_MS, remainingMs))
      inFlight.add(timed.controller)
      try {
        const response = await fetch(manifestUrl, { cache: version ? 'force-cache' : 'no-store', signal: timed.signal })
        if (response.status === 404 || response.status === 405) {
          // 有些读取域不提供 Worker 路由；试完其它域后才把 404 当作旧对象兼容状态。
          sawMissing = true
          return { manifest: null }
        }
        if (!response.ok) {
          const error = new RomIntegrityError(response.status === 503 || response.status === 412
            ? `Worker 拒绝使用不完整或版本不符的 ROM / BIOS 校验清单（HTTP ${response.status}）`
            : `Worker 清单接口返回 HTTP ${response.status}`)
          lastFailure = error
          if (response.status === 503 || response.status === 412) integrityFailure = error
          return { manifest: null }
        }
        const value = await response.json().catch((error) => {
          lastFailure = error
          return null
        }) as { etag?: unknown; size?: unknown; manifest?: unknown } | null
        if (!value || typeof value.etag !== 'string' || !Number.isSafeInteger(value.size) || Number(value.size) <= 0) {
          const error = new RomIntegrityError('Worker 返回的 SHA-256 清单元数据无效')
          lastFailure = error
          integrityFailure = error
          return { manifest: null }
        }
        if (version && etagVersion(value.etag) !== version) {
          const error = new RomIntegrityError('清单版本与 ROM 地址不一致')
          lastFailure = error
          integrityFailure = error
          return { manifest: null }
        }
        const manifest = validateRomIntegrityManifest(value.manifest, key, value.etag, Number(value.size))
        if (!manifest) {
          const error = new RomIntegrityError('Worker 返回的 SHA-256 分块清单无效')
          lastFailure = error
          integrityFailure = error
          return { manifest: null }
        }
        return { manifest }
      } catch (error) {
        lastFailure = error
        if (error instanceof RomIntegrityError) integrityFailure = error
        return { manifest: null }
      } finally {
        timed.dispose()
        inFlight.delete(timed.controller)
      }
    }
    const first = attempt(manifestUrls[0])
    let firstOutcome: CandidateResult | undefined
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined
    const firstOrHedge = await Promise.race([
      first.then((result) => ({ kind: 'first' as const, result })),
      new Promise<{ kind: 'hedge' }>((resolve) => {
        hedgeTimer = setTimeout(() => resolve({ kind: 'hedge' }), MANIFEST_HEDGE_DELAY_MS)
      }),
    ])
    if (hedgeTimer !== undefined) clearTimeout(hedgeTimer)
    let nextUrlIndex = 1
    if (firstOrHedge.kind === 'first') {
      firstOutcome = firstOrHedge.result
      if (firstOutcome.manifest) return firstOutcome.manifest
    } else if (manifestUrls.length > 1) {
      // 仅在主域 150ms 内没有结果时同时尝试一个同桶备用域，限制额外请求与字节数。
      const second = attempt(manifestUrls[1])
      const winner = await new Promise<RomIntegrityManifest | null>((resolve) => {
        let remaining = 2
        let settled = false
        for (const task of [first, second]) {
          void task.then((result) => {
            if (result.manifest && !settled) {
              settled = true
              resolve(result.manifest)
              return
            }
            if (--remaining === 0 && !settled) {
              settled = true
              resolve(null)
            }
          })
        }
      })
      if (winner) {
        // 首个有效清单足够；别让已经输掉的慢线路继续占连接或等满超时。
        for (const controller of inFlight) controller.abort()
        return winner
      }
      nextUrlIndex = 2
    } else {
      firstOutcome = await first
      if (firstOutcome.manifest) return firstOutcome.manifest
    }
    for (let index = nextUrlIndex; index < manifestUrls.length && Date.now() < deadline; index++) {
      const result = await attempt(manifestUrls[index])
      if (result.manifest) return result.manifest
    }
    if (integrityFailure) throw integrityFailure
    if (sawMissing && !lastFailure) {
      // 404 是旧对象尚未回填的兼容状态；上传器与迁移脚本会逐步消除它。
      warnOnce(key, '此资源还没有 SHA-256 清单，当前仍按旧有 HTTP / 大小 / 格式检查加载')
      return null
    }
    // 清单请求失败不延长弱网玩家等待；Worker 对已经标记为必校验的对象会拒绝无清单下载。
    warnOnce(key, `清单暂不可读（${lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? '请求超时')}）`)
    return null
  })()
  pending.catch(() => {})
  const entry = { promise: pending, expiresAt: 0 }
  manifestCache.set(cacheKey, entry)
  while (manifestCache.size > MANIFEST_CACHE_LIMIT) {
    const first = manifestCache.keys().next().value as string | undefined
    if (!first || first === cacheKey) break
    manifestCache.delete(first)
  }
  void pending.then((manifest) => {
    // 只有已验证的清单才可随 romv 永久缓存；404 / 临时网络错误必须过期后重试，不能把一次故障锁死整页。
    entry.expiresAt = manifest && version ? Number.POSITIVE_INFINITY : Date.now() + UNVERSIONED_TTL_MS
  }, () => {
    if (manifestCache.get(cacheKey) === entry) manifestCache.delete(cacheKey)
  })
  return pending
}

async function digest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new RomIntegrityError('浏览器不支持 SHA-256，无法安全校验 ROM / BIOS')
  // WebCrypto 会在调用时复制输入快照；普通 ROM 分块直接传入即可，避免 JS 再复制一次。
  // wasm 共享内存视图不能直接交给 WebCrypto，仍先复制出普通 ArrayBuffer。
  const isShared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
  const view = isShared ? Uint8Array.from(bytes) : bytes as Uint8Array<ArrayBuffer>
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', view))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 给本地完整 ROM 缓存里的「已校验」标记生成身份。
 *
 * ETag + URL 能识别对象版本，但把清单内容也纳入标签，才能让被替换的 sidecar 触发重验；
 * 这里只散列几 KB 的元数据，不读 ROM 本体。标签带域分隔，避免和其它 SHA-256 用途混淆。
 */
export async function romIntegrityManifestTag(manifest: RomIntegrityManifest): Promise<string> {
  const payload = [
    '8bitgo-rom-integrity-cache-v1',
    String(manifest.v),
    manifest.alg,
    manifest.key,
    manifest.etag,
    String(manifest.size),
    String(manifest.blockBytes),
    manifest.blocks.join(','),
  ].join('\n')
  return `sha256:${await digest(new TextEncoder().encode(payload))}`
}

/** 在完整字节校验成功之后记录该 Blob 的清单身份；单纯收到迟到清单不能调用此函数。 */
export async function markRomBlobIntegrityVerified(blob: Blob, manifest: RomIntegrityManifest): Promise<void> {
  const checked = validateRomIntegrityManifest(manifest, manifest.key, manifest.etag, blob.size)
  if (!checked) throw new RomIntegrityError('ROM / BIOS 与已校验清单不一致')
  // 把已验证凭据拍成独立快照，避免调用方后来改动 blocks 让印记与持久化清单脱钩。
  const proof = { ...checked, blocks: [...checked.blocks] }
  verifiedBlobProofs.set(blob, { tag: await romIntegrityManifestTag(proof), manifest: proof })
}

/** 本地缓存只读取这份内存侧的实测标记，不从清单是否到达推断 Blob 已通过校验。 */
export function romBlobIntegrityTag(blob: Blob): string | undefined {
  return verifiedBlobProofs.get(blob)?.tag
}

/** 与通过校验的印记来自同一 WeakMap 项，防止迟到清单被单独保存成缓存证明。 */
export function romBlobIntegrityManifest(blob: Blob): RomIntegrityManifest | undefined {
  return verifiedBlobProofs.get(blob)?.manifest
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim())
  if (!match) return null
  const [start, end, total] = match.slice(1).map(Number)
  return [start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end
    ? { start, end, total }
    : null
}

async function fetchRepairBlock(url: string, manifest: RomIntegrityManifest, index: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const start = index * manifest.blockBytes
  const end = Math.min(manifest.size - 1, start + manifest.blockBytes - 1)
  const target = new URL(url, typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href)
  target.searchParams.set('__8bg_integrity_retry', `${index}-${Date.now()}`)
  const expectedLength = end - start + 1
  return withRequestTimeout(30_000, signal, async (requestSignal) => {
    const response = await fetch(target, {
      headers: { Range: `bytes=${start}-${end}`, 'If-Match': manifest.etag },
      cache: 'reload',
      signal: requestSignal,
    })
    const range = parseContentRange(response.headers.get('Content-Range'))
    const declaredLength = Number(response.headers.get('Content-Length'))
    if (response.status !== 206 || !range || range.start !== start || range.end !== end || range.total !== manifest.size ||
        (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== expectedLength) ||
        response.headers.get('ETag') !== manifest.etag || response.headers.get('Content-Encoding')) {
      void response.body?.cancel().catch(() => {})
      throw new RomIntegrityError(`SHA-256 不符的第 ${index + 1} 块无法安全重取（HTTP ${response.status}）`)
    }
    if (!response.body) throw new RomIntegrityError(`ROM / BIOS 第 ${index + 1} 块重取没有正文`)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    const cancelOnAbort = () => { void reader.cancel(requestSignal.reason).catch(() => {}) }
    requestSignal.addEventListener('abort', cancelOnAbort, { once: true })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        // Range 服务器可能忽略请求并回整个 ROM；绝不把不受信任的响应一次性 arrayBuffer 化。
        if (received > expectedLength) throw new RomIntegrityError(`ROM / BIOS 第 ${index + 1} 块重取超过声明长度`)
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {})
      throw error
    } finally {
      requestSignal.removeEventListener('abort', cancelOnAbort)
      try { reader.releaseLock() } catch { /* 已由浏览器释放 */ }
    }
    if (received !== expectedLength) throw new RomIntegrityError(`ROM / BIOS 第 ${index + 1} 块重取长度不符`)
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    if (await digest(bytes) !== manifest.blocks[index]) {
      throw new RomIntegrityError(`ROM / BIOS 第 ${index + 1} 块重取后 SHA-256 仍不匹配`)
    }
    return bytes
  })
}

/** 已完整下载或命中浏览器 ROM 缓存的字节：分块核对，损坏时只重取对应块一次。 */
export async function verifyRomBytes(
  rawUrl: string,
  value: ArrayBuffer | Uint8Array,
  manifest: RomIntegrityManifest,
  signal?: AbortSignal,
): Promise<boolean> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength !== manifest.size) throw new RomIntegrityError(`ROM / BIOS 长度不符：应为 ${manifest.size}，实际 ${bytes.byteLength}`)
  let repaired = false
  for (let first = 0; first < manifest.blocks.length; first += 4) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const count = Math.min(4, manifest.blocks.length - first)
    const hashes = await Promise.all(Array.from({ length: count }, (_, offset) => {
      const index = first + offset
      const start = index * manifest.blockBytes
      return digest(bytes.subarray(start, Math.min(bytes.byteLength, start + manifest.blockBytes)))
    }))
    for (let offset = 0; offset < count; offset++) {
      const index = first + offset
      if (hashes[offset] !== manifest.blocks[index]) {
        const replacement = await fetchRepairBlock(rawUrl, manifest, index, signal)
        bytes.set(replacement, index * manifest.blockBytes)
        repaired = true
      }
    }
  }
  return repaired
}

/** OPFS / IndexedDB 大 Blob 按块读取，避免为了复验缓存申请整张光盘的 ArrayBuffer。 */
export async function verifyRomBlob(blob: Blob, manifest: RomIntegrityManifest, signal?: AbortSignal): Promise<void> {
  if (blob.size !== manifest.size) throw new RomIntegrityError(`ROM 缓存长度不符：应为 ${manifest.size}，实际 ${blob.size}`)
  for (let first = 0; first < manifest.blocks.length; first += 4) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const count = Math.min(4, manifest.blocks.length - first)
    const checks = await Promise.all(Array.from({ length: count }, async (_, offset) => {
      const index = first + offset
      const start = index * manifest.blockBytes
      const bytes = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + manifest.blockBytes)).arrayBuffer())
      return { index, valid: await digest(bytes) === manifest.blocks[index] }
    }))
    const bad = checks.find((check) => !check.valid)
    if (bad) throw new RomIntegrityError(`ROM 缓存第 ${bad.index + 1} 块 SHA-256 不匹配`)
  }
}

/** 下载器刚收齐的一片先验再落续传库；发现坏块时只换掉这个 2 MiB 块。 */
export async function verifyRomBlobRange(
  rawUrl: string,
  blob: Blob,
  start: number,
  manifest: RomIntegrityManifest,
  signal?: AbortSignal,
): Promise<Blob> {
  const end = start + blob.size
  if (!Number.isSafeInteger(start) || start < 0 || start % manifest.blockBytes !== 0 || blob.size <= 0 ||
      end > manifest.size || (end !== manifest.size && end % manifest.blockBytes !== 0)) {
    throw new RomIntegrityError('ROM / BIOS 下载分片没有覆盖完整 SHA-256 校验块')
  }
  const first = start / manifest.blockBytes
  const blockCount = Math.ceil(blob.size / manifest.blockBytes)
  const replacements: BlobPart[] = new Array(blockCount)
  let repaired = false
  // 每条下载通道最多同时读两个 2 MiB 块；块完成就补槽，不让一块慢读挡住后续块。
  const concurrency = Math.min(2, blockCount)
  const windowSize = concurrency * 2
  const completed = new Set<number>()
  const windowWaiters = new Set<() => void>()
  const wakeWindowWaiters = () => {
    for (const resolve of windowWaiters) resolve()
    windowWaiters.clear()
  }
  const repairController = new AbortController()
  let nextIndex = 0
  let firstUnfinished = 0
  let failed = false
  let failure: unknown
  let rejectFailure!: (error: unknown) => void
  const failureSignal = new Promise<never>((_, reject) => { rejectFailure = reject })
  void failureSignal.catch(() => {})
  const fail = (error: unknown) => {
    if (failed) return
    failed = true
    failure = error
    repairController.abort(error)
    rejectFailure(error)
    wakeWindowWaiters()
  }
  const onAbort = () => fail(new DOMException('已取消', 'AbortError'))
  try {
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const worker = async () => {
      while (!failed) {
        if (signal?.aborted) {
          fail(new DOMException('已取消', 'AbortError'))
          return
        }
        if (nextIndex >= blockCount) return
        if (nextIndex >= firstUnfinished + windowSize) {
          await new Promise<void>((resolve) => windowWaiters.add(() => resolve()))
          continue
        }
        const localIndex = nextIndex++
        const index = first + localIndex
        try {
          const offset = localIndex * manifest.blockBytes
          const block = blob.slice(offset, Math.min(blob.size, offset + manifest.blockBytes))
          const valid = await (async () => {
            const bytes = new Uint8Array(await block.arrayBuffer())
            if (failed) return false
            return await digest(bytes) === manifest.blocks[index]
          })()
          if (failed) return
          if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
          replacements[localIndex] = valid
            ? block
            : await fetchRepairBlock(rawUrl, manifest, index, repairController.signal)
          if (failed) return
          if (!valid) repaired = true
          completed.add(localIndex)
          const previousFirstUnfinished = firstUnfinished
          while (completed.delete(firstUnfinished)) firstUnfinished++
          if (firstUnfinished !== previousFirstUnfinished) wakeWindowWaiters()
        } catch (error) {
          fail(error)
          return
        }
      }
    }
    await Promise.race([
      Promise.all(Array.from({ length: concurrency }, worker)),
      failureSignal,
    ])
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    if (failed) throw failure
  } catch (error) {
    failed = true
    repairController.abort(error)
    wakeWindowWaiters()
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return repaired ? new Blob(replacements, { type: blob.type }) : blob
}

/** Range 读盘旁路：只接受覆盖完整校验块的对齐请求。其它偏移交由 R2 Worker 校验。 */
export async function verifyRomRange(
  rawUrl: string,
  value: Uint8Array,
  start: number,
  manifest: RomIntegrityManifest,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(start) || start < 0 || start % manifest.blockBytes !== 0 || value.byteLength === 0) {
    throw new RomIntegrityError('Range 读取没有覆盖完整 SHA-256 校验块')
  }
  const first = start / manifest.blockBytes
  for (let offset = 0; offset < value.byteLength; offset += manifest.blockBytes) {
    const index = first + offset / manifest.blockBytes
    const expectedLength = Math.min(manifest.blockBytes, manifest.size - index * manifest.blockBytes)
    const length = Math.min(manifest.blockBytes, value.byteLength - offset)
    if (index >= manifest.blocks.length || length !== expectedLength) throw new RomIntegrityError('Range 与 SHA-256 分块边界不一致')
    if (await digest(value.subarray(offset, offset + length)) !== manifest.blocks[index]) {
      const replacement = await fetchRepairBlock(rawUrl, manifest, index, signal)
      value.set(replacement, offset)
    }
  }
}

/** EmulatorJS 的 fetch 旁路：逐块验流后才交给引擎，额外内存始终不超过一个 2 MiB 块。 */
export async function verifyRomResponse(
  rawUrl: string,
  response: Response,
  signal?: AbortSignal,
  manifestTask?: Promise<RomIntegrityManifest | null>,
): Promise<Response> {
  const key = romIntegrityKey(rawUrl)
  if (!key || response.status === 204 || response.status === 304 || response.status >= 400) return response
  // 旧对象没有完整性标记，不额外等待旁路清单请求，避免它拖慢游戏开局。
  if (response.headers.get('X-8BitGo-Integrity-Required') !== 'sha256-v1') return response
  const manifest = await (manifestTask ?? fetchRomIntegrityManifest(rawUrl, signal))
  if (!manifest) {
    if (response.headers.get('X-8BitGo-Integrity-Required') === 'sha256-v1') {
      void response.body?.cancel().catch(() => {})
      throw new RomIntegrityError('本站已要求校验此 ROM / BIOS，但当前版本没有可用的 SHA-256 清单')
    }
    return response
  }
  if (response.status !== 200 || response.headers.get('Content-Encoding') || response.headers.get('ETag') !== manifest.etag) {
    void response.body?.cancel().catch(() => {})
    throw new RomIntegrityError('ROM / BIOS 响应版本、编码或状态与 SHA-256 清单不匹配')
  }
  const length = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(length) && length > 0 && length !== manifest.size) {
    void response.body?.cancel().catch(() => {})
    throw new RomIntegrityError(`ROM / BIOS 响应长度不符：应为 ${manifest.size}，实际 ${length}`)
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    await verifyRomBytes(rawUrl, bytes, manifest, signal)
    return new Response(bytes, { status: 200, statusText: response.statusText, headers: response.headers })
  }

  const reader = response.body.getReader()
  let index = 0
  let totalReceived = 0
  let totalConsumed = 0
  let used = 0
  let block = new Uint8Array(Math.min(manifest.blockBytes, manifest.size))
  let pending: Uint8Array | null = null
  let pendingOffset = 0
  let sourceDone = false
  const headers = new Headers(response.headers)
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (used < block.byteLength) {
          if (!pending || pendingOffset >= pending.byteLength) {
            const next = await reader.read()
            if (next.done) {
              sourceDone = true
              break
            }
            pending = next.value
            pendingOffset = 0
            totalReceived += pending.byteLength
            if (totalReceived > manifest.size) throw new RomIntegrityError('ROM / BIOS 响应超过清单声明长度')
          }
          const count = Math.min(block.byteLength - used, pending.byteLength - pendingOffset)
          block.set(pending.subarray(pendingOffset, pendingOffset + count), used)
          used += count
          pendingOffset += count
        }
        if (used === block.byteLength) {
          if (await digest(block) !== manifest.blocks[index]) block = await fetchRepairBlock(rawUrl, manifest, index, signal)
          controller.enqueue(block)
          totalConsumed += block.byteLength
          index++
          used = 0
          if (totalConsumed === manifest.size) {
            if ((pending && pendingOffset < pending.byteLength) || totalReceived !== manifest.size) {
              throw new RomIntegrityError('ROM / BIOS 响应含有清单之外的额外字节')
            }
            if (!sourceDone) {
              const extra = await reader.read()
              if (!extra.done) throw new RomIntegrityError('ROM / BIOS 响应超过清单声明长度')
            }
            controller.close()
            reader.releaseLock()
            return
          }
          block = new Uint8Array(Math.min(manifest.blockBytes, manifest.size - totalConsumed))
          return
        }
        if (sourceDone) throw new RomIntegrityError(`ROM / BIOS 下载长度不符：应为 ${manifest.size}，实际 ${totalReceived}`)
      } catch (error) {
        await reader.cancel(error).catch(() => {})
        try { reader.releaseLock() } catch { /* already released */ }
        controller.error(error)
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  })
  // 流已经逐块验证；Content-Length 保留原值供 EJS 进度回调使用。
  return new Response(stream, { status: 200, statusText: response.statusText, headers })
}

/** 下载进度层的统一入口：只对 Worker 明确标记的 ROM / BIOS 等待清单并验证内容。 */
export async function verifyMarkedRomResponse(
  rawUrl: string,
  response: Response,
  signal?: AbortSignal,
  manifestTask?: Promise<RomIntegrityManifest | null>,
): Promise<Response> {
  if (response.headers.get('X-8BitGo-Integrity-Required') !== 'sha256-v1') return response
  const manifest = await (manifestTask ?? fetchRomIntegrityManifest(rawUrl, signal))
  if (!manifest) {
    void response.body?.cancel().catch(() => {})
    throw new RomIntegrityError('本站要求校验此 ROM / BIOS，但 SHA-256 清单不可用')
  }
  return verifyRomResponse(rawUrl, response, signal, Promise.resolve(manifest))
}
