/**
 * TV 子域专用的 robots.txt。
 *
 * ## 为什么需要单独一份
 *
 * `tv.8bitgo.com` 跑的是同一个应用，所以它上面**每一条路径都打得开** ——
 * `tv.8bitgo.com/games/contra` 和 `8bitgo.com/games/contra` 是同一个页面的两份。
 * 整站被抓两遍，抓取预算白花一半。
 *
 * 主域那次 `www.` 事故给的正是这个教训，但处方不同：那时的修法是整站 301 到裸域，
 * 这里**不能**那么修 —— 把子域上的非 TV 路径都跳回主域，会连 `/assets/*.js`、
 * `/emulatorjs/*.wasm`、`/fonts/*.woff2` 一起跳走，TV 页自己的资源变成跨域 301，
 * 字体和 wasm 还要撞 CORS，页面直接起不来（详见 shared/tv-host.js 的文件头）。
 *
 * 所以子域用两道软的：
 *   1. 每个页面的 canonical 本来就指主域（TV 页自己指子域，那是它的正牌地址）；
 *   2. 这份 robots.txt 只放行各语言的根，其余一律 Disallow。
 *
 * ⚠️ `Allow: /$` 里的 `$` 是结尾锚，必须有。写成 `Allow: /` 是**前缀**匹配，
 *    等于把整个子域重新放开，这份文件就白写了。同理 `/ja` 要写成 `/ja$`，
 *    否则 `/ja/games/contra` 也被放行。
 * ⚠️ 按 RFC 9309，匹配到的规则里**路径最长的**说了算：`/$`（2 个字符）压过
 *    `Disallow: /`（1 个字符），所以根是允许的、其余是禁止的。顺序无关。
 *
 * 不声明 Sitemap：子域上只有 8 条 URL（每种语言一条根），而主站导航里的
 * 「8BitGo TV」指向 /tv、会 301 过来，爬虫照着走就能收全，不值得为它多维护一份。
 */
import { SITE_LANGUAGES, SITE_DEFAULT_LANGUAGE } from '../../shared/site-languages.js'
import { isTvHost } from '../../shared/tv-host.js'
import { publicSiteUrl } from './site-urls.js'
import { requestHostname } from './url-normalize.js'
import { CACHE } from './cache.js'

/** 各语言根的路径：默认语言是 `/`，其余是 `/<code>` */
export function tvAllowedPaths() {
  return [
    '/',
    ...SITE_LANGUAGES.map((l) => l.code)
      .filter((code) => code !== SITE_DEFAULT_LANGUAGE)
      .map((code) => `/${code}`),
  ]
}

export function tvRobotsTxt() {
  const lines = [
    '# tv.8bitgo.com —— 电视 / 车机专用入口。',
    '# 这个子域跑的是同一个应用，除了各语言的根以外都是主域页面的重复，一律不收。',
    '# 详见 server/src/tv-robots.js',
    'User-agent: *',
    'Disallow: /',
    // $ 是结尾锚，少了它就是前缀匹配，等于整站放开
    ...tvAllowedPaths().map((p) => `Allow: ${p}$`),
    '',
  ]
  return lines.join('\n')
}

/**
 * 必须注册在 `express.static` **之前** —— 否则 public/robots.txt 先被吐出去，
 * 这份根本没机会跑（`/index.html` 那条就是这么漏掉过的，见 url-normalize.js）。
 */
export function tvRobots(req, res, next) {
  if (req.path !== '/robots.txt') return next()
  let siteHost
  try {
    siteHost = new URL(publicSiteUrl()).hostname
  } catch {
    return next()
  }
  if (!isTvHost(requestHostname(req), siteHost)) return next()
  return res
    .set('Cache-Control', CACHE.meta)
    .type('text/plain; charset=utf-8')
    .send(tvRobotsTxt())
}
