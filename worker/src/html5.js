/**
 * html5.8bitgo.com：网页游戏素材（PvZ、Undertale 授权包…）的只读公开域名，整桶读 WEBGAMES。
 *
 * 以前它是 8bitgo-webgame 桶的 R2 自定义域。NS 迁出 Cloudflare 后，R2 自定义域只能挂在本区域，
 * 而 Cloudflare for SaaS 区域（8bitgo.top）上的 custom hostname 只能经 Worker 读桶，所以这里
 * 原样复刻 R2 自定义域的对外行为（见 deploy/saas/README.md）：
 *
 * - 只读：GET / HEAD / OPTIONS。这个主机名上**绝不能**走 index.js 的管理接口（PUT / DELETE /
 *   list / multipart），否则公开素材域名就多出一条写入口，哪怕要口令也不该在这里出现。
 * - CORS 白名单与桶上的 R2 CORS 策略一致（deploy/cloudflare-pages/undertale-r2-cors.json）：
 *   只认 HTML5_ALLOWED_ORIGINS，按来源反射 ACAO；预检不通过回 403。它只限制浏览器脚本读取，
 *   不是鉴权：素材仍是公开 GET；若内容需要访问控制，必须另加服务端授权或短期签名 URL。
 * - Cache-Control 用对象自己的元数据（PvZ 的内容寻址包是 immutable），没有才给默认的短缓存。
 * - 整份 200 进 Cache API；存进去的副本**不带 CORS 头**，每次按当前请求的 Origin 重新补，
 *   否则 A 来源的 ACAO 会被缓存后发给 B 来源。
 * - 缓存键**去掉查询串**：对象只按路径取，查询串不改变内容；保留它的话任何人用随机 `?x=` 就能
 *   让每个请求都读一次 R2 再写一份最多 64MB 的缓存。代价是 `?v=` 不能再拿来绕开本 Worker 的
 *   边缘缓存（对象被原地替换后最多晚 s-maxage 生效）；需要即时换内容的素材应换路径（PvZ 已是内容寻址）。
 * - 命中缓存时按缓存副本的 ETag / Last-Modified 自己判 If-None-Match / If-Modified-Since，回 304；
 *   默认策略是 must-revalidate，浏览器每 5 分钟都会带条件头来问，不能每次回整份。
 * - 不做封面缩略图回退（缺 foo-96.png 就是 404），也不补 Content-Disposition：R2 自定义域都没有这两样。
 */
import { json } from './common.js'
import { conditionStatus, r2BodyResponseInit, serveObject } from './http.js'

const HTML5_METHODS = 'GET, HEAD'
const HTML5_PREFLIGHT_MAX_AGE = '3000'
const HTML5_EXPOSE_HEADERS = 'ETag, Content-Length, Content-Range, Accept-Ranges'
const HTML5_CORS_HEADER_NAMES = [
  'Access-Control-Allow-Origin', 'Access-Control-Expose-Headers', 'Timing-Allow-Origin',
]
// 和 index.js 的整份缓存上限一致：clone() 两路速度不同，差额攒在 Worker 内存里。
const HTML5_CACHE_MAX_BYTES = 64 * 1024 * 1024
const HTML5_DEFAULT_CACHE_CONTROL = 'public, max-age=300, s-maxage=600, must-revalidate'
const HTML5_FIXED_HOSTS = ['html5.8bitgo.com']

function html5List(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
}

export function html5Host(url, env) {
  // 固定公开域名即使漏配变量也必须进入只读处理；不能因此掉进通用 ROM 管理路由。
  return [...HTML5_FIXED_HOSTS, ...html5List(env.HTML5_HOSTS)]
    .map((h) => h.toLowerCase()).includes(url.hostname.toLowerCase())
}

/** 与 R2 CORS 相同的匹配：精确来源，或 `https://*.example.com` 匹配任意层级子域（不含裸域）。 */
export function html5OriginAllowed(origin, env) {
  if (!origin) return false
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  if (parsed.origin !== origin) return false
  for (const rule of html5List(env.HTML5_ALLOWED_ORIGINS)) {
    if (rule === origin) return true
    const wildcard = /^(https?):\/\/\*\.([a-z0-9.-]+)$/i.exec(rule)
    if (wildcard && parsed.protocol === `${wildcard[1].toLowerCase()}:` &&
      parsed.hostname.toLowerCase().endsWith(`.${wildcard[2].toLowerCase()}`) && !parsed.port) return true
  }
  return false
}

export function html5Cors(request, env) {
  const origin = request.headers.get('Origin') || ''
  const headers = { Vary: 'Origin' }
  if (html5OriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Expose-Headers'] = HTML5_EXPOSE_HEADERS
    headers['Timing-Allow-Origin'] = origin
  }
  return headers
}

function html5WithCors(response, cors, extra = {}) {
  const headers = new Headers(response.headers)
  for (const name of HTML5_CORS_HEADER_NAMES) headers.delete(name)
  for (const [name, value] of Object.entries({ ...cors, ...extra })) headers.set(name, value)
  return new Response(response.body, r2BodyResponseInit(headers, response.status, response.statusText))
}

function html5Preflight(request, env) {
  const origin = request.headers.get('Origin') || ''
  const method = (request.headers.get('Access-Control-Request-Method') || '').toUpperCase()
  if (!html5OriginAllowed(origin, env) || (method && !['GET', 'HEAD'].includes(method))) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } })
  }
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': HTML5_METHODS,
    'Access-Control-Max-Age': HTML5_PREFLIGHT_MAX_AGE,
    Vary: 'Origin',
  }
  const requested = request.headers.get('Access-Control-Request-Headers')
  if (requested) headers['Access-Control-Allow-Headers'] = requested
  return new Response(null, { status: 204, headers })
}

function html5Key(url) {
  let key
  try { key = decodeURIComponent(url.pathname.replace(/^\/+/, '')) } catch { return null }
  if (!key || key.length > 1024 || key.endsWith('/') || key.includes('..') || key.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(key)) return null
  return key
}

/** Cache API 键：只要路径，查询串一律去掉（见文件头）。 */
export function html5CacheKey(url) {
  const key = new URL(url)
  key.search = ''
  key.hash = ''
  return new Request(key.toString(), { method: 'GET' })
}

/** 缓存命中时自己判条件请求；只发和 304 有关的头，正文丢弃。 */
function html5NotModified(hit, request, cors) {
  const etag = hit.headers.get('ETag')
  const lastModified = hit.headers.get('Last-Modified')
  if (!etag && !lastModified) return null
  if (conditionStatus(request.headers, { httpEtag: etag || '', uploaded: lastModified || NaN }) !== 304) return null
  const headers = new Headers(cors)
  for (const name of ['ETag', 'Last-Modified', 'Cache-Control', 'Expires', 'Content-Location']) {
    const value = hit.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('X-8BitGo-Edge-Cache', 'HIT')
  return new Response(null, { status: 304, headers })
}

function html5Cacheable(request) {
  const h = request.headers
  return request.method === 'GET' && !h.has('Range') && !h.has('Authorization') &&
    !h.has('If-Match') && !h.has('If-Unmodified-Since') && !h.has('If-Range') &&
    !/\b(?:no-cache|no-store)\b/i.test(h.get('Cache-Control') || '') &&
    !/\bno-cache\b/i.test(h.get('Pragma') || '')
}

function html5ResponseCacheable(response) {
  const cacheControl = response.headers.get('Cache-Control') || ''
  // Cache API 不会像浏览器 HTTP 缓存那样自动按 Vary 选择变体；未知 Vary 必须绕过，
  // 否则 R2 上带 Accept-Encoding 等变化维度的对象可能把一个请求的表示发给另一个请求。
  return !response.headers.has('Set-Cookie') && !response.headers.has('Vary') &&
    !/\b(?:private|no-store|no-cache)\b/i.test(cacheControl) &&
    !/\b(?:s-maxage|max-age)=\s*0\b/i.test(cacheControl)
}

export async function handleHtml5(request, env, url, context) {
  if (request.method === 'OPTIONS') return html5Preflight(request, env)
  const cors = html5Cors(request, env)
  if (!['GET', 'HEAD'].includes(request.method)) {
    return json({ error: 'method not allowed' }, cors, 405, { Allow: `${HTML5_METHODS}, OPTIONS` })
  }
  if (!env.WEBGAMES) return json({ error: 'WEBGAMES 绑定缺失' }, cors, 503)
  const key = html5Key(url)
  if (!key) return json({ error: 'not found' }, cors, 404)

  const cache = html5Cacheable(request) && context?.waitUntil ? globalThis.caches?.default : null
  const cacheKey = cache ? html5CacheKey(url) : null
  if (cache) {
    try {
      const hit = await cache.match(cacheKey)
      if (hit) {
        const notModified = html5NotModified(hit, request, cors)
        if (notModified) {
          // 不能 await：tee 出来的正文在另一支没结束前 cancel 永不落定（同 index.js 的预览视频）。
          hit.body?.cancel().catch(() => {})
          return notModified
        }
        return html5WithCors(hit, cors, { 'X-8BitGo-Edge-Cache': 'HIT' })
      }
    } catch (error) {
      console.warn('[html5-cache] match failed', error instanceof Error ? error.message : String(error))
    }
  }

  // 只读这一个桶：readBuckets 对 ROMS 以外的绑定一概不看，CS 回退、封面桶都不会被牵进来。
  const response = await serveObject(request, { ROMS: env.WEBGAMES }, key, {}, null, () => 'application/octet-stream', '',
    { thumbFallback: false, disposition: false })
  const headers = new Headers(response.headers)
  if (response.ok && !headers.has('Cache-Control')) headers.set('Cache-Control', HTML5_DEFAULT_CACHE_CONTROL)
  const base = new Response(response.body, r2BodyResponseInit(headers, response.status, response.statusText))

  const length = Number(base.headers.get('Content-Length'))
  if (cache && base.status === 200 && base.body && !base.headers.has('Content-Encoding') && html5ResponseCacheable(base) &&
    Number.isSafeInteger(length) && length <= HTML5_CACHE_MAX_BYTES) {
    context.waitUntil(cache.put(cacheKey, base.clone()).catch((error) => {
      console.warn('[html5-cache] put failed', error instanceof Error ? error.message : String(error))
    }))
    return html5WithCors(base, cors, { 'X-8BitGo-Edge-Cache': 'MISS' })
  }
  if (request.method === 'HEAD' && base.body) {
    await base.body.cancel().catch(() => {})
    return html5WithCors(new Response(null, { status: base.status, headers: base.headers }), cors)
  }
  return html5WithCors(base, cors)
}
