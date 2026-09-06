/**
 * URL 归一化中间件。单独一个文件是为了能被单测直接 import ——
 * 放在 index.js 里的话，测试一 import 就把服务器起起来了。
 */
import { CACHE } from './cache.js'

/**
 * 尾斜杠归一：`/games/` 301 到 `/games`。
 *
 * Express 默认不区分这两者，所以以前两份都回 200、内容一模一样。canonical 确实
 * 指向了无斜杠那份，搜索引擎最终不会重复收录 —— 但两份都会被抓、外链权重也散在
 * 两个 URL 上。一次 301 就把它们合并了，也顺带让日志和统计只剩一种写法。
 *
 * 注意三点：
 *  1. 只管 GET / HEAD，别去动接口的写请求；`/api/` 一律放过（客户端可能依赖原样路径）。
 *  2. **必须先把开头的多余斜杠折掉**。`//evil.com/` 的 pathname 就是 `//evil.com/`，
 *     直接去尾会得到 `//evil.com` —— 那是协议相对 URL，等于开了一个跳到外站的开放重定向。
 *  3. 用 originalUrl 切出 pathname 和查询串，保持原有的百分号编码不被重新编码一遍。
 *
 * 大小写**不做**归一：库里的 slug 没有强制小写，`/Games` 一律转小写有可能把真实存在的
 * URL 301 到 404。那类重复交给 canonical 处理就够了（页面里写的是硬编码的小写路径）。
 */
export function normalizeTrailingSlash(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const cut = req.originalUrl.indexOf('?')
  const pathname = cut >= 0 ? req.originalUrl.slice(0, cut) : req.originalUrl
  const search = cut >= 0 ? req.originalUrl.slice(cut) : ''
  if (pathname === '/' || !pathname.endsWith('/') || pathname.startsWith('/api/')) return next()
  const clean = '/' + pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  if (clean === pathname) return next()
  return res.set('Cache-Control', CACHE.meta).redirect(301, clean + search)
}
