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
