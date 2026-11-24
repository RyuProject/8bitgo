/**
 * `/_cn/*`：给 8bitgo.com 上的大陆访客从 EdgeOne（cn.<裸域>）取静态资源与只读 API 的入口。
 * 来龙去脉见 shared/cover-cdn-hint.js 的「大陆访客在 8bitgo.com 上」一节。
 *
 * 做三件事：
 *   1. 去掉 `/_cn` 前缀，交给后面原有的静态 / API 路由处理 —— 不复制任何业务逻辑。
 *   2. 固定发 `Access-Control-Allow-Origin: <站点 origin>`。EdgeOne 的缓存键不看 Origin，
 *      所以这组路径的每份缓存都必须带同一个、对 8bitgo.com 有效的值；cors 中间件对带 Origin
 *      的请求会写同样的值，没带 Origin 的请求（直接访问、no-cors 样式表）也不会缓存出一份「没头」的。
 *      再加 `Cross-Origin-Resource-Policy: cross-origin`，PSP 那类 require-corp 的隔离页也能加载。
 *   3. CSS 里写死的 `url(/fonts/...)` 会按样式表所在的 cn 域解析到 EdgeOne 上那批**没有 CORS 头**
 *      的旧缓存，字体就被拦了。所以 `/_cn/**.css` 在这里读出文件，把 `/fonts/` 改成 `/_cn/fonts/`。
 *
 * 只放行 assets / fonts / api / emulatorjs / ruffle / jsdos / j2me 七个前缀、PSP 的 wasm / data 和 Play! 的 wasm，别的一律 404：这不是通用的反代入口。
 * j2me 是给 /j2me/edge-sw.js 用的：CheerpJ 只认同源，SW 拦下它的 Range 请求转到这里（见 scripts/j2me-web/edge-sw.js）。
 * 后三个给大陆访客取模拟器引擎与核心（src/emulator/paths.ts 的 runtimeBase：EmulatorJS、Flash、DOS）。
 * 另外单独放行 socket.io 的浏览器客户端两份文件（见下面 SOCKET_IO_CLIENT）。
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { CN_EDGE_PREFIX } from '../../shared/cover-cdn-hint.js'

/*
  socket.io 的浏览器客户端。

  2026-11-20 起直播（src/services/live.ts）已把 socket.io-client 打进前端包，不再取这两份文件；
  留着给仍从后端取脚本的地方（模拟器 iframe 里的联机，src/services/netplay.ts 的 socketIoScriptUrl）
  改走大陆加速入口用。确认没人用了再删。

  2026-11-19 线上：8bitgo.com 上的大陆访客从同源 /socket.io/socket.io.js 取它要绕 Cloudflare 洛杉矶，
  实测 26～30 秒（37KB gzip，max-age=0 每次都回源复验）；直播客户端 8 秒就放弃，于是这批访客
  开播、看直播全部报「/socket.io/socket.io.js 加载超时」。同一时刻经 cn.8bitgo.com 只要 2 秒。

  不能剥掉前缀交给后面：engine.io 只拦**原始**路径以 `/socket.io/` 开头的请求，`/_cn/socket.io/…`
  已经过了它那一关，Express 里也没有路由接得住。所以这里直接发 socket.io 包里那份文件 ——
  和同源 serveClient 发的是同一份字节，版本永远跟服务端一致。只放这两个文件，不放 .map / esm / msgpack。
  缓存只给一小时：URL 不带版本号，EdgeOne 又清不了缓存，升级 socket.io 后最多旧一小时（同为 v4 协议，兼容）。
*/
const SOCKET_IO_CLIENT = /^\/socket\.io\/(socket\.io(?:\.min)?\.js)(?:\?|$)/
const SOCKET_IO_CLIENT_CACHE = 'public, max-age=3600'

/** socket.io 包里 client-dist 目录；装不上（理论上不会）就返回空串，请求按 404 处理 */
function defaultSocketIoClientDir() {
  try {
    const require = createRequire(import.meta.url)
    // exports 只开放了包入口和 package.json：入口在 dist/index.js，client-dist 与 dist 同级
    return path.join(path.dirname(require.resolve('socket.io')), '..', 'client-dist')
  } catch {
    return ''
  }
}

/*
  ppsspp 只放两份大文件（wasm / data）：入口、胶水 JS、Worker 必须和跨源隔离页同源，放出来也用不上，
  还会让 EdgeOne 缓存一批 CORP 不对的副本。
*/
const PPSSPP_EDGE = /^\/ppsspp\/v[0-9a-f]+\/v\d+\/PPSSPPSDL\.(?:wasm|data)(?:\?|$)/
// Play.js 含 pthread Worker，必须同源；只把可跨源 fetch 的版本化 WASM 放到 EdgeOne。
const PLAY_WASM_EDGE = /^\/play\/[^/]+\/Play\.wasm(?:\?|$)/
const ALLOWED = /^\/(assets|fonts|api|emulatorjs|ruffle|jsdos|j2me)\//
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function rewriteCssFontUrls(css) {
  return css.replace(/url\((['"]?)\/fonts\//g, `url($1${CN_EDGE_PREFIX}/fonts/`)
}

export function createCnEdgeMiddleware({ clientDir, siteOrigin, socketIoClientDir = defaultSocketIoClientDir() }) {
  const cssCache = new Map()
  /** 文件名 → { body, etag }；只有两份、内容随进程不变，读一次就够 */
  const ioClientCache = new Map()
  return async function cnEdge(req, res, next) {
    const raw = req.url || ''
    if (raw !== CN_EDGE_PREFIX && !raw.startsWith(`${CN_EDGE_PREFIX}/`)) return next()
    const rest = raw.slice(CN_EDGE_PREFIX.length) || '/'
    const ioClient = SOCKET_IO_CLIENT.exec(rest)?.[1] ?? ''
    if (!ALLOWED.test(rest) && !PPSSPP_EDGE.test(rest) && !PLAY_WASM_EDGE.test(rest) && !ioClient) {
      return res.status(404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not Found')
    }
    req.url = rest
    req.originalUrl = rest
    req.cnEdge = true
    if (siteOrigin) {
      res.setHeader('Access-Control-Allow-Origin', siteOrigin)
      // 让页面的 Resource Timing 看得到传输字节数（启动诊断包靠它判断是慢还是命中缓存）；不含任何内容
      res.setHeader('Timing-Allow-Origin', siteOrigin)
      /*
        静态文件（assets / fonts / emulatorjs）的 ACAO 是固定值，内容不随 Origin 变，不能留 `Vary: Origin`
        （前面的 cors 中间件会加）：预热用 fetch 带 Origin，`<script>` / `<link>` 不带，Vary 让浏览器
        把同一个 URL 当成两条缓存，预热白做。2026-11-08 实测 loader.js / emulator.min.css 因此各下两遍。
      */
      if (rest.startsWith('/api/')) res.setHeader('Vary', 'Origin')
      else res.removeHeader('Vary')
    }
    // /_cn/api 只承载公开只读请求。浏览器守前端不够：任意客户端都能手工带登录态打到 EdgeOne，
    // 令牌可能进边缘日志或缓存链；服务端必须把带凭据的请求挡回去。OPTIONS 预检不带真实凭据。
    if (
      req.method !== 'OPTIONS' && rest.startsWith('/api/') &&
      (req.headers?.authorization || req.headers?.cookie)
    ) {
      return res.status(400).set('Cache-Control', 'no-store').type('text/plain').send('Authenticated requests must use the primary API')
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    // J2ME 与 EmulatorJS 的 Range 读取要校验区间和版本；跨源响应必须暴露这些头，否则浏览器只看得到安全名单里的头。
    if (rest.startsWith('/j2me/') || rest.startsWith('/emulatorjs/')) {
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Encoding, ETag, Last-Modified')
    }

    if (ioClient) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').end()
      let entry = ioClientCache.get(ioClient)
      if (!entry) {
        try {
          if (!socketIoClientDir) throw new Error('socket.io client-dist not found')
          const body = await readFile(path.join(socketIoClientDir, ioClient), 'utf8')
          const version = /Socket\.IO v([\w.-]+)/.exec(body)?.[1] ?? String(body.length)
          entry = { body, etag: `"sio-${version}-${ioClient}"` }
          ioClientCache.set(ioClient, entry)
        } catch {
          return res.status(404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not Found')
        }
      }
      res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': SOCKET_IO_CLIENT_CACHE, ETag: entry.etag })
      if (req.headers?.['if-none-match'] === entry.etag) return res.status(304).end()
      res.status(200)
      return req.method === 'HEAD' ? res.end() : res.send(entry.body)
    }

    const pathname = rest.split('?')[0]
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.endsWith('.css') && !pathname.startsWith('/api/')) {
      let decoded
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        return res.status(400).end()
      }
      const file = path.resolve(clientDir, `.${decoded}`)
      if (!file.startsWith(path.resolve(clientDir) + path.sep)) return res.status(404).end()
      try {
        let css = cssCache.get(file)
        if (css === undefined) {
          css = rewriteCssFontUrls(await readFile(file, 'utf8'))
          // 文件名都带内容哈希，内容不会变；上限只防有人拿不存在的组合刷内存（不存在的会 404，进不来）
          if (cssCache.size > 200) cssCache.clear()
          cssCache.set(file, css)
        }
        res.status(200).set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': IMMUTABLE })
        return req.method === 'HEAD' ? res.end() : res.send(css)
      } catch {
        return res.status(404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not Found')
      }
    }
    return next()
  }
}
