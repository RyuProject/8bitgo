/**
 * 8BitGo ROM Worker: public GET/HEAD; Bearer-protected PUT/DELETE/list/bulk/multipart.
 * Bucket names, endpoints, JSON success fields and thumbnail fallback are preserved.
 * Full audit / changed semantics are in AUDIT.md. No ROM or BIOS processing here.
 */
import {
  HttpError, json, encoder, positiveInt, declaredLength, readJson, writeBody,
  corsHeaders, authorized, listAcross, storageFailure,
} from './common.js'
import { r2BodyResponseInit, serveObject } from './http.js'

const RESERVED = new Set(['', 'ping', 'list', 'multipart', 'bulk'])
const MULTIPART_PREFIX = '_uploads/'
const MAX_PART_BYTES = 32 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
/*
 * 缓存策略分两档，判据是**请求 URL 有没有版本戳** —— 这两类素材在本站的行为完全不同：
 *
 *   带 `?romv=<etag>` / `?v=<…>`：内容寻址。站点拼播放地址时会把对象 ETag 拼进去
 *     （src/services/roms.ts 的 probeRomUrl → src/emulator/romCache.ts 的 romCacheKey），
 *     覆盖 R2 上同一个 key 之后 etag 变、URL 跟着变 —— 所以长缓存是**安全**的。
 *
 *   不带版本戳：可变 key。封面 / 视频 / logo 走的就是这条路（romUrlForKey 只拼
 *     `covers/xxx.webp`），而且后台替换封面时**故意复用同一个 key**（GameForm 里
 *     baseKey 的注释）。这种 URL 给长 max-age 的后果是「管理员换了封面，
 *     玩家半个月看到的还是旧图」，所以只能短缓存 + 重验证。
 *
 * 为什么不是 max-age=0：首页一屏十几张封面（有的还是自动播的视频），每次导航都重验证
 * 会把这些小图拖成一串串行往返，正好抵消掉封面预加载那套优化。300s/600s 这个窗口
 * 能把一次浏览会话里的重复请求全吃掉，同时把「换了封面多久生效」压在 10 分钟以内
 * （浏览器 5 分钟、边缘 10 分钟）。
 *
 * 两档都能用环境变量覆盖（OBJECT_CACHE_CONTROL / VERSIONED_CACHE_CONTROL），
 * 改策略不必改代码重新部署。
 */
const DEFAULT_CACHE_CONTROL = 'public, max-age=300, s-maxage=600, must-revalidate'
const VERSIONED_CACHE_CONTROL = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400'
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable'
const SOCKDRIVE_VERSION_SUFFIX = /(?:^|[-_.])(?:v\d+(?:[-_.][a-z0-9]+)*|[a-f0-9]{8,64})$/i
const ROM_DOWNLOAD_RANGE_BYTES = 8 * 1024 * 1024
const PSP_RANGE_BYTES = 2 * 1024 * 1024
const RANGE_CACHE_PARAM = '__8bg_edge_range'
const RANGE_CACHE_HEADER = 'X-8BitGo-Stored-Range'

/**
 * Sockdrive 的版本在路径里而不在查询串里。只把严格版本目录下的固定产物视为不可变，
 * 避免把同目录的说明文件或误上传内容也永久钉进边缘缓存。
 */
function immutableSockdrivePath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean)
  if (parts.length < 3 || parts[0] !== 'sockdrives') return false
  const file = parts.at(-1)
  const directory = parts.at(-2)
  return SOCKDRIVE_VERSION_SUFFIX.test(directory) &&
    /^(?:sockdrive|preload_ranges)\.metaj$|^(?:preload|\d+)\.raw$/i.test(file)
}
function cacheValue(env, name, fallback) {
  const value = env[name] || fallback
  if (/[\r\n]/.test(value)) throw new HttpError(500, '缓存配置无效', 'invalid_configuration')
  return value
}

/**
 * 只有内容寻址的公开 GET 才进 Worker Cache API。
 *
 * Worker 从 R2 binding 直接返回 Response 时，Cloudflare 不会因为响应里写了
 * `s-maxage` 就自动把它放进边缘缓存；线上一直显示 `CF-Cache-Status: DYNAMIC`
 * 就是这个原因。这里补的是 Worker 自己的 Cache API，而不是再堆一层响应头。
 *
 * 未版本化 URL 原则上不能进来：后台替换同一个 key 后，旧对象会在边缘活到 TTL 结束。
 * `romv` / `v` 是对象 ETag 或内容哈希，内容变了 URL 必然变化，所以可以安全长缓存。
 * CORS 不是 `*` 时也先跳过，避免把某个被允许 Origin 的反射响应给另一个 Origin。
 *
 * 唯一例外是 `covers/` 下的图片。它们没有版本戳，但响应本来就声明了
 * `s-maxage=600`，文件头注释也承诺「换封面 10 分钟内生效」；Cache API 按这条 s-maxage
 * 过期，不会比承诺活得更久。不放进来的代价是线上每张封面每次都回 APAC 的 R2
 * （2026-10-25 单日 1.4 万次，image.8bitgo.com 全部 `CF-Cache-Status: none`），
 * 中国大陆访客还要先绕到 LAX，再跨一次太平洋。视频虽然也在可变 key 上，但它走 Range，
 * 本来就进不了这条整份 200 的缓存路径。
 */
const COVER_IMAGE_PATH = /^\/covers\/.+\.(?:png|jpe?g|webp|avif|gif)$/i
export function edgeCacheEligible(request, url, cors) {
  if (request.method !== 'GET' || cors['Access-Control-Allow-Origin'] !== '*') return false
  // Cache API 的普通 URL 键只存整份 200；分片必须走下面独立的、带范围的私有键。
  if (request.headers.has('Range')) return false
  if (url.searchParams.has(RANGE_CACHE_PARAM)) return false
  if (request.headers.has('Authorization')) return false
  if (request.headers.has('If-Match') || request.headers.has('If-Unmodified-Since') || request.headers.has('If-Range')) return false
  if (/\b(?:no-cache|no-store)\b/i.test(request.headers.get('Cache-Control') || '')) return false
  const versioned = Boolean(url.searchParams.get('romv') || url.searchParams.get('v'))
  /*
   * Sockdrive 不能进 Cache API。线上实测 Cloudflare 在 cache.put/cache.match 后会丢掉 R2 的
   * Content-Encoding，却保留原始 Brotli 字节：MISS 能解码，HIT 则把压缩字节当 JSON / 磁盘块，
   * 新玩家直接黑屏。浏览器自己的 immutable HTTP 缓存仍然生效；这里只放真正按内容哈希命名、
   * 且不依赖 HTTP 内容编码还原语义的 CS16 Zstd 分片。
   */
  const immutablePath = /^\/web\/cs16\/zstd-v1\/chunks\/[a-f0-9]{64}\.zst$/.test(url.pathname)
  return versioned || immutablePath || COVER_IMAGE_PATH.test(url.pathname)
}

/**
 * 完整下载型 ROM 固定请求 8 MiB；PSP / PS2 / Dolphin 这类按需读盘固定请求 2 MiB。
 * Cloudflare Cache API 不能 put(206)，
 * 因此用仅内部访问的 URL 键把验证过的分片存成 200，命中时还原成 206。
 * 没有 ROM 的 R2 ETag 锁、范围不对齐或带条件头时继续直达 R2，避免混合两代 ROM。
 *
 * PSP 必须允许“与 romv 完全相同”的 If-Match：核心每次读盘都会带它。缓存键本身已含同一 ETag，
 * 所以命中仍是同一代不可变字节；若旧版本只有部分块留在 PoP，未命中的块会从 R2 得到 412，
 * 而不是悄悄拼进新镜像。
 */
/**
 * 已核验的 MAME 媒体盘（shared/mame-arcade-media.js 的 mameArcadeDiskObjectKey）：路径里就是 CHD 头的
 * SHA-1，内容寻址、后台禁止原地覆盖。以前它没有 romv，于是既不进分片边缘缓存、也只拿 5 分钟短缓存 ——
 * 每位新玩家都要从 R2 源站拉约 20 片 8MB（160MB），国内访客还要绕洛杉矶。
 */
const MAME_MEDIA_PATH = /^\/roms\/arcade-media\/mame\/([a-f0-9]{40})\/[a-z0-9][a-z0-9_-]{0,63}\.chd$/
export function contentAddressedMediaVersion(pathname) {
  return MAME_MEDIA_PATH.exec(pathname || '')?.[1] || ''
}

function romRangeCachePlan(request, url, cors) {
  if (request.method !== 'GET' || cors['Access-Control-Allow-Origin'] !== '*') return null
  /*
   * 过去只缓存街机 .zip.8bg 与 PSP，导致 NDS / DOS 的 8MB 分片、PS1 / PS2 / Dolphin 的 2MB
   * 光盘块每位玩家都重新穿透到 R2。romv 已把 URL 锁到对象 ETag，范围又必须严格对齐，
   * 所以同一规则可以安全覆盖整个公开 ROM 命名空间；小卡带走普通 200 缓存，不会进这里。
   */
  const blockBytes = /^\/roms\/(?:psx|psp|ps2|gamecube|wii)\//i.test(url.pathname)
    ? PSP_RANGE_BYTES
    : /^\/roms\/[^/]+\/.+/i.test(url.pathname)
      ? ROM_DOWNLOAD_RANGE_BYTES
      : 0
  if (!blockBytes || url.searchParams.has(RANGE_CACHE_PARAM)) return null
  if (request.headers.has('Authorization') || ['If-Range', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'].some(name => request.headers.has(name))) return null
  if (/\b(?:no-cache|no-store)\b/i.test(request.headers.get('Cache-Control') || '')) return null
  const contentVersion = contentAddressedMediaVersion(url.pathname)
  const version = url.searchParams.get('romv') || contentVersion
  const contentAddressed = Boolean(contentVersion) && !url.searchParams.get('romv')
  if (!contentAddressed && !/^[a-f0-9]{32}(?:-\d+)?$/i.test(version)) return null
  const ifMatch = request.headers.get('If-Match')
  if (ifMatch && !contentAddressed && ifMatch !== `"${version}"`) return null
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') || '')
  if (!match) return null
  const start = Number(match[1]); const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start % blockBytes !== 0 || end < start || end - start + 1 > blockBytes) return null
  const cacheUrl = new URL(url)
  cacheUrl.searchParams.set(RANGE_CACHE_PARAM, `${start}-${end}`)
  return { key: new Request(cacheUrl, { method: 'GET' }), version, start, end, blockBytes, contentAddressed }
}

function verifiedRangeHeaders(response, plan, stored = false) {
  if (response.status !== (stored ? 200 : 206) || response.headers.get('Content-Encoding')) return null
  // 内容寻址的媒体盘：身份是路径里的 SHA-1，不靠 R2 ETag（它们没有 romv 可比）
  if (!plan.contentAddressed && response.headers.get('ETag') !== `"${plan.version}"`) return null
  const value = response.headers.get(stored ? RANGE_CACHE_HEADER : 'Content-Range') || ''
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
  if (!match) return null
  const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3])
  const length = end - start + 1
  // 非末片只收满平台约定块，防止任意短 Range 为同一 ROM 制造海量边缘缓存键。
  if (plan.end - plan.start + 1 < plan.blockBytes && plan.end !== total - 1) return null
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(end) || start !== plan.start || end !== Math.min(plan.end, total - 1) || length <= 0 || length > plan.blockBytes || response.headers.get('Content-Length') !== String(length)) return null
  return value
}

function restoredRangeResponse(hit, contentRange) {
  const headers = new Headers(hit.headers)
  headers.delete(RANGE_CACHE_HEADER)
  headers.set('Content-Range', contentRange)
  return edgeCacheHeader(new Response(hit.body, r2BodyResponseInit(headers, 206)), 'HIT')
}

function rangeCacheResponse(response, contentRange) {
  const headers = new Headers(response.headers)
  headers.delete('Content-Range')
  headers.set(RANGE_CACHE_HEADER, contentRange)
  return new Response(response.clone().body, r2BodyResponseInit(headers))
}

function edgeCacheHeader(response, value) {
  const headers = new Headers(response.headers)
  headers.set('X-8BitGo-Edge-Cache', value)
  // Zstd 分片的媒体类型本身就声明压缩格式；重新包装响应时保留 manual，避免出口二次压缩。
  return new Response(response.body, r2BodyResponseInit(headers, response.status, response.statusText))
}
/** 写对象元数据时用的策略；读的时候还会按请求 URL 再判一次（见 cachePolicy） */
function writeCacheControl(env) { return cacheValue(env, 'OBJECT_CACHE_CONTROL', DEFAULT_CACHE_CONTROL) }
/**
 * 响应用的策略。
 * ⚠️ 只能从**请求 URL** 上判版本戳，不能只看 key —— romv 是客户端按 ETag 自己拼上去的，
 * 服务端在不 HEAD 一次的前提下无法从 key 推断内容版本。
 */
export function cachePolicy(env, url) {
  // CS16 分片的路径本身就是压缩字节 SHA-256；它不会被原地替换，可以安全缓存一年。
  if (
    /^\/web\/cs16\/zstd-v1\/chunks\/[a-f0-9]{64}\.zst$/.test(url?.pathname || '') ||
    immutableSockdrivePath(url?.pathname || '') ||
    contentAddressedMediaVersion(url?.pathname || '')
  ) {
    return cacheValue(env, 'IMMUTABLE_CACHE_CONTROL', IMMUTABLE_CACHE_CONTROL)
  }
  const versioned = Boolean(url?.searchParams?.get('romv') || url?.searchParams?.get('v'))
  return versioned
    ? cacheValue(env, 'VERSIONED_CACHE_CONTROL', VERSIONED_CACHE_CONTROL)
    : cacheValue(env, 'OBJECT_CACHE_CONTROL', DEFAULT_CACHE_CONTROL)
}
const MIME = {
  zip: 'application/zip', '7z': 'application/x-7z-compressed', '8bg': 'application/x-8bitgo-rom',
  swf: 'application/x-shockwave-flash', json: 'application/json', txt: 'text/plain; charset=utf-8',
  webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm',
  zst: 'application/zstd',
}
function guessType(key) { return MIME[key.split('.').pop()?.toLowerCase()] || 'application/octet-stream' }
function maxUploadBytes(env) { return positiveInt(env.MAX_UPLOAD_MB, 512, 5 * 1024 * 1024) * 1024 * 1024 }
function isCoverKey(key) { return key.startsWith('covers/') }
function bucketForWrite(env, key) { return isCoverKey(key) && env.COVERS ? env.COVERS : env.ROMS }
function allBuckets(env) {
  return [{ name: 'ROMS', bucket: env.ROMS }, ...(env.COVERS && env.COVERS !== env.ROMS ? [{ name: 'COVERS', bucket: env.COVERS }] : [])]
}
function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && encoder.encode(key).length <= 1024 &&
    !key.includes('..') && !key.includes('\\') && !key.startsWith('/') && !key.endsWith('/') &&
    !key.startsWith(MULTIPART_PREFIX) && !/[\x00-\x1f\x7f]/.test(key)
}
function markerKeyValid(key) {
  return typeof key === 'string' && key.startsWith(MULTIPART_PREFIX) && encoder.encode(key).length <= 1024 &&
    !/[\x00-\x1f\x7f\\]/.test(key) && !key.includes('..') && !key.endsWith('/')
}
function validUploadId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 2048 && !/[\x00-\x20\x7f]/.test(id)
}
function safeContentEncoding(value) {
  const encoding = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!encoding || encoding === 'identity') return undefined
  if (encoding === 'br' || encoding === 'gzip') return encoding
  throw new HttpError(400, 'contentEncoding 只能是 br、gzip 或 identity')
}
function methodNotAllowed(cors, allow) {
  return json({ error: 'method not allowed' }, cors, 405, { Allow: allow })
}
async function objectList(env, url, cors) {
  const prefix = url.searchParams.get('prefix') || ''
  if (encoder.encode(prefix).length > 1024 || /[\x00-\x1f\x7f]/.test(prefix)) throw new HttpError(400, '无效 prefix')
  const page = await listAcross(allBuckets(env), { prefix: prefix || undefined, limit: 1000 }, url.searchParams.get('cursor'), `objects:${prefix}`)
  // Each physical object has a bucket identity. Same key in two buckets is not one object.
  const objects = page.entries.filter(({ object }) => !object.key.startsWith(MULTIPART_PREFIX))
    .map(({ object: o, bucket }) => ({ key: o.key, size: o.size, uploaded: o.uploaded, bucket }))
  return json({ objects, truncated: page.truncated, cursor: page.cursor }, cors)
}
/** Delete the logical cover from both read buckets, so a legacy copy cannot reappear. */
async function deleteKeys(env, keys) {
  const jobs = []
  const romKeys = [...keys] // all ROMs plus legacy cover copies
  if (romKeys.length) jobs.push({ bucket: env.ROMS, keys: romKeys })
  const coverKeys = keys.filter(isCoverKey)
  if (env.COVERS && env.COVERS !== env.ROMS && coverKeys.length) jobs.push({ bucket: env.COVERS, keys: coverKeys })
  const results = await Promise.allSettled(jobs.map(j => j.bucket.delete(j.keys)))
  const failed = new Set()
  results.forEach((r, i) => { if (r.status === 'rejected') jobs[i].keys.forEach(key => failed.add(key)) })
  return { deleted: keys.filter(key => !failed.has(key)), failed: [...failed] }
}
async function deleteResponse(env, keys, cors, bulk) {
  const result = await deleteKeys(env, keys)
  if (result.failed.length) {
    return json({ ok: false, ...result, retryable: true, error: '部分桶删除失败；仅重试 failed 中的 key。跨桶删除不是事务。' }, cors, 503, { 'Retry-After': '2' })
  }
  return json(bulk ? { ok: true, deleted: result.deleted } : { ok: true, key: keys[0] }, cors)
}
async function deterministicMarker(key, uploadId) {
  const bytes = encoder.encode(JSON.stringify([key, uploadId]))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${MULTIPART_PREFIX}v2-${Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')}.marker`
}
async function createMultipart(request, env, key, cors) {
  const meta = await readJson(request, 16 * 1024, true)
  const contentType = typeof meta.contentType === 'string' && meta.contentType ? meta.contentType : guessType(key)
  const contentEncoding = safeContentEncoding(meta.contentEncoding)
  if (contentType.length > 256 || /[\r\n]/.test(contentType)) throw new HttpError(400, '无效 contentType')
  if (meta.size !== undefined && (!Number.isSafeInteger(Number(meta.size)) || Number(meta.size) < 0)) throw new HttpError(400, '无效 size')
  const bucket = bucketForWrite(env, key)
  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType, ...(contentEncoding ? { contentEncoding } : {}), cacheControl: writeCacheControl(env) },
  })
  const marker = await deterministicMarker(key, upload.uploadId)
  try {
    // Preserve the original list-with-metadata interface without per-marker GETs.
    const record = { key, uploadId: upload.uploadId, size: Number(meta.size) || 0,
      name: typeof meta.name === 'string' ? meta.name.slice(0, 200) : '', at: new Date().toISOString() }
    // Local 7,000-byte metadata guard leaves headroom below the documented
    // 8,192-byte object metadata budget. Count UTF-8 bytes, not JS characters.
    const customMetadata = Object.fromEntries(Object.entries(record).map(([k,v]) => [k, String(v)]))
    const metadataBytes = Object.entries(customMetadata).reduce((n, [k,v]) => n + encoder.encode(k).length + encoder.encode(v).length, 0)
    if (metadataBytes > 7000) {
      // Legacy frontends rely on list metadata. Reject before committing an unlistable session.
      throw new HttpError(400, 'key、文件名与分片标识合计过长，请缩短文件名', 'metadata_too_large')
    }
    await bucket.put(marker, new Uint8Array(0), { customMetadata })
  } catch (error) {
    let cleanupFailed = false
    try { await upload.abort() } catch { cleanupFailed = true }
    if (cleanupFailed) {
      return json({ ok: false, error: '标记写入失败且分片中止失败，请保留返回的 uploadId 进行清理', key, uploadId: upload.uploadId, marker, retryable: true, cleanupRequired: true }, cors, 503)
    }
    if (error instanceof HttpError) throw error
    return json({ error: '标记写入失败，已中止新建的分片会话', retryable: true }, cors, 503)
  }
  return json({ ok: true, key, uploadId: upload.uploadId, marker, maxPartBytes: MAX_PART_BYTES }, cors)
}
async function uploadPart(request, env, key, uploadId, url, cors) {
  const partNumber = Number(url.searchParams.get('partNumber'))
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new HttpError(400, 'partNumber 必须是 1..10000 的整数')
  if (declaredLength(request, MAX_PART_BYTES) === 0 || !request.body) throw new HttpError(400, 'empty part')
  try {
    const upload = bucketForWrite(env, key).resumeMultipartUpload(key, uploadId)
    const part = await writeBody(request, MAX_PART_BYTES, async body => {
      if (body.byteLength === 0) throw new HttpError(400, 'empty part')
      return upload.uploadPart(partNumber, body)
    })
    return json({ ok: true, partNumber: part.partNumber, etag: part.etag }, cors)
  } catch (error) { return storageFailure(error, cors, 'uploadPart') }
}
async function completeMultipart(request, env, key, uploadId, cors) {
  const body = await readJson(request, MAX_JSON_BYTES)
  const parts = body.parts
  if (!Array.isArray(parts) || !parts.length || parts.length > 10000) throw new HttpError(400, 'body 需要 1..10000 个 parts')
  const normalized = parts.map(p => ({ partNumber: Number(p?.partNumber), etag: typeof p?.etag === 'string' ? p.etag : '' })).sort((a,b) => a.partNumber - b.partNumber)
  if (normalized.some((p, i) => p.partNumber !== i + 1 || !p.etag || p.etag.length > 256 || /[\x00-\x1f\x7f]/.test(p.etag))) {
    throw new HttpError(400, 'parts 必须含连续 partNumber 和有效 etag')
  }
  try {
    const object = await bucketForWrite(env, key).resumeMultipartUpload(key, uploadId).complete(normalized)
    const markerRemoved = await dropMarker(env, key, uploadId, body.marker)
    return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded, markerRemoved }, cors)
  } catch (error) { return storageFailure(error, cors, 'complete') }
}
async function abortMultipart(env, key, uploadId, marker, cors) {
  try {
    await bucketForWrite(env, key).resumeMultipartUpload(key, uploadId).abort()
  } catch (error) {
    // A failure is not evidence of absence. Retain the marker unless explicitly NoSuchUpload.
    const message = error instanceof Error ? error.message : String(error)
    if (error?.code !== 'NoSuchUpload' && !/\bNoSuchUpload\b/i.test(message)) {
      return json({ ok: false, key, aborted: false, markerRemoved: false, fatal: false, retryable: true, error: '中止未确认成功，续传标记已保留，请重试' }, cors, 503, { 'Retry-After': '2' })
    }
  }
  const markerRemoved = await dropMarker(env, key, uploadId, marker)
  return json({ ok: markerRemoved, key, aborted: true, markerRemoved, ...(markerRemoved ? {} : { retryable: true, error: '分片已中止，但标记清理未完成' }) }, cors, markerRemoved ? 200 : 503)
}
async function handleMultipartIndex(request, env, url, cors) {
  if (request.method === 'DELETE') {
    const marker = url.searchParams.get('marker') || ''
    if (!markerKeyValid(marker)) throw new HttpError(400, 'bad marker')
    // Explicit administrator operation: remove marker ONLY, do not claim to abort parts.
    await Promise.all(allBuckets(env).map(b => b.bucket.delete(marker)))
    return json({ ok: true, marker, markerOnly: true }, cors)
  }
  if (request.method !== 'GET') return methodNotAllowed(cors, 'GET, DELETE, OPTIONS')
  const page = await listAcross(allBuckets(env), { prefix: MULTIPART_PREFIX, limit: 1000, include: ['customMetadata'] }, url.searchParams.get('cursor'), 'multipart')
  const uploads = page.entries.map(({ object: o, bucket }) => {
    const m = o.customMetadata || {}
    return { marker: o.key, key: m.key || '', uploadId: m.uploadId || '', size: Number(m.size) || 0, name: m.name || '', at: m.at || o.uploaded, bucket }
  }).sort((a,b) => String(b.at).localeCompare(String(a.at)))
  return json({ uploads, truncated: page.truncated, cursor: page.cursor }, cors)
}
/** Fast v2 cleanup, validated supplied legacy marker, then bounded paginated legacy scan. */
async function dropMarker(env, key, uploadId, supplied) {
  try {
    const bucket = bucketForWrite(env, key)
    const deterministic = await deterministicMarker(key, uploadId)
    const candidates = [...new Set([deterministic, ...(markerKeyValid(supplied) ? [supplied] : [])])]
    for (const candidate of candidates) {
      const object = await bucket.head(candidate)
      if (!object) continue
      if (object.customMetadata?.key !== key || object.customMetadata?.uploadId !== uploadId) continue
      await bucket.delete(candidate)
      return true
    }
    // Old random-marker clients may not send the marker. Follow all pages up to a
    // request budget; NEVER pretend a capped scan proved no marker exists.
    let pages = 0
    for (const { bucket: b } of allBuckets(env)) {
      let cursor
      do {
        if (++pages > 24) return false
        const page = await b.list({ prefix: MULTIPART_PREFIX, cursor, limit: 1000, include: ['customMetadata'] })
        const hit = page.objects.find(o => o.customMetadata?.key === key && o.customMetadata?.uploadId === uploadId)
        if (hit) { await b.delete(hit.key); return true }
        if (page.truncated && (!page.cursor || page.cursor === cursor)) return false
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    }
    return true
  } catch { return false }
}
async function handle(request, env, url, cors) {
  if (request.method === 'OPTIONS') {
    if (request.headers.has('Origin') && !cors['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, cors, 403)
    return new Response(null, { status: 204, headers: cors })
  }
  let path
  try { path = decodeURIComponent(url.pathname.replace(/^\/+/, '')) }
  catch { throw new HttpError(400, 'URL 路径编码无效', 'invalid_path') }
  if (path === '' || path === 'ping') {
    if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed(cors, 'GET, HEAD, OPTIONS')
    return json({
      ok: true,
      service: '8bitgo-roms',
      writable: Boolean(env.ADMIN_TOKEN),
      multipart: true,
      // 制作机在启用自动队列前会检查这两个能力；旧 Worker 不会误接收随后必坏的 Brotli 产物。
      features: { privateStagingRead: true, contentEncodingUpload: true },
      time: new Date().toISOString(),
    }, cors)
  }
  /*
   * 转换源文件只有制作机需要读取。key 虽然带随机 UUID，但“猜不到”不是权限边界；
   * 若继续公开 GET，管理员上传的原始商业镜像会在转换完成前暴露在公开资源域名上。
   */
  const privateStagingRead = ['GET', 'HEAD'].includes(request.method) && /^(?:psp|sockdrive)-staging\//.test(path)
  const admin = privateStagingRead || ['list', 'bulk', 'multipart'].includes(path) || ['PUT', 'POST', 'DELETE'].includes(request.method)
  if (admin && !authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
  if (!env.ROMS) throw new HttpError(503, 'ROMS 绑定缺失', 'missing_binding')
  if (path === 'list') {
    if (request.method !== 'GET') return methodNotAllowed(cors, 'GET, OPTIONS')
    return objectList(env, url, cors)
  }
  if (path === 'multipart') return handleMultipartIndex(request, env, url, cors)
  if (path === 'bulk') {
    if (request.method !== 'POST') return methodNotAllowed(cors, 'POST, OPTIONS')
    const body = await readJson(request, MAX_JSON_BYTES)
    if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 1000 || body.keys.some(k => !validKey(k))) {
      throw new HttpError(400, 'keys 必须是 1..1000 个合法对象 key')
    }
    return deleteResponse(env, [...new Set(body.keys)], cors, true)
  }
  if (RESERVED.has(path) || !validKey(path)) return json({ error: 'not found' }, cors, 404)
  const key = path
  const hasUploadId = url.searchParams.has('uploadId')
  const uploadId = url.searchParams.get('uploadId')
  const startsUpload = url.searchParams.has('uploads')
  const hasPart = url.searchParams.has('partNumber')
  const hasMarker = url.searchParams.has('marker')
  for (const parameter of ['uploadId', 'uploads', 'partNumber', 'marker']) {
    if (url.searchParams.getAll(parameter).length > 1) throw new HttpError(400, '分片参数不能重复')
  }
  if (hasUploadId && !validUploadId(uploadId)) throw new HttpError(400, '无效 uploadId')
  // A malformed multipart request must NEVER fall through to single PUT/DELETE:
  // missing uploadId could otherwise overwrite a final object with one part, or delete it.
  if (startsUpload && (request.method !== 'POST' || hasUploadId || hasPart || hasMarker)) throw new HttpError(400, 'uploads 仅可用于创建分片会话')
  if (hasPart && (!hasUploadId || request.method !== 'PUT')) throw new HttpError(400, 'partNumber 需要 PUT 与有效 uploadId')
  if (hasMarker && (!hasUploadId || request.method !== 'DELETE')) throw new HttpError(400, 'marker 需要 DELETE 与有效 uploadId')
  if (hasUploadId && !['POST', 'PUT', 'DELETE'].includes(request.method)) throw new HttpError(400, 'uploadId 不适用于此请求方法')
  if (request.method === 'POST') {
    if (url.searchParams.has('uploads')) return createMultipart(request, env, key, cors)
    if (uploadId) return completeMultipart(request, env, key, uploadId, cors)
    throw new HttpError(400, 'POST 需要 ?uploads 或 ?uploadId=')
  }
  if (request.method === 'PUT' && uploadId) return uploadPart(request, env, key, uploadId, url, cors)
  if (request.method === 'DELETE' && uploadId) return abortMultipart(env, key, uploadId, url.searchParams.get('marker'), cors)
  if (request.method === 'PUT') {
    const limit = maxUploadBytes(env)
    const contentType = request.headers.get('Content-Type') || guessType(key)
    const contentEncoding = safeContentEncoding(request.headers.get('Content-Encoding'))
    // Unknown-length single uploads are bounded to 32 MiB. Larger uploads should
    // supply Content-Length or use the existing multipart endpoint, not allocate 512 MiB.
    const object = await writeBody(request, limit, body => bucketForWrite(env, key).put(key, body, {
      httpMetadata: { contentType, ...(contentEncoding ? { contentEncoding } : {}), cacheControl: writeCacheControl(env) },
    }), Math.min(limit, MAX_PART_BYTES))
    return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded }, cors)
  }
  if (request.method === 'DELETE') return deleteResponse(env, [key], cors, false)
  if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed(cors, 'GET, HEAD, PUT, POST, DELETE, OPTIONS')
  // 只把 romv 当 Range 对象版本锁；普通 GET 的 v/romv 还可能是人工发布号或内容哈希。
  const rangeVersion = request.headers.has('Range') ? (url.searchParams.get('romv') || '') : ''
  return serveObject(request, env, key, cors, cachePolicy(env, url), guessType, rangeVersion)
}
export default {
  async fetch(request, env, context) {
    const cors = corsHeaders(request, env)
    const url = new URL(request.url)
    const rangePlan = romRangeCachePlan(request, url, cors)
    let edgeCache = (edgeCacheEligible(request, url, cors) || rangePlan) && context?.waitUntil
      ? globalThis.caches?.default
      : null
    if (edgeCache) {
      try {
        const hit = await edgeCache.match(rangePlan?.key || request)
        if (hit && !rangePlan) return edgeCacheHeader(hit, 'HIT')
        if (hit && rangePlan) {
          const contentRange = verifiedRangeHeaders(hit, rangePlan, true)
          if (contentRange) return restoredRangeResponse(hit, contentRange)
          // 旧缓存或错误对象不能冒充 206；让 R2 重新校验版本并填充正确分片。
          await hit.body?.cancel().catch(() => {})
        }
      } catch (error) {
        // 边缘缓存是加速层，不是可用性依赖；某个 PoP 的 cache.match 故障时仍要回 R2。
        console.warn('[rom-cache] edge match failed', error instanceof Error ? error.message : String(error))
        edgeCache = null
      }
    }
    let response
    try { response = await handle(request, env, url, cors) }
    catch (error) { response = storageFailure(error, cors) }
    const rangeContent = rangePlan && verifiedRangeHeaders(response, rangePlan)
    if (edgeCache && rangePlan && rangeContent) {
      context.waitUntil(
        edgeCache.put(rangePlan.key, rangeCacheResponse(response, rangeContent)).catch((error) => {
          console.warn('[rom-cache] range put failed', error instanceof Error ? error.message : String(error))
        }),
      )
      return edgeCacheHeader(response, 'MISS')
    }
    // 分片上传允许封面带 Content-Encoding；Cache API 会丢掉这个头却保留压缩字节（见上面
    // Sockdrive 那段），这种封面宁可每次回 R2，也不能让 HIT 吐出一张解不开的图。
    const encodedCover = COVER_IMAGE_PATH.test(url.pathname) && response.headers.has('Content-Encoding')
    if (edgeCache && response.status === 200 && response.body && !response.headers.has('Content-Range') && !encodedCover) {
      // clone 后立刻回玩家；75 MB 的 NDS ROM 写边缘缓存不能挡住首包。
      const cacheKey = new Request(request.url, { method: 'GET' })
      context.waitUntil(
        edgeCache.put(cacheKey, response.clone()).catch((error) => {
          console.warn('[rom-cache] edge put failed', error instanceof Error ? error.message : String(error))
        }),
      )
      return edgeCacheHeader(response, 'MISS')
    }
    // HEAD responses (including errors and /ping) MUST NOT contain a body.
    if (request.method === 'HEAD' && response.body) {
      try { await response.body.cancel() } catch { /* already closed */ }
      return new Response(null, { status: response.status, headers: response.headers })
    }
    return response
  },
}
