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
 * 后端生成开放平台资源地址和 J2ME 代理地址时会变成空串，而前端仍可能因为构建期配置正常，
 * 形成「页面能玩、服务端地址却失效」的不对称状态。
 * 这个默认值和 j2me.js 原来那个私有常量是同一个，现在统一到这里。
 */
export const DEFAULT_ASSET_BASE_URL = 'https://assets.8bitgo.com'
export const DEFAULT_COVER_BASE_URL = 'https://image.8bitgo.com'

export function assetBaseUrl(env = process.env) {
  return String(env.ROM_BASE_URL || DEFAULT_ASSET_BASE_URL).trim().replace(/\/+$/, '')
}

export function coverBaseUrl(env = process.env) {
  return String(env.COVER_BASE_URL || DEFAULT_COVER_BASE_URL).trim().replace(/\/+$/, '')
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

/**
 * 图片 sitemap 只能提交本站能够在 Search Console 验证的域名。
 *
 * 数据库里还留着一些从资料站直接引用的旧封面；页面展示这些图没有问题，但把百度、
 * 贴吧、下载站等第三方地址写进 image sitemap 后，站长无法验证那些域名，Google 也不会
 * 接受这份归属声明。内部 covers/ key 则和前端一致走专用图片域，避免 sitemap 继续写到
 * assets 域并绕过图片处理缓存。
 */
export function sitemapImagePublicUrl(
  key,
  siteUrl = publicSiteUrl(),
  coverBase = coverBaseUrl(),
  assetBase = assetBaseUrl(),
) {
  const raw = String(key || '').trim()
  if (!raw) return ''
  if (raw.startsWith('/')) return new URL(raw, `${siteUrl}/`).href
  if (!/^https?:\/\//i.test(raw)) {
    const base = raw.startsWith('covers/') ? (coverBase || assetBase) : assetBase
    return base ? `${base}/${encodeAssetKey(raw)}` : ''
  }
  try {
    const url = new URL(raw)
    const trustedOrigins = new Set(
      [siteUrl, coverBase, assetBase].filter(Boolean).map((value) => new URL(value).origin),
    )
    return trustedOrigins.has(url.origin) ? url.href : ''
  } catch {
    return ''
  }
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

const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key))
const field = (value, camel, snake) => hasOwn(value, camel) ? value[camel] : value?.[snake]

function i18nMap(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const present = (value) => Boolean(String(value ?? '').trim())

/** 供 IndexNow / 百度推送复用的游戏正文语言判据；与动态 sitemap 保持一致。 */
export function gameContentLanguages(game) {
  const translated = i18nMap(field(game, 'descriptionI18n', 'description_i18n'))
  const english = field(game, 'descriptionEn', 'description_en')
  return ALL_LANGUAGE_CODES.filter((code) => {
    if (code === SITE_DEFAULT_LANGUAGE) return true
    if (code === 'en') return present(translated.en) || present(english)
    return present(translated[code])
  })
}

/** 文章标题、摘要、正文都齐才是一份能独立提交的译文。 */
export function postContentLanguages(post) {
  const title = i18nMap(field(post, 'titleI18n', 'title_i18n'))
  const excerpt = i18nMap(field(post, 'excerptI18n', 'excerpt_i18n'))
  const content = i18nMap(field(post, 'contentI18n', 'content_i18n'))
  return ALL_LANGUAGE_CODES.filter((code) =>
    code === SITE_DEFAULT_LANGUAGE
      || (present(title[code]) && present(excerpt[code]) && present(content[code])))
}

function gameHasLanguageFields(game) {
  return hasOwn(game, 'descriptionEn') || hasOwn(game, 'description_en')
    || hasOwn(game, 'descriptionI18n') || hasOwn(game, 'description_i18n')
}

function postHasLanguageFields(post) {
  return (hasOwn(post, 'titleI18n') || hasOwn(post, 'title_i18n'))
    && (hasOwn(post, 'excerptI18n') || hasOwn(post, 'excerpt_i18n'))
    && (hasOwn(post, 'contentI18n') || hasOwn(post, 'content_i18n'))
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
  const detailPath = `/games/${encodeURIComponent(slug)}`
  const aggregatePaths = new Set(['/games'])
  if (game?.platform) aggregatePaths.add(`/platforms/${encodeURIComponent(String(game.platform))}`)
  for (const genre of Array.isArray(game?.genres) ? game.genres : []) {
    if (genre) aggregatePaths.add(`/genres/${encodeURIComponent(String(genre))}`)
  }
  const requested = resolveLanguages(languages)
  // 删除时调用方只传 slug，没有正文列；此时必须推全部语言，让旧 URL 尽快被重抓成 404。
  const hasLanguageFields = gameHasLanguageFields(game)
  const available = hasLanguageFields ? new Set(gameContentLanguages(game)) : null
  const detailLanguages = hasLanguageFields
    ? requested.filter((code) => available.has(code))
    : requested
  return [
    ...(detailLanguages.length ? expand([detailPath], siteUrl, detailLanguages) : []),
    // 列表、平台、类型页自身有完整的界面正文，所以仍通知全部请求语言。
    ...expand([...aggregatePaths], siteUrl, requested),
  ]
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
  const requested = resolveLanguages(languages)
  const hasLanguageFields = postHasLanguageFields(post)
  const available = hasLanguageFields ? new Set(postContentLanguages(post)) : null
  const detailLanguages = hasLanguageFields
    ? requested.filter((code) => available.has(code))
    : requested
  return [
    ...(detailLanguages.length ? expand([`/blog/${encodeURIComponent(slug)}`], siteUrl, detailLanguages) : []),
    ...expand(['/blog'], siteUrl, requested),
  ]
}

/**
 * 平台页 / 类型页这类聚合页。
 *
 * 入参就是 sitemaps.js 里 `taxonomyRows()` 吐出来的那种行（`{ kind, id }`，
 * kind 只能是 'platforms' 或 'genres'），两边共用同一份筛选结果 ——
 * 「哪些平台/类型真的有可见游戏」的判断只该有一处，各写一份的话，
 * sitemap 里有的页面推送时漏掉、或者反过来推一批前台 404 的页面，
 * 都要逐条比对才看得出来。
 *
 * kind 白名单是硬的：这些字符串最终会拼进提交给搜索引擎的 URL，
 * 让库里的脏数据决定路径前缀等于让它替我们提交任意路径。
 */
const TAXONOMY_KINDS = new Set(['platforms', 'genres'])

export function taxonomyDetailUrls(rows, siteUrl = publicSiteUrl(), languages) {
  const paths = new Set()
  for (const row of rows || []) {
    const kind = String(row?.kind || '').trim()
    const id = String(row?.id || '').trim()
    if (!TAXONOMY_KINDS.has(kind) || !id) continue
    paths.add(`/${kind}/${encodeURIComponent(id)}`)
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
