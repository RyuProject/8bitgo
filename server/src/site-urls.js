/**
 * 公开 URL 的唯一算法。
 *
 * 以前这些函数长在 indexnow.js 里，只有 IndexNow 一个消费者。现在动态 sitemap、
 * IndexNow、百度普通收录三处都要用同一套「路径 → 各语言完整地址」的规则 ——
 * 抄三份的话，加一种语言或改一次前缀策略就会出现「页面能打开，但某个通道永远漏掉它」。
 * indexnow.js 仍然原样再导出这里的全部函数，老的导入路径不用改。
 */
import { SITE_DEFAULT_LANGUAGE, SITE_LANGUAGES } from '../../shared/site-languages.js'

export const DEFAULT_SITE_URL = 'https://8bitgo.com'

/**
 * 对象存储（R2 / CDN）的公开根地址。
 *
 * 公开桶域名不是机密，所以留一个可用默认值 —— 否则服务器上少配一行 ROM_BASE_URL，
 * 症状是「页面里封面正常显示，但 sitemap / og:image 里的图片地址全是空的」：
 * 前端那份地址是构建时从 VITE_ROM_BASE_URL 烘进去的，服务端这份不是，两边会各自失效。
 * 这个默认值和 j2me.js 原来那个私有常量是同一个，现在统一到这里。
 */
export const DEFAULT_ASSET_BASE_URL = 'https://assets.8bitgo.com'

export function assetBaseUrl(env = process.env) {
  return String(env.ROM_BASE_URL || DEFAULT_ASSET_BASE_URL).trim().replace(/\/+$/, '')
}

/** key 的每一段单独编码，保留斜杠。和前端 services/roms.ts 的 encodeKey 一致。 */
function encodeAssetKey(key) {
  return String(key)
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * 把 `games.cover` 那种值换成可抓取的绝对地址。认的三种写法和前端 romUrlForKey 一致：
 *   1. 完整 URL —— 原样返回
 *   2. 以 `/` 开头 —— 站内路径（例如 `/og-default.png`），拼站点域名
 *   3. 其余 —— 对象存储 key（`covers/contra.jpg`），拼公开桶地址
 *
 * ⚠️ 必须返回绝对地址：sitemap 的 <image:loc> 和 og:image 都不接受相对路径。
 * 拼不出来时返回空串，让调用方跳过 —— 输出一个必然 404 的 URL 比不输出更糟。
 */
export function assetPublicUrl(key, siteUrl = publicSiteUrl(), base = assetBaseUrl()) {
  const raw = String(key || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('/')) return new URL(raw, `${siteUrl}/`).href
  return base ? `${base}/${encodeAssetKey(raw)}` : ''
}

const ALL_LANGUAGE_CODES = Object.freeze(SITE_LANGUAGES.map(({ code }) => code))
const KNOWN_LANGUAGES = new Set(ALL_LANGUAGE_CODES)

export function publicSiteUrl(env = process.env) {
  const raw = String(env.PUBLIC_SITE_URL || env.VITE_SITE_URL || DEFAULT_SITE_URL).trim()
  const url = new URL(raw)
  if (!/^https?:$/.test(url.protocol)) throw new Error('PUBLIC_SITE_URL 必须是 http(s) 地址')
  return url.origin
}

/**
 * 把一个语言子集规整成有效的语言码数组。
 *
 * 遇到不认识的语言码直接报错，不是静默跳过：这个值来自 .env，写错一个字母
 * （zh-hans / zh_CN / cn）如果被悄悄忽略，症状是「配了却一条都不推」，
 * 而日志里什么都看不到，几乎无法定位。
 */
export function resolveLanguages(languages) {
  if (!languages) return [...ALL_LANGUAGE_CODES]
  const wanted = [...new Set((Array.isArray(languages) ? languages : [languages]).map((l) => String(l).trim()).filter(Boolean))]
  const unknown = wanted.filter((code) => !KNOWN_LANGUAGES.has(code))
  if (unknown.length) {
    throw new Error(`不支持的语言码：${unknown.join('、')}（可用：${ALL_LANGUAGE_CODES.join('、')}）`)
  }
  if (!wanted.length) throw new Error('语言列表为空')
  // 按 SITE_LANGUAGES 的顺序输出，保证同一批 URL 的顺序稳定、便于比对日志
  return ALL_LANGUAGE_CODES.filter((code) => wanted.includes(code))
}

/** 默认语言不加前缀，其余语言和前端路由保持一致。 */
export function localizedPublicUrl(pathname, language, siteUrl = publicSiteUrl()) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  const prefix = language === SITE_DEFAULT_LANGUAGE ? '' : `/${language}`
  return new URL(`${prefix}${path}`, `${siteUrl}/`).href
}

const expand = (paths, siteUrl, languages) =>
  paths.flatMap((path) => resolveLanguages(languages).map((code) => localizedPublicUrl(path, code, siteUrl)))

/** 一款游戏的详情页。languages 留空表示全部语言。 */
export function gameDetailUrls(slug, siteUrl = publicSiteUrl(), languages) {
  const clean = String(slug || '').trim()
  if (!clean) return []
  return expand([`/games/${encodeURIComponent(clean)}`], siteUrl, languages)
}

/**
 * 保存一款游戏时，详情页和它所在的聚合页内容都会变化。
 * 一起通知能让新游戏更快从列表入口被发现，也不会只留下一个没有站内关系的孤立 URL。
 */
export function gameChangeUrls(game, siteUrl = publicSiteUrl(), languages) {
  const slug = String(game?.slug || '').trim()
  if (!slug) return []
  const paths = new Set([`/games/${encodeURIComponent(slug)}`, '/games'])
  if (game?.platform) paths.add(`/platforms/${encodeURIComponent(String(game.platform))}`)
  for (const genre of Array.isArray(game?.genres) ? game.genres : []) {
    if (genre) paths.add(`/genres/${encodeURIComponent(String(genre))}`)
  }
  return expand([...paths], siteUrl, languages)
}

/** 一篇文章的详情页。languages 留空表示全部语言。 */
export function postDetailUrls(slug, siteUrl = publicSiteUrl(), languages) {
  const clean = String(slug || '').trim()
  if (!clean) return []
  return expand([`/blog/${encodeURIComponent(clean)}`], siteUrl, languages)
}

/**
 * 保存一篇文章时，详情页和博客列表的内容都会变化 —— 和游戏那边同一个道理，
 * 只推详情页会留下一个没有站内入口的孤立 URL。
 *
 * 草稿不在这里过滤：调用方（routes/posts.js）才知道这次是发布、改动还是撤下，
 * 而「已发布 → 撤下」恰恰**需要**推送，好让搜索引擎尽快重抓并发现 404。
 */
export function postChangeUrls(post, siteUrl = publicSiteUrl(), languages) {
  const slug = String(post?.slug || '').trim()
  if (!slug) return []
  return expand([`/blog/${encodeURIComponent(slug)}`, '/blog'], siteUrl, languages)
}

/** 只允许提交本站 URL，防止脏数据把这台服务器变成任意 URL 提交代理。 */
export function normalizeSiteUrls(urls, siteUrl = publicSiteUrl()) {
  const origin = new URL(siteUrl).origin
  const out = new Set()
  for (const raw of urls || []) {
    try {
      const url = new URL(String(raw))
      if (url.origin !== origin || !/^https?:$/.test(url.protocol)) continue
      url.hash = ''
      out.add(url.href)
    } catch {
      // 单个坏 URL 不该拖掉同一批里其余正常页面。
    }
  }
  return [...out]
}
