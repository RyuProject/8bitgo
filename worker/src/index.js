/**
 * 8BitGo ROM Worker: public GET/HEAD; Bearer-protected PUT/DELETE/list/bulk/multipart.
 * Bucket names, endpoints, JSON success fields and thumbnail fallback are preserved.
 * Full audit / changed semantics are in AUDIT.md. No ROM or BIOS processing here.
 */
import {
  HttpError, json, encoder, positiveInt, declaredLength, readJson, writeBody,
  corsHeaders, authorizedAsync, listAcross, storageFailure, isMissingMultipartUpload,
} from './common.js'
import { parseRange, r2BodyResponseInit, serveObject } from './http.js'
import { handleHtml5, html5Cors, html5Host } from './html5.js'

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

/*
 * 下载域名（download.8bitgo.com，DNS 不走代理、CNAME 到优选域名）上的明文 ROM 转发。
 *
 * 客户端拿开放平台凭据走 /api/open/v1/rom-plain/{grant}，把主机名换成下载域名，
 * 就能借优选线路取明文。凭据校验、按应用 / 按票 / 按 IP 限流、8BG 解密全部留在源站做，
 * Worker 只原样转发 —— 访问控制不因为换了域名而变弱，Worker 也不持有 ROM 密钥。
 *
 * 只放行这三类路径：其它 /api/* 一律 404。下载域名是给客户端取文件用的，
 * 不能变成绕开主站 Cloudflare 规则的整站后门（登录、后台、写接口都不该从这里进）。
 * /api/diag 是主站上本来就公开的只读诊断，留着用来核对源站看到的客户端 IP。
 *
 * 不转发 Cookie / Authorization：凭据在 URL 里，带上登录态只会扩大泄露面。
 * 响应一律不进 Worker 边缘缓存（源站本身回 private, no-store）。
 */
const PLAIN_PROXY_PATH = /^\/api\/open\/v1\/(?:rom-plain\/[^/]+|bundle-plain\/[^/]+\/.+)$|^\/api\/diag$/
const PLAIN_PROXY_HEADER_TIMEOUT_MS = 30_000
const PLAIN_PROXY_FORWARD_HEADERS = [
  'Range', 'If-Range', 'Origin', 'User-Agent', 'Accept',
  'Access-Control-Request-Method', 'Access-Control-Request-Headers',
]

function plainProxyHost(url, env) {
  const hosts = String(env.PLAIN_PROXY_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  return Boolean(env.PLAIN_PROXY_ORIGIN) && hosts.includes(url.hostname.toLowerCase())
}

async function proxyPlainDownload(request, env, url, cors) {
  if (!PLAIN_PROXY_PATH.test(url.pathname)) return json({ error: 'not found' }, cors, 404)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return methodNotAllowed(cors, 'GET, HEAD, OPTIONS')
  const origin = new URL(env.PLAIN_PROXY_ORIGIN)
  const target = new URL(url.pathname + url.search, origin)
  const headers = new Headers({ 'Accept-Encoding': 'identity' })
  for (const name of PLAIN_PROXY_FORWARD_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  // Worker 子请求到源站时 CF-Connecting-IP 会变成 Worker 出口（2026-11-16 实测），
  // 源站按 IP 的限流就成了全员共用一个额度。带上真实客户端 IP 和共享密钥，源站只在
  // 密钥对上时才采信（server/src/download-proxy.js）。没配密钥就不带，源站照旧按出口算。
  const clientIp = request.headers.get('CF-Connecting-IP')
  if (env.PLAIN_PROXY_SECRET && clientIp) {
    headers.set('X-8BitGo-Proxy-Key', env.PLAIN_PROXY_SECRET)
    headers.set('X-8BitGo-Client-IP', clientIp)
  }
  // redirect: manual —— 源站若回 302（例如未来改成预签名直链），交给客户端自己跟，
  // 不在 Worker 里替它跟到别的主机。
  // 只限「等响应头」的时长：源站挂住时以前要等到平台 100 秒上限才断，客户端一直转圈。
  // 响应头到了就清掉定时器，大文件正文不受这个时限影响。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('upstream header timeout')), PLAIN_PROXY_HEADER_TIMEOUT_MS)
  let upstream
  try {
    upstream = await fetch(target, { method: request.method, headers, redirect: 'manual', signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  const out = new Headers(upstream.headers)
  // 下载域名上不给源站种 Cookie：凭据在 URL 里，这条路本来就不该带任何登录态
  out.delete('Set-Cookie')
  out.set('Cache-Control', 'private, no-store')
  out.set('X-8BitGo-Plain-Proxy', '1')
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  })
}

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
/*
 * 卡片预览视频（videos/<slug>.mp4）没有版本号，播放器又只发 Range 请求：既不满足上面的「带版本」
 * 条件，也不在 /roms/ 分片缓存里，于是每次播放都穿透到 R2（大陆实测首字节 16 秒）。
 * 它们和封面一样是可替换的小文件，按同一条 s-maxage=600 短策略缓存整份 200：
 * 完整 GET 走普通边缘缓存；Range 请求命中整份副本就在 Worker 里切片，未命中照常回 R2，
 * 同时在后台把整份写进缓存。超过上限的大视频不缓存，避免把几十 MB 读进 Worker 内存。
 */
/** 整份 200 进边缘缓存的上限（见 fetch 里「写边缘缓存」那段）。 */
const EDGE_FULL_PUT_MAX_BYTES = 64 * 1024 * 1024
/** 缺失封面的负缓存时长：管理员补传后最多晚这么久生效。 */
const MISSING_COVER_TTL_SECONDS = 60
function missingCoverResponse(response) {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', `public, max-age=0, s-maxage=${MISSING_COVER_TTL_SECONDS}`)
  return new Response('{"error":"not found"}', { status: 404, headers })
}
/**
 * romv 只有长得像 R2 ETag（md5 hex，分片上传带 `-N`）时才算内容版本：这种 URL 由
 * versionedRomUrl 按对象 ETag 拼出，Worker 能逐字核对；别的值核对不了，不给长缓存。
 */
const ROMV_ETAG = /^[a-f0-9]{32}(?:-\d+)?$/i
export function romvVersion(url) {
  const romv = url?.searchParams?.get('romv') || ''
  return ROMV_ETAG.test(romv) ? romv : ''
}
function responseMatchesRomv(response, url) {
  const romv = url.searchParams.get('romv')
  if (!romv) return true
  const etag = String(response.headers.get('ETag') || '').replace(/^W\//, '').replaceAll('"', '').trim()
  return Boolean(romvVersion(url)) && etag === romv
}
const PREVIEW_VIDEO_PATH = /^\/videos\/[^/]+\.(?:mp4|webm)$/i
const PREVIEW_VIDEO_CACHE_MAX_BYTES = 32 * 1024 * 1024
const previewVideoFills = new Set()
export function edgeCacheEligible(request, url, cors) {
  if (request.method !== 'GET' || cors['Access-Control-Allow-Origin'] !== '*') return false
  // Cache API 的普通 URL 键只存整份 200；分片必须走下面独立的、带范围的私有键。
  if (request.headers.has('Range')) return false
  if (url.searchParams.has(RANGE_CACHE_PARAM)) return false
  if (request.headers.has('Authorization')) return false
  if (request.headers.has('If-Match') || request.headers.has('If-Unmodified-Since') || request.headers.has('If-Range')) return false
  if (/\b(?:no-cache|no-store)\b/i.test(request.headers.get('Cache-Control') || '')) return false
  // romv 只在形如 ETag 时算版本（且 fetch 写缓存前还要核对响应 ETag 与它一致）。
  const versioned = Boolean(romvVersion(url) || url.searchParams.get('v'))
  /*
   * Sockdrive 不能进 Cache API。线上实测 Cloudflare 在 cache.put/cache.match 后会丢掉 R2 的
   * Content-Encoding，却保留原始 Brotli 字节：MISS 能解码，HIT 则把压缩字节当 JSON / 磁盘块，
   * 新玩家直接黑屏。浏览器自己的 immutable HTTP 缓存仍然生效；这里只放真正按内容哈希命名、
   * 且不依赖 HTTP 内容编码还原语义的 CS16 Zstd 分片。
   */
  const immutablePath = /^\/web\/cs16\/zstd-v1\/chunks\/[a-f0-9]{64}\.zst$/.test(url.pathname)
  return versioned || immutablePath || COVER_IMAGE_PATH.test(url.pathname) || PREVIEW_VIDEO_PATH.test(url.pathname)
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

/** 预览视频的 Range 请求：只收简单单段 Range，带条件头 / 认证 / no-cache 的一律直达 R2 */
function previewVideoRangeKey(request, url, cors) {
  if (request.method !== 'GET' || cors['Access-Control-Allow-Origin'] !== '*') return null
  if (!PREVIEW_VIDEO_PATH.test(url.pathname) || !request.headers.has('Range')) return null
  if (!/^bytes=\d*-\d*$/.test((request.headers.get('Range') || '').trim())) return null
  if (request.headers.has('Authorization') || ['If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'].some(name => request.headers.has(name))) return null
  if (/\b(?:no-cache|no-store)\b/i.test(request.headers.get('Cache-Control') || '')) return null
  return new Request(url.toString(), { method: 'GET' })
}

function cacheablePreviewVideo(response) {
  if (response.status !== 200 || !response.body || response.headers.get('Content-Encoding') || response.headers.has('Content-Range')) return false
  const length = Number(response.headers.get('Content-Length'))
  return Number.isSafeInteger(length) && length > 0 && length <= PREVIEW_VIDEO_CACHE_MAX_BYTES
}

/**
 * 用缓存里的整份视频回答 Range；副本不可用时返回 null，调用方回 R2。
 *
 * 以前是 `await hit.arrayBuffer()` 再切片：每个 Range 请求都把最大 32MB 的整份视频读进
 * Worker 内存，首页一屏几个预览视频同时播放就可能撞上 128MB 的隔离内存上限，
 * 把同一隔离里的其它请求一起带崩。现在边读边丢弃前缀、只转发需要的那段，内存只占一个块。
 */
async function slicedPreviewVideo(hit, rangeHeader) {
  if (!cacheablePreviewVideo(hit)) { await hit.body?.cancel().catch(() => {}); return null }
  const size = Number(hit.headers.get('Content-Length'))
  const range = parseRange(rangeHeader, size)
  const headers = new Headers(hit.headers)
  headers.set('Accept-Ranges', 'bytes')
  if (!range || range.unsatisfiable) {
    // 不能 await：缓存命中的正文可能是 tee 出来的一支，取消要等另一支也结束才落定，会把请求挂住
    hit.body.cancel().catch(() => {})
    headers.set('Content-Range', `bytes */${size}`)
    headers.set('Content-Length', '0')
    return edgeCacheHeader(new Response(null, r2BodyResponseInit(headers, 416)), 'HIT')
  }
  const end = range.offset + range.length - 1
  headers.set('Content-Range', `bytes ${range.offset}-${end}/${size}`)
  headers.set('Content-Length', String(range.length))
  return edgeCacheHeader(new Response(knownLength(sliceStream(hit.body, range.offset, range.length), range.length), r2BodyResponseInit(headers, 206)), 'HIT')
}

/** 从流里跳过 offset 字节、只放出 length 字节，其余直接取消读取 */
export function sliceStream(body, offset, length) {
  const reader = body.getReader()
  let skipped = 0
  let sent = 0
  const finish = (controller) => {
    controller.close()
    reader.cancel().catch(() => {})
  }
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (sent >= length) return finish(controller)
        const { done, value } = await reader.read()
        if (done) return controller.error(new Error('cached preview video is shorter than declared'))
        let chunk = value
        if (skipped < offset) {
          const need = offset - skipped
          if (chunk.byteLength <= need) { skipped += chunk.byteLength; continue }
          chunk = chunk.subarray(need)
          skipped = offset
        }
        const take = Math.min(chunk.byteLength, length - sent)
        controller.enqueue(chunk.subarray(0, take))
        sent += take
        if (sent >= length) finish(controller)
        return
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

/** 让运行时知道正文长度（发 Content-Length 而不是分块编码）；Node 测试环境没有 FixedLengthStream */
function knownLength(stream, length) {
  if (typeof FixedLengthStream === 'undefined') return stream
  const fixed = new FixedLengthStream(length)
  stream.pipeTo(fixed.writable).catch(() => {})
  return fixed.readable
}

/** 后台把整份预览视频写进边缘缓存；同一隔离环境里同一地址只填一次 */
function fillPreviewVideo(edgeCache, key, env, cors, context) {
  if (previewVideoFills.has(key.url)) return
  previewVideoFills.add(key.url)
  context.waitUntil((async () => {
    try {
      const full = await handle(key, env, new URL(key.url), cors)
      if (cacheablePreviewVideo(full)) await edgeCache.put(key, full)
      else await full.body?.cancel().catch(() => {})
    } catch (error) {
      console.warn('[video-cache] fill failed', error instanceof Error ? error.message : String(error))
    } finally {
      previewVideoFills.delete(key.url)
    }
  })())
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
  const versioned = Boolean(romvVersion(url) || url?.searchParams?.get('v'))
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
async function idempotentRequestMarker(key, requestId) {
  const bytes = encoder.encode(JSON.stringify([key, requestId]))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${MULTIPART_PREFIX}v3-${Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')}.marker`
}
async function multipartRequestSignature(contentType, contentEncoding, size, name) {
  const bytes = encoder.encode(JSON.stringify([contentType, contentEncoding || 'identity', size, name]))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
}
async function createMultipart(request, env, key, cors) {
  const meta = await readJson(request, 16 * 1024, true)
  const contentType = typeof meta.contentType === 'string' && meta.contentType ? meta.contentType : guessType(key)
  const contentEncoding = safeContentEncoding(meta.contentEncoding)
  const requestId = meta.requestId === undefined ? '' : String(meta.requestId)
  if (contentType.length > 256 || /[\r\n]/.test(contentType)) throw new HttpError(400, '无效 contentType')
  if (meta.size !== undefined && (!Number.isSafeInteger(Number(meta.size)) || Number(meta.size) < 0)) throw new HttpError(400, '无效 size')
  if (requestId && !/^[a-z0-9_-]{16,128}$/i.test(requestId)) throw new HttpError(400, '无效 requestId')
  const size = Number(meta.size) || 0
  const name = typeof meta.name === 'string' ? meta.name.slice(0, 200) : ''
  const requestSignature = requestId ? await multipartRequestSignature(contentType, contentEncoding, size, name) : ''
  const bucket = bucketForWrite(env, key)
  let marker = ''
  if (requestId) {
    marker = await idempotentRequestMarker(key, requestId)
    const existing = await bucket.head(marker)
    if (existing) {
      const record = existing.customMetadata || {}
      // 创建请求可能已经在 R2 成功、但响应在返回路径上丢失。任务重试时用同一 requestId
      // 找回原会话，避免再开一份 multipart 并把前一份留成隐性残留。
      if (record.key !== key || record.requestId !== requestId || record.requestSignature !== requestSignature || !record.uploadId) {
        throw new HttpError(409, '分片创建幂等标记与请求不匹配，请到 ROM 存储检查残留会话', 'multipart_idempotency_conflict')
      }
      return json({ ok: true, key, uploadId: record.uploadId, marker, requestSignature, maxPartBytes: MAX_PART_BYTES, reused: true }, cors)
    }
  }
  let upload
  try {
    upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType, ...(contentEncoding ? { contentEncoding } : {}), cacheControl: writeCacheControl(env) },
      ...(requestId ? { customMetadata: { '8bitgo-request-id': requestId, '8bitgo-request-signature': requestSignature } } : {}),
    })
  } catch (error) {
    // 让管理员端能区分“创建会话时的临时 R2 故障”和后续分片失败；只有这个明确的
    // Worker 可重试响应才允许客户端重试 POST，避免把未知网关响应当成幂等操作。
    return storageFailure(error, cors, '开始分片上传')
  }
  if (!marker) marker = await deterministicMarker(key, upload.uploadId)
  try {
    // Preserve the original list-with-metadata interface without per-marker GETs.
    const record = { key, uploadId: upload.uploadId,
      ...(requestId ? { requestId, requestSignature } : {}), size,
      name, at: new Date().toISOString() }
    // Local 7,000-byte metadata guard leaves headroom below the documented
    // 8,192-byte object metadata budget. Count UTF-8 bytes, not JS characters.
    const customMetadata = Object.fromEntries(Object.entries(record).map(([k,v]) => [k, String(v)]))
    const metadataBytes = Object.entries(customMetadata).reduce((n, [k,v]) => n + encoder.encode(k).length + encoder.encode(v).length, 0)
    if (metadataBytes > 7000) {
      // Legacy frontends rely on list metadata. Reject before committing an unlistable session.
      throw new HttpError(400, 'key、文件名与分片标识合计过长，请缩短文件名', 'metadata_too_large')
    }
    const storedMarker = await bucket.put(marker, new Uint8Array(0), {
      customMetadata,
      // 同标签页刷新或多个后台窗口可能同时恢复同一账本；先查再写不是原子操作。
      // R2 条件写入保证同一个 requestId 最多只有一个会话成为恢复目标。
      ...(requestId ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
    })
    if (!storedMarker && requestId) {
      let cleanupFailed = false
      try { await upload.abort() } catch { cleanupFailed = true }
      if (cleanupFailed) {
        return json({ ok: false, error: '并发创建会话时未能中止多余会话，请保留 uploadId 进行清理', code: 'multipart_marker_write_failed', key, uploadId: upload.uploadId, marker, retryable: true, cleanupRequired: true }, cors, 503)
      }
      const winner = await bucket.head(marker).catch(() => null)
      const winnerRecord = winner?.customMetadata || {}
      if (winner && winnerRecord.key === key && winnerRecord.requestId === requestId &&
          winnerRecord.requestSignature === requestSignature && winnerRecord.uploadId) {
        return json({ ok: true, key, uploadId: winnerRecord.uploadId, marker, requestSignature, maxPartBytes: MAX_PART_BYTES, reused: true }, cors)
      }
      if (winner) return json({ ok: false, error: '分片创建幂等标记与请求不匹配，请到 ROM 存储检查残留会话', code: 'multipart_idempotency_conflict' }, cors, 409)
      return json({ ok: false, error: '并发创建会话的恢复标记暂时不可读；多余会话已中止，请用同一请求 ID 重试', code: 'multipart_marker_race_lost', retryable: true }, cors, 503)
    }
  } catch (error) {
    let cleanupFailed = false
    try { await upload.abort() } catch { cleanupFailed = true }
    if (!cleanupFailed) {
      try {
        const storedMarker = await bucket.head(marker)
        // 只删回读后仍指向本次 uploadId 的标记，避免并发的同 requestId 请求互删账本。
        if (storedMarker?.customMetadata?.key === key && storedMarker.customMetadata.uploadId === upload.uploadId) {
          await bucket.delete(marker)
        }
      } catch { cleanupFailed = true }
    }
    if (cleanupFailed) {
      return json({ ok: false, error: '标记写入失败且会话或标记清理未确认，请保留返回的 uploadId 进行清理', code: 'multipart_marker_write_failed', key, uploadId: upload.uploadId, marker, retryable: true, cleanupRequired: true }, cors, 503)
    }
    if (error instanceof HttpError) throw error
    return json({ error: '标记写入失败，已中止新建的分片会话', code: 'multipart_marker_write_failed', retryable: true }, cors, 503)
  }
  return json({ ok: true, key, uploadId: upload.uploadId, marker, ...(requestId ? { requestSignature } : {}), maxPartBytes: MAX_PART_BYTES }, cors)
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
  const requestId = body.requestId === undefined ? '' : String(body.requestId)
  const requestSignature = typeof body.requestSignature === 'string' ? body.requestSignature : ''
  const expectedSize = Number(body.size)
  if (requestId && (!/^[a-z0-9_-]{16,128}$/i.test(requestId) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 ||
      (requestSignature && !/^[a-f0-9]{64}$/i.test(requestSignature)))) {
    throw new HttpError(400, '分片完成请求的幂等 ID 或大小无效')
  }
  const normalized = parts.map(p => ({ partNumber: Number(p?.partNumber), etag: typeof p?.etag === 'string' ? p.etag : '' })).sort((a,b) => a.partNumber - b.partNumber)
  if (normalized.some((p, i) => p.partNumber !== i + 1 || !p.etag || p.etag.length > 256 || /[\x00-\x1f\x7f]/.test(p.etag))) {
    throw new HttpError(400, 'parts 必须含连续 partNumber 和有效 etag')
  }
  try {
    const object = await bucketForWrite(env, key).resumeMultipartUpload(key, uploadId).complete(normalized)
    const markerRemoved = await dropMarker(env, key, uploadId, body.marker)
    return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded, markerRemoved }, cors)
  } catch (error) {
    // 同一上传可能由两个恢复中的标签页同时提交；R2 只允许一个 complete 消耗会话，
    // 输家只在最终对象仍带同一请求 ID 且大小匹配时复用成功，绝不把同名新对象误认成本次结果。
    if (requestId && isMissingMultipartUpload(error)) {
      try {
        const object = await bucketForWrite(env, key).head(key)
        if (object?.size === expectedSize && object.customMetadata?.['8bitgo-request-id'] === requestId &&
            requestSignature && object.customMetadata?.['8bitgo-request-signature'] === requestSignature) {
          const markerRemoved = await dropMarker(env, key, uploadId, body.marker)
          return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded, markerRemoved, reused: true }, cors)
        }
      } catch { /* 保留原始 complete 错误，不能把 HEAD 故障说成上传成功。 */ }
    }
    return storageFailure(error, cors, 'complete')
  }
}
async function abortMultipart(env, key, uploadId, marker, cors) {
  try {
    await bucketForWrite(env, key).resumeMultipartUpload(key, uploadId).abort()
  } catch (error) {
    // 只有 R2 明确表示 uploadId 不存在时才继续清标记；其它错误可能仍有分片可续。
    if (!isMissingMultipartUpload(error)) {
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

/**
 * 复用已上传的公开 ZIP 生成私有转换源，避免浏览器把同一份 1GB ZIP 再上行一次。
 * R2 的 GET 与 PUT 都走流；FixedLengthStream 让 R2 知道长度，并在字节数变化时拒绝提交。
 */
async function copyRomToSockdriveStaging(request, env, destination, cors) {
  if (!/^sockdrive-staging\/[a-f0-9-]{16,}\.zip$/i.test(destination)) {
    throw new HttpError(400, '无效的 Sockdrive staging key')
  }
  const body = await readJson(request, 4096)
  const sourceKey = String(body.sourceKey || '').trim()
  const sourceSize = Number(body.sourceSize)
  const sourceEtag = String(body.sourceEtag || '').trim()
  if (!validKey(sourceKey) || !sourceKey.startsWith('roms/') || !/\.zip$/i.test(sourceKey)) {
    throw new HttpError(400, '只允许从公开 ROM ZIP 创建 Sockdrive staging')
  }
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 32 * 1024 || sourceSize > 1900 * 1024 * 1024) {
    throw new HttpError(400, 'ROM ZIP 大小超出 Sockdrive 转换范围')
  }
  if (!/^"[^"\r\n]{1,250}"$/.test(sourceEtag)) throw new HttpError(400, '缺少公开 ROM 的强 ETag')

  const existing = await env.ROMS.head(destination)
  if (existing) {
    const metadata = existing.customMetadata || {}
    if (existing.size === sourceSize && metadata.sockdriveSourceKey === sourceKey && metadata.sockdriveSourceEtag === sourceEtag) {
      return json({ ok: true, key: destination, size: existing.size, etag: existing.httpEtag, reused: true }, cors)
    }
    throw new HttpError(409, '这个 staging key 已被另一份 ZIP 占用')
  }

  const source = await env.ROMS.get(sourceKey, { onlyIf: new Headers({ 'If-Match': sourceEtag }) })
  if (!source) throw new HttpError(404, '完整回退 ZIP 不存在')
  if (!('body' in source)) throw new HttpError(412, '完整回退 ZIP 已变化，请重新上传后再生成流式盘')
  if (source.httpEtag !== sourceEtag) throw new HttpError(412, '完整回退 ZIP 版本不匹配，请重新上传后再生成流式盘')
  if (source.size !== sourceSize) throw new HttpError(409, '完整回退 ZIP 大小与上传结果不一致')

  let copied
  if (typeof FixedLengthStream === 'undefined') {
    // Node 离线测试没有 Workerd 的定长流；生产 Worker 必须走下面的长度校验分支。
    copied = await env.ROMS.put(destination, source.body, {
      httpMetadata: { contentType: 'application/zip' },
      customMetadata: { sockdriveSourceKey: sourceKey, sockdriveSourceEtag: sourceEtag },
      onlyIf: { etagDoesNotMatch: '*' },
    })
  } else {
    const fixed = new FixedLengthStream(source.size)
    const cancel = new AbortController()
    let pumpError
    const pumping = source.body.pipeTo(fixed.writable, { signal: cancel.signal })
      .catch((error) => { pumpError = error })
    try {
      copied = await env.ROMS.put(destination, fixed.readable, {
        httpMetadata: { contentType: 'application/zip' },
        customMetadata: { sockdriveSourceKey: sourceKey, sockdriveSourceEtag: sourceEtag },
        onlyIf: { etagDoesNotMatch: '*' },
      })
      await pumping
      if (pumpError) throw pumpError
    } catch (error) {
      cancel.abort(error)
      if (!fixed.readable.locked) await fixed.readable.cancel(error).catch(() => {})
      await pumping
      throw error
    }
  }
  if (!copied) {
    const raced = await env.ROMS.head(destination)
    const metadata = raced?.customMetadata || {}
    if (raced?.size === sourceSize && metadata.sockdriveSourceKey === sourceKey && metadata.sockdriveSourceEtag === sourceEtag) {
      return json({ ok: true, key: destination, size: raced.size, etag: raced.httpEtag, reused: true }, cors)
    }
    throw new HttpError(409, 'Sockdrive staging 已被并发请求占用')
  }
  if (copied.size !== sourceSize) {
    await env.ROMS.delete(destination)
    throw new HttpError(503, 'Sockdrive staging 复制长度不完整')
  }
  return json({ ok: true, key: destination, size: copied.size, etag: copied.httpEtag, reused: false }, cors)
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
      features: { privateStagingRead: true, contentEncodingUpload: true, sockdriveSourceCopy: true },
      time: new Date().toISOString(),
    }, cors)
  }
  /*
   * 转换源文件只有制作机需要读取。key 虽然带随机 UUID，但“猜不到”不是权限边界；
   * 若继续公开 GET，管理员上传的原始商业镜像会在转换完成前暴露在公开资源域名上。
   */
  const privateStagingRead = ['GET', 'HEAD'].includes(request.method) && /^(?:psp|sockdrive)-staging\//.test(path)
  const admin = privateStagingRead || ['list', 'bulk', 'multipart'].includes(path) || ['PUT', 'POST', 'DELETE'].includes(request.method)
  if (admin && !(await authorizedAsync(request, env))) return json({ error: 'unauthorized' }, cors, 401)
  if (!env.ROMS) throw new HttpError(503, 'ROMS 绑定缺失', 'missing_binding')
  if (path === 'list') {
    if (request.method !== 'GET') return methodNotAllowed(cors, 'GET, OPTIONS')
    return objectList(env, url, cors)
  }
  if (path === 'multipart') return handleMultipartIndex(request, env, url, cors)
  if (request.method === 'POST' && !url.search && /^sockdrive-staging\/[a-f0-9-]{16,}\.zip$/i.test(path)) {
    return copyRomToSockdriveStaging(request, env, path, cors)
  }
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
  /*
   * romv 是对象版本锁。Range 请求一向按 romv 核对；整份 GET / HEAD 只在 romv 形如 ETag 时核对
   * （v 可能是人工发布号或内容哈希，不核）。以前整份 GET 不核：对象替换后 ?romv=旧 拿到新字节，
   * 还按 30 天写进旧版本地址的边缘缓存。
   */
  const objectVersion = request.headers.has('Range') ? (url.searchParams.get('romv') || '') : romvVersion(url)
  return serveObject(request, env, key, cors, cachePolicy(env, url), guessType, objectVersion)
}
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    // 只读素材域名：独立 CORS、只读 WEBGAMES，绝不落进下面的管理接口（见 html5.js）。
    if (html5Host(url, env)) {
      try { return await handleHtml5(request, env, url, context) }
      catch (error) { return storageFailure(error, html5Cors(request, env), 'html5') }
    }
    const cors = corsHeaders(request, env)
    // 必须排在边缘缓存之前：明文是按凭据交付的，绝不能被 Cache API 存下来给下一个人。
    if (plainProxyHost(url, env) && url.pathname.startsWith('/api/')) {
      try { return await proxyPlainDownload(request, env, url, cors) }
      catch (error) {
        console.warn('[plain-proxy] upstream failed', error instanceof Error ? error.message : String(error))
        const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error?.message || ''))
        return json({ error: timedOut ? 'upstream timeout' : 'upstream unavailable' }, cors, timedOut ? 504 : 502, { 'Retry-After': '2' })
      }
    }
    const videoRangeKey = previewVideoRangeKey(request, url, cors)
    const videoCache = videoRangeKey && context?.waitUntil ? globalThis.caches?.default : null
    if (videoCache) {
      try {
        const hit = await videoCache.match(videoRangeKey)
        const sliced = hit && await slicedPreviewVideo(hit, request.headers.get('Range'))
        if (sliced) return sliced
      } catch (error) {
        console.warn('[video-cache] edge match failed', error instanceof Error ? error.message : String(error))
      }
      fillPreviewVideo(videoCache, videoRangeKey, env, cors, context)
    }
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
    const uncacheableVideo = PREVIEW_VIDEO_PATH.test(url.pathname) && !cacheablePreviewVideo(response)
    /*
     * 写边缘缓存靠 response.clone() 把流一分为二：缓存那一路按 R2 速度读，玩家那一路按网速读，
     * 两路的差额全攒在 Worker 内存里。8MB 的 ROM 分片有界；整份对象以前没有上限，
     * 几个慢速玩家同时拉大文件就能撑爆 128MB 的隔离内存。大文件本来就走 8MB Range 分片缓存，
     * 整份 200 只缓存不超过上限的对象；没有 Content-Length 的也不缓存。
     */
    const fullLength = Number(response.headers.get('Content-Length'))
    const tooLargeForFullPut = !Number.isSafeInteger(fullLength) || fullLength > EDGE_FULL_PUT_MAX_BYTES
    if (edgeCache && response.status === 404 && COVER_IMAGE_PATH.test(url.pathname)) {
      // 缺图会让同一页面的每次访问都穿透 R2（缩略图还要按 4 个位置依次找），短暂记住「没有」
      context.waitUntil(
        edgeCache.put(new Request(request.url, { method: 'GET' }), missingCoverResponse(response)).catch((error) => {
          console.warn('[rom-cache] negative put failed', error instanceof Error ? error.message : String(error))
        }),
      )
      return response
    }
    if (edgeCache && response.status === 200 && response.body && !response.headers.has('Content-Range') && !encodedCover && !uncacheableVideo && !tooLargeForFullPut &&
      responseMatchesRomv(response, url)) {
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
