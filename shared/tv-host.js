/**
 * TV 子域（`tv.8bitgo.com`）的**唯一**判定与跳转规则。
 *
 * 前后端都要认这套：服务端用它决定 301 和 SSR 渲哪一页，客户端用它决定
 * 浏览器地址栏里的 `/` 该挂哪个路由。两边各写一份的话，会出现最难查的那种错 ——
 * **服务端渲了 TV 页、客户端 hydrate 成首页**，页面先闪一下 TV 再变成首页，
 * 控制台里只有一句含糊的 hydration 警告。
 *
 * 所以规则全在这一个文件里，而且它**不 import 任何会引入浏览器/Node 依赖的东西**，
 * 这样 scripts/test-tv-host.mjs 能在 node 里直接跑。
 *
 * ## 地址是怎么安排的（2026-09-12 定的）
 *
 *   · `tv.8bitgo.com/`        -> TV 页（简体中文）
 *   · `tv.8bitgo.com/ja`      -> TV 页（日语）
 *   · `8bitgo.com/tv`         -> 301 到 `https://tv.8bitgo.com/`
 *   · `8bitgo.com/ja/tv`      -> 301 到 `https://tv.8bitgo.com/ja`
 *   · `tv.8bitgo.com/tv`      -> 301 到 `https://tv.8bitgo.com/`（子域上 `/tv` 是重复地址）
 *   · `tv.8bitgo.com/games/x` -> **不跳**，照常渲染，canonical 指回 `8bitgo.com/games/x`
 *
 * ⚠️ 最后一条是刻意的。把子域上所有非 TV 路径都 301 回主域听起来更干净，
 * 但那会把 `/assets/*.js`、`/emulatorjs/*.wasm`、`/fonts/*.woff2` 一起跳走 ——
 * TV 页自己的静态资源变成跨域 301，字体和 wasm 还会撞上 CORS，页面直接起不来。
 * 要按扩展名排除又是一张永远漏项的名单。重复内容交给 canonical（本来就指主域）
 * 和子域专用的 robots.txt 挡，比乱跳安全得多 —— `www.` 那次事故的教训正好相反：
 * 那时唯一出事的 URL 恰恰是**没有 canonical** 的那一个。
 */
import { SITE_LANGUAGES } from './site-languages.js'

/** 子域前缀。换名字只改这里 */
export const TV_SUBDOMAIN = 'tv'

/** TV 页在站内的真实路由。子域上的 `/` 在渲染前会被改写成它 */
export const TV_ROUTE = '/tv'

const LANG_CODES = new Set(SITE_LANGUAGES.map((l) => l.code))

/** 裸域 host -> TV 子域 host。两边都从同一个站点域名推，不各写一份常量 */
export function tvHostOf(siteHostname) {
  const host = String(siteHostname || '').trim().toLowerCase()
  return host ? `${TV_SUBDOMAIN}.${host}` : ''
}

/** 这个请求打在 TV 子域上吗 */
export function isTvHost(hostname, siteHostname) {
  const h = String(hostname || '').trim().toLowerCase()
  const tv = tvHostOf(siteHostname)
  return Boolean(tv) && h === tv
}

/**
 * 把路径拆成 `{ lang, rest }`。`lang` 是前缀里的语言码（没有则空串），
 * `rest` 是去掉语言前缀之后的部分，**始终以 `/` 开头**。
 *
 * ⚠️ 只认整段。`/january` 的首段是 `january`，不能因为它以 `ja` 开头就被当成日语 ——
 * 那会把一个真实存在的页面切成 `/nuary`。
 */
export function splitLangPath(pathname) {
  const p = String(pathname || '/')
  const m = /^\/([^/]+)(\/.*)?$/.exec(p)
  if (m && LANG_CODES.has(m[1])) return { lang: m[1], rest: m[2] || '/' }
  return { lang: '', rest: p === '' ? '/' : p }
}

/** `{ lang, rest }` 拼回路径。rest 为 `/` 时只留语言前缀（`/ja`，不是 `/ja/`） */
export function joinLangPath(lang, rest) {
  const tail = rest === '/' ? '' : rest
  return lang ? `/${lang}${tail}` : tail || '/'
}

/**
 * 这条请求要不要因为 TV 子域而跳转。返回 `null` 表示不跳。
 *
 * 返回的是 `{ origin, path }`：origin 为空串表示同主机跳转（不跨域，保留当前协议和主机）。
 * 调用方负责把它和别的归一（尾斜杠、index.html、www）合成**同一次** 301 ——
 * 链式重定向要多一个往返，而且 Google 只跟有限几跳。
 */
export function tvRedirect({ hostname, pathname, siteOrigin }) {
  if (!siteOrigin) return null
  let siteHost
  try {
    siteHost = new URL(siteOrigin).hostname.toLowerCase()
  } catch {
    return null
  }
  const tvHost = tvHostOf(siteHost)
  if (!tvHost) return null

  const host = String(hostname || '').trim().toLowerCase()
  const onTv = isTvHost(host, siteHost)
  const { lang, rest } = splitLangPath(pathname)
  const isTvRoute = rest === TV_ROUTE

  // 子域上的 `/tv` 是同一页的第二个地址，去掉它
  if (onTv && isTvRoute) return { origin: '', path: joinLangPath(lang, '/') }

  /*
    主域上的 `/tv` 搬到子域去。

    ⚠️ **只在正牌域名（裸域或 www）上跳**，不是「凡是非 TV 主机都跳」。
    后者会把本地开发一起跳到线上：`npm run dev` 的 host 是 localhost，只要 .env 里
    配了 PUBLIC_SITE_URL（很常见），打开 localhost:5173/tv 就会被 301 到
    https://tv.8bitgo.com/ —— 人在调本地，页面却跳去了生产。
    预览域名、内网 IP、健康检查同理。这条和 url-normalize 里 www 那一节
    「不写成『凡是不等于裸域的 host 都跳』」是同一个道理。
  */
  if (!onTv && isTvRoute && (host === siteHost || host === `www.${siteHost}`)) {
    const proto = siteOrigin.startsWith('http://') ? 'http' : 'https'
    return { origin: `${proto}://${tvHost}`, path: joinLangPath(lang, '/') }
  }

  return null
}

/**
 * 在 TV 子域上，这条路径实际要渲染哪个路由。不在子域、或不是 TV 页就返回 `null`。
 *
 * 只有「语言前缀 + 根」才算 TV 页 —— 子域上的 `/games/xxx` 照常渲染游戏页
 * （理由见文件头）。
 */
export function tvRenderPath({ hostname, pathname, siteOrigin }) {
  if (!siteOrigin) return null
  let siteHost
  try {
    siteHost = new URL(siteOrigin).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!isTvHost(hostname, siteHost)) return null
  const { lang, rest } = splitLangPath(pathname)
  if (rest !== '/') return null
  return joinLangPath(lang, TV_ROUTE)
}
