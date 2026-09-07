/**
 * URL 归一化中间件。单独一个文件是为了能被单测直接 import ——
 * 放在 index.js 里的话，测试一 import 就把服务器起起来了。
 * 回归：`npm run test:robots`。
 */
import { CACHE } from './cache.js'

/**
 * URL 归一（原名 `normalizeTrailingSlash`，2026-09-07 起还管 `/index.html`）。
 * 两件事在**同一趟**里做完，一个请求最多吃一次 301 —— 链式重定向要多一个往返，
 * 而且 Google 只跟有限几跳。
 *
 * ── 一、尾斜杠：`/games/` → `/games` ──────────────────────────
 * Express 默认不区分这两者，所以以前两份都回 200、内容一模一样。canonical 确实
 * 指向了无斜杠那份，搜索引擎最终不会重复收录 —— 但两份都会被抓、外链权重也散在
 * 两个 URL 上。一次 301 就把它们合并了，也顺带让日志和统计只剩一种写法。
 *
 * ── 二、`/index.html` → `/`（2026-09-07，Search Console 报出来的）────
 * `index.html` 是 `dist/client/` 里一个**真实文件**，而 `express.static` 的
 * `index: false` 只关掉「**目录**请求自动吐 index.html」，**不阻止**显式请求
 * `/index.html` —— 那条请求直接被静态中间件吐了原始构建模板，**绕过 SSR**。
 *
 * 后果绕了一圈才显形，很难自己想到：
 *   1. 模板 head 里是 `data-ssr-default` 的那份 `robots=index,follow`、**没有 canonical**
 *      （canonical 是 SSR 时才拼进去的），于是首页凭空多出一个可收录的副本。
 *   2. Google 会执行 JS：SPA 起来后拿路径 `/index.html` 去匹配路由，一条都不中，
 *      落到 `NotFoundPage` → `useSeo({ noindex: true })` 改写了 head。
 *      所以 Search Console 报的是**「被 noindex 标记排除」**，而 curl 看到的是
 *      `index,follow` —— 两边看起来矛盾，其实是渲染前后两个阶段。
 * 归一到目录本身，这个 URL 就不存在了。`/it/index.html` 同理 → `/it`。
 *
 * 注意四点：
 *  1. 只管 GET / HEAD，别去动接口的写请求；`/api/` 一律放过（客户端可能依赖原样路径）。
 *  2. **必须先把开头的多余斜杠折掉**。`//evil.com/` 的 pathname 就是 `//evil.com/`，
 *     直接去尾会得到 `//evil.com` —— 那是协议相对 URL，等于开了一个跳到外站的开放重定向。
 *  3. 用 originalUrl 切出 pathname 和查询串，保持原有的百分号编码不被重新编码一遍。
 *  4. 去 `index.html` 的正则必须锚在 `(^|/)` 和 `$` 上：少了前面那半，`/myindex.html`
 *     会被切成 `/my`；少了后面那半，`/assets/index-abc.js` 之类也会中招。
 *
 * ⚠️ 这个中间件必须注册在 `express.static` **之前**，否则静态文件先被吐出去，
 * 归一根本没机会跑（`/index.html` 那条就是这么漏掉的）。
 *
 * 大小写**不做**归一：库里的 slug 没有强制小写，`/Games` 一律转小写有可能把真实存在的
 * URL 301 到 404。那类重复交给 canonical 处理就够了（页面里写的是硬编码的小写路径）。
 * `index.html` 是个例外 —— 它是固定文件名不是 slug，所以那一条带 `i` 标志。
 */
export function normalizeUrl(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const cut = req.originalUrl.indexOf('?')
  const pathname = cut >= 0 ? req.originalUrl.slice(0, cut) : req.originalUrl
  const search = cut >= 0 ? req.originalUrl.slice(cut) : ''
  if (pathname.startsWith('/api/')) return next()
  // 开头的多余斜杠先折掉（见注意 2），再去尾斜杠
  let clean = '/' + pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  // 显式请求的 index.html 归到它所在的目录：/index.html → /、/it/index.html → /it
  clean = clean.replace(/(^|\/)index\.html$/i, '')
  if (clean === '') clean = '/'
  if (clean === pathname) return next()
  return res.set('Cache-Control', CACHE.meta).redirect(301, clean + search)
}
