/**
 * reVCDOS 托管 Worker —— 用来替掉仓库自带的 server.py / index.php。
 *
 * 那份 Python 后端（FastAPI）其实只干三件事，全都是 Worker 的本职：
 *
 *   1. 把 dist/ 当静态站点发出去
 *   2. 给 HTML 加 COOP / COEP 两个头（游戏要 SharedArrayBuffer，少一个就白屏）
 *   3. 把 /vcsky/ 与 /vcbr/ 反代到 DOS Zone 的 CDN
 *
 * 带不过来的是那几个开关：`--packed`（brotli 的自定义档格式，Worker 没有 brotli 解压）、
 * `--vcsky_cache` / `--unpacked`（要往磁盘写，Worker 没有文件系统）、
 * `--custom_saves`（要存档目录，得改成 R2 或 KV）。
 * dos.zone 被 DMCA 之后页面已经改成「玩家自备游戏数据」，前两个基本用不上了；
 * 存档要留的话见 README。
 *
 * ## 为什么非得反代，不能让前端直连 cdn.dos.zone
 *
 * 因为 COEP: require-corp。开了它之后，页面里所有**跨源**且没带
 * Cross-Origin-Resource-Policy 头的资源会被浏览器直接拦掉，而 cdn.dos.zone 不是我们的、
 * 加不了那个头。反代一遍之后这些请求变成同源，问题就不存在了 ——
 * 这也正是上游 server.py 要做这个代理的原因，别以为它只是图方便。
 */

/** 只读站点，其它方法一律拒掉，免得被当成开放代理 */
const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * 需要原样转发给上游的请求头。
 * Range 必须转 —— 游戏数据是大文件，前端靠分段拉取，丢了它会退化成每次整包下载。
 */
const FORWARD_HEADERS = ['range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding']

/** 从上游响应里剥掉的头：这些由我们自己决定，或者是 hop-by-hop 的 */
const STRIP_HEADERS = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'content-security-policy',
  'x-frame-options',
])

function basePath(env) {
  const p = (env.BASE_PATH ?? '').trim()
  if (!p || p === '/') return ''
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * 把挂载前缀从路径上剥掉。
 * 同源方案下浏览器请求的是 /embed/vc/index.html，而静态资源里的 key 是 /index.html。
 */
function stripBase(pathname, base) {
  if (!base) return pathname
  if (pathname === base) return '/'
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname
}

/**
 * 反代一条游戏资源。
 *
 * 用 fetch 的 cf.cacheEverything 让 Cloudflare 边缘替我们缓存，而不是自己操作 Cache API：
 * Range 请求和手动 Cache API 配起来很容易出错（缓存住一个 206 再拿去回别的区间），
 * 交给边缘处理最省事也最不容易错。
 *
 * ⚠️ cf.cacheEverything 只在 Worker 挂在**某个域名（zone）的路由**上时生效，
 * workers.dev 的地址上会被忽略 —— 那时每次请求都会真的打到上游去。上线记得挂路由。
 */
async function proxy(request, upstreamBase, rest, ttl) {
  const url = new URL(rest, upstreamBase)
  const headers = new Headers()
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }

  const upstream = await fetch(url.toString(), {
    method: request.method,
    headers,
    redirect: 'follow',
    cf: { cacheEverything: true, cacheTtl: ttl },
  })

  const out = new Headers()
  for (const [k, v] of upstream.headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out.set(k, v)
  }
  // 同源资源，不需要 CORP；但明确写一句省得以后换成子域名时忘了
  out.set('Cross-Origin-Resource-Policy', 'same-origin')
  out.set('Cache-Control', `public, max-age=${ttl}, immutable`)

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
}

/**
 * 给 HTML 补上隔离头，并在有挂载前缀时注入 <base>。
 *
 * <base> 只救得了**相对**路径。reVCDOS 的前端如果请求的是根绝对路径（/vcsky/... 这种，
 * 上游 server.py 就是把它们挂在根上的），<base> 管不着 —— 那些路径必须在
 * Cloudflare 路由里单独指过来，见 README 的「路由必须对齐」。
 */
async function decorateHtml(response, base) {
  const headers = new Headers(response.headers)
  /**
   * 这两个头是全部关键。SharedArrayBuffer 只在**顶层文档**发了它们、且整条祖先链
   * 都隔离时才交出来；我们这一页是被 8bitgo 的 /play/<slug> 外壳 iframe 进去的，
   * 而 require-corp 的父页面只肯装载同样声明了 COEP 的子框架 —— 所以这里必须发。
   */
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  // 被 8bitgo 自己的外壳页嵌入，所以**不能**设 X-Frame-Options
  headers.delete('X-Frame-Options')
  headers.set('Cache-Control', 'no-cache')

  if (!base) return new Response(response.body, { status: response.status, headers })

  let html = await response.text()
  if (!/<base\s/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}/">`)
  }
  return new Response(html, { status: response.status, headers })
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } })
    }
    if (!READ_METHODS.has(request.method)) {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } })
    }

    const url = new URL(request.url)
    const base = basePath(env)
    const path = stripBase(url.pathname, base)
    const ttl = Number.parseInt(env.UPSTREAM_CACHE_TTL ?? '', 10) || 86400

    // 游戏资源。带不带挂载前缀都认 —— 前端到底请求哪一种，看 DevTools 的 Network 面板
    if (path.startsWith('/vcsky/')) {
      return proxy(request, env.VCSKY_UPSTREAM, path.slice('/vcsky/'.length), ttl)
    }
    if (path.startsWith('/vcbr/')) {
      // ⚠️ 上游那一侧的路径也是 /vcsky/（不是 /vcbr/），别按直觉改
      return proxy(request, env.VCBR_UPSTREAM, path.slice('/vcbr/'.length), ttl)
    }

    // 其余交给静态资源。前缀剥掉之后再问，否则查的是 /embed/vc/index.html 这种不存在的 key
    const assetRequest = new Request(new URL(path + url.search, url.origin), request)
    const response = await env.ASSETS.fetch(assetRequest)

    const type = response.headers.get('Content-Type') ?? ''
    if (type.includes('text/html')) return decorateHtml(response, base)

    // 非 HTML 的静态资源是同源的，不需要 CORP，原样返回即可
    return response
  },
}
