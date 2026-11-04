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
 * 只放行 assets / fonts / api 三个前缀，别的一律 404：这不是通用的反代入口。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CN_EDGE_PREFIX } from '../../shared/cover-cdn-hint.js'

const ALLOWED = /^\/(assets|fonts|api)\//
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function rewriteCssFontUrls(css) {
  return css.replace(/url\((['"]?)\/fonts\//g, `url($1${CN_EDGE_PREFIX}/fonts/`)
}

export function createCnEdgeMiddleware({ clientDir, siteOrigin }) {
  const cssCache = new Map()
  return async function cnEdge(req, res, next) {
    const raw = req.url || ''
    if (raw !== CN_EDGE_PREFIX && !raw.startsWith(`${CN_EDGE_PREFIX}/`)) return next()
    const rest = raw.slice(CN_EDGE_PREFIX.length) || '/'
    if (!ALLOWED.test(rest)) {
      return res.status(404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not Found')
    }
    req.url = rest
    req.originalUrl = rest
    req.cnEdge = true
    if (siteOrigin) {
      res.setHeader('Access-Control-Allow-Origin', siteOrigin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')

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
