/**
 * 游戏封面 / 预览视频的同源只读代理。
 *
 * PSP 详情页为了 pthread 必须发 COEP: require-corp。对象存储由我们自己补了 CORP，
 * 但后台允许填写完整外链，而百度图床、screenshots.flash.homes 等第三方不会为本站改响应头。
 * 浏览器因此会在下载后把资源拦掉。这里按「slug + cover/video」回查数据库里的原地址，
 * 再由同源接口流给页面；客户端不能提交任意目标 URL，所以它不是一台开放代理。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MEDIA_KINDS = new Set(['cover', 'video'])
const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_PROXIES = 24
const CACHE_CONTROL = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400'

/** IPv4 的保留、内网、回环、链路本地、文档网段与组播地址都不能成为服务端抓取目标。 */
function isPublicIpv4(address) {
  const bytes = address.split('.').map(Number)
  if (bytes.length !== 4 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b, c] = bytes
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

/**
 * DNS 解析结果也要判，而不是只看 URL 字面值：`http://localhost` 好挡，
 * 指向 127.0.0.1 的普通域名若不判解析结果，仍然可以借管理员误填地址打到内网。
 */
export function isPublicMediaAddress(address) {
  const value = String(address || '').trim().toLowerCase()
  const family = isIP(value)
  if (family === 4) return isPublicIpv4(value)
  if (family !== 6) return false

  if (value === '::' || value === '::1') return false
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPublicIpv4(mapped[1])
  if (/^(?:fc|fd)/.test(value)) return false // fc00::/7
  if (/^fe[89ab]/.test(value)) return false // fe80::/10
  if (/^ff/.test(value)) return false // ff00::/8
  if (/^2001:db8(?::|$)/.test(value)) return false // 文档示例网段
  return true
}

function remoteMediaUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    // 游戏媒体没有访问奇怪端口的需要；关掉它也就关掉一大块 SSRF 探测面。
    if (url.port && url.port !== '80' && url.port !== '443') return null
    return url
  } catch {
    return null
  }
}

async function assertPublicUrl(url, lookupImpl) {
  // WHATWG URL 对 IPv6 literal 保留方括号，dns.lookup / net.isIP 都只认里面那段。
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupImpl(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((entry) => !isPublicMediaAddress(entry.address))) {
    throw new Error('外链媒体地址解析到了内网或保留地址')
  }
}

async function fetchWithSafeRedirects(url, init, { fetchImpl, lookupImpl }) {
  let current = url
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicUrl(current, lookupImpl)
    const response = await fetchImpl(current, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response

    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location || redirects === MAX_REDIRECTS) throw new Error('外链媒体重定向次数过多')
    current = new URL(location, current)
    if (!remoteMediaUrl(current.href)) throw new Error('外链媒体重定向到了不允许的协议或端口')
  }
  throw new Error('外链媒体重定向次数过多')
}

function mediaTypeAllowed(kind, value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return kind === 'cover' ? type.startsWith('image/') : type.startsWith('video/')
}

function copyHeader(upstream, res, name) {
  const value = upstream.headers.get(name)
  if (value) res.setHeader(name, value)
}

/**
 * @param {object} options
 * @param {(slug: string) => Promise<{cover?: string, video?: string} | undefined>} options.loadGameMedia
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof lookup} [options.lookupImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxProxies]
 */
export function createGameMediaProxy({
  loadGameMedia,
  fetchImpl = fetch,
  lookupImpl = lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxProxies = DEFAULT_MAX_PROXIES,
}) {
  let activeProxies = 0

  return async function gameMediaProxy(req, res) {
    const kind = String(req.params.kind || '')
    if (!MEDIA_KINDS.has(kind)) return res.status(404).end()

    let game
    try {
      game = await loadGameMedia(String(req.params.slug || ''))
    } catch (error) {
      console.error('[game-media] 读取游戏媒体失败：', error.message)
      return res.status(500).end()
    }
    if (!game) return res.status(404).end()
    if (game.hidden === 1 || game.hidden === true || game.hidden === '1') return res.status(404).end()

    const target = remoteMediaUrl(game[kind])
    // 对象 key / 站内路径不走这里。前端只会给完整外链生成代理 URL，这道检查防止接线漂移。
    if (!target) return res.status(404).end()
    if (activeProxies >= maxProxies) {
      res.setHeader('Retry-After', '1')
      return res.status(503).send('媒体代理繁忙')
    }

    activeProxies++
    const disconnect = new AbortController()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([disconnect.signal, timeout])
    const onClose = () => {
      if (!res.writableEnded) disconnect.abort(new Error('Client disconnected'))
    }
    res.once('close', onClose)

    let upstream = null
    try {
      const headers = {
        accept: kind === 'cover' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : 'video/*,*/*;q=0.8',
        'accept-encoding': 'identity',
        'user-agent': '8BitGo-Media-Proxy/1.0',
      }
      for (const name of ['range', 'if-none-match', 'if-modified-since']) {
        if (req.headers[name]) headers[name] = req.headers[name]
      }

      upstream = await fetchWithSafeRedirects(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        signal,
      }, { fetchImpl, lookupImpl })

      if (upstream.status === 304) {
        res.setHeader('Cache-Control', CACHE_CONTROL)
        copyHeader(upstream, res, 'etag')
        copyHeader(upstream, res, 'last-modified')
        return res.status(304).end()
      }
      if (!upstream.ok && upstream.status !== 206) {
        await upstream.body?.cancel().catch(() => {})
        return res.status(upstream.status === 404 ? 404 : 502).end()
      }

      const contentType = upstream.headers.get('content-type') || ''
      if (!mediaTypeAllowed(kind, contentType)) {
        await upstream.body?.cancel().catch(() => {})
        console.warn(`[game-media] ${target.hostname} 返回了非${kind === 'cover' ? '图片' : '视频'}类型：${contentType || '空'}`)
        return res.status(502).end()
      }

      res.status(upstream.status)
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', CACHE_CONTROL)
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      /*
        外链封面可能是 image/svg+xml。SVG 被直接打开时是一份**同源文档**，里面的 <script>
        能读 localStorage 里的登录 token（管理员浏览器里还有 ADMIN_TOKEN）——第三方图床被黑、
        域名过期被抢注，都能借这条代理在 8bitgo.com 上执行脚本。
        作为 <img> 加载时 SVG 本来就不跑脚本，所以不禁 SVG，只给响应加沙箱 CSP：
        直接导航过去时脚本、表单、同源身份全部失效。
      */
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        copyHeader(upstream, res, name)
      }

      if (req.method === 'HEAD' || !upstream.body) {
        await upstream.body?.cancel().catch(() => {})
        return res.end()
      }
      await pipeline(Readable.fromWeb(upstream.body), res)
    } catch (error) {
      if (disconnect.signal.aborted || res.destroyed) return
      console.error('[game-media] 外链媒体代理失败：', error.message)
      if (!res.headersSent) res.status(timeout.aborted ? 504 : 502).end()
      else res.destroy()
    } finally {
      res.off('close', onClose)
      activeProxies--
    }
  }
}
