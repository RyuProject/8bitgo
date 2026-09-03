import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '../db.js'
import { CACHE } from '../cache.js'
import { assetPublicUrl, localizedPublicUrl, publicSiteUrl } from '../site-urls.js'
import { SITE_LANGUAGES } from '../../../shared/site-languages.js'
import { ENABLED_PLATFORM_IDS, GENRE_IDS } from '../../../shared/site-taxonomy.js'

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'
const languageCodes = new Set(SITE_LANGUAGES.map((item) => item.code))

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

function dateOnly(value) {
  // null / undefined 必须先挡掉：new Date(null) 是 1970-01-01（合法日期！），
  // 会给 sitemap 写进一个「1970 年最后修改」的 lastmod，比不写 lastmod 更糟。
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 10)
}

/**
 * 一份 <urlset>：把「路径前缀 + slug」按某种语言展开。
 *
 * 游戏和文章共用这一个生成器。两边唯一的差别是路径前缀和 lastmod 取哪几列，
 * 各写一份的话，下次改转义、改 lastmod 兜底顺序或者加字段，就会出现
 * 「游戏 sitemap 改了、文章 sitemap 没改」这种只有逐行比对才看得出来的偏差。
 */
const IMAGE_NS = 'http://www.google.com/schemas/sitemap-image/1.1'

/**
 * 一条 <image:image>。
 *
 * ⚠️ 只输出 <image:loc>。<image:title>、<image:caption>、<image:license>、
 * <image:geo_location> 这四个标签 Google 已经在 2022 年那次「sitemap 扩展大扫除」里
 * 停止支持了 —— 现在写进去不会报错，但完全不被读取，只是白白让每份 sitemap 变大。
 * 图片的替代文字和标题靠页面里的 alt 与结构化数据表达，不靠 sitemap。
 */
const imageTag = (url) => `\n    <image:image>\n      <image:loc>${escapeXml(url)}</image:loc>\n    </image:image>`

/**
 * 一份 <urlset>：把若干行数据按某种语言展开成带 hreflang 前缀的 URL。
 *
 * 游戏、文章、平台/类型三份 sitemap 共用这一个生成器，差别只在三个回调：
 * pathOf（与语言无关的站内路径）、lastmodOf、imageOf。各写一份的话，下次改转义、
 * 改 lastmod 兜底顺序或者加字段，就会出现「游戏 sitemap 改了、别的没改」
 * 这种只有逐行比对才看得出来的偏差。
 *
 * imageOf 返回图片绝对地址或空串。只有真的有图时才声明 image 命名空间 ——
 * 一份图片一张都没有的 sitemap 还挂着 xmlns:image，纯属噪音。
 */
function buildUrlsetSitemap(rows, language, siteUrl, pathOf, lastmodOf, imageOf) {
  if (!languageCodes.has(language)) throw new Error(`不支持的 sitemap 语言：${language}`)
  let hasImage = false
  const entries = rows.map((row) => {
    const loc = localizedPublicUrl(pathOf(row), language, siteUrl)
    const lastmod = dateOnly(lastmodOf(row))
    const image = imageOf ? imageOf(row) : ''
    if (image) hasImage = true
    return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}${image ? imageTag(image) : ''}\n  </url>`
  })
  const ns = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasImage ? ` xmlns:image="${IMAGE_NS}"` : ''}`
  return `${XML_HEADER}\n<urlset ${ns}>\n${entries.join('\n')}\n</urlset>\n`
}

/**
 * 每种语言单独一份，避免游戏增长后「游戏数 × 8 种语言」撞上单份 sitemap
 * 最多 50,000 URL 的协议上限。各语言之间的关系由页面 head 的 hreflang 说明。
 */
export function buildGameSitemap(rows, language, siteUrl = publicSiteUrl()) {
  return buildUrlsetSitemap(
    rows,
    language,
    siteUrl,
    (row) => `/games/${encodeURIComponent(String(row.slug))}`,
    (row) => row.updated_at || row.created_at || row.added_at,
    // 封面在独立的对象存储域上，所以这里必须换算成绝对地址（见 site-urls.js 的 assetPublicUrl）。
    // 没绑封面的游戏用的是程序生成的渐变块，不是真图片，跳过。
    (row) => assetPublicUrl(row.cover, siteUrl),
  )
}

/** 始终从数据库读取上架游戏，后台新增后不需要等下一次前端构建。 */
export async function gameSitemap(req, res, next) {
  try {
    const language = String(req.params.language || '')
    if (!languageCodes.has(language)) {
      return res.status(404).set('Cache-Control', CACHE.notFound).type('text/plain').send('Not Found')
    }
    const rows = await query(
      'SELECT slug, cover, added_at, created_at, updated_at FROM games WHERE hidden = 0 ORDER BY id ASC',
    )
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(buildGameSitemap(rows, language))
  } catch (error) {
    next(error)
  }
}


/* ---------------- 文章 sitemap ---------------- */

/**
 * 和游戏 sitemap 同构，单独一份的理由也一样：后台随时能发文章，
 * 烘进构建产物的话，不重新部署就永远进不了 sitemap。
 */
export function buildPostSitemap(rows, language, siteUrl = publicSiteUrl()) {
  // `date` 是作者手填的发布日期，可能留空也可能是未来日期，所以只当最后的兜底。
  return buildUrlsetSitemap(
    rows,
    language,
    siteUrl,
    (row) => `/blog/${encodeURIComponent(String(row.slug))}`,
    (row) => row.updated_at || row.created_at || row.date,
  )
}

/** 只收已发布的文章：草稿在前台是 404，进 sitemap 等于主动提交一批错误页。 */
export async function postSitemap(req, res, next) {
  try {
    const language = String(req.params.language || '')
    if (!languageCodes.has(language)) {
      return res.status(404).set('Cache-Control', CACHE.notFound).type('text/plain').send('Not Found')
    }
    const rows = await query(
      'SELECT slug, `date`, created_at, updated_at FROM posts WHERE published = 1 ORDER BY id ASC',
    )
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(buildPostSitemap(rows, language))
  } catch (error) {
    next(error)
  }
}


/* ---------------- 平台 / 类型 sitemap ---------------- */

/**
 * 平台页与类型页。
 *
 * 这两类页面是主要的搜索入口（/platforms/nes、/genres/action …），有独立的 H1、
 * 正文和结构化数据。它们原来由构建期的 gen-sitemap.mjs 烘进 sitemap-static.xml，
 * 而「哪些平台/类型有游戏」完全由数据库决定 —— 于是后台加了上百款游戏之后，
 * 线上 sitemap 里长期只剩 /platforms/flash 和 /platforms/html5，类型页一条都没有。
 * 现在和游戏、文章一样实时生成。
 *
 * 两类合成一份就够：数量是几十条，远够不上单份 50,000 URL 的上限，
 * 再拆只会让索引更长、更难看出哪份出了问题。
 */
export function buildTaxonomySitemap(rows, language, siteUrl = publicSiteUrl()) {
  return buildUrlsetSitemap(
    rows,
    language,
    siteUrl,
    (row) => `/${row.kind}/${encodeURIComponent(String(row.id))}`,
    (row) => row.latest,
  )
}

/**
 * 把两组「id + 最新时间」的聚合结果整理成 sitemap 要的行。纯函数，便于单测。
 *
 * 做两件事：**过滤**和**定序**。
 *   - 过滤：一款可见游戏都没有的平台 / 类型是空页面，不进 sitemap；白名单外的平台
 *     前台根本不展示，它的详情页也不该被收录；库里可能还留着已经下线的 genre_id
 *     （游戏身上挂着旧类型），那种页面在前台是 404，写进去等于主动提交错误页。
 *   - 定序：按 id 名单的顺序而不是数据库返回的顺序，这样同一批 URL 顺序稳定，
 *     两次输出可以直接 diff。
 *
 * lastmod 取「这一页里最新的那款游戏的更新时间」—— 平台页和类型页本身没有修改时间，
 * 它们的内容就是那批游戏，某个平台新上架一款，那一页确实变了。
 */
export function pickTaxonomyRows(platformRows = [], genreRows = []) {
  const shape = (ids, rows, kind) => {
    const latestById = new Map(rows.map((row) => [String(row.id), row.latest]))
    return ids.filter((id) => latestById.has(id)).map((id) => ({ kind, id, latest: latestById.get(id) }))
  }
  // ENABLED_PLATFORM_IDS 为空表示「全部平台开放」，这时以数据库里实际有的平台为准 ——
  // 写成 includes 的话，清空白名单会反过来变成「全部平台都被禁」，sitemap 直接空掉。
  const platformIds = ENABLED_PLATFORM_IDS.length
    ? [...ENABLED_PLATFORM_IDS]
    : [...new Set(platformRows.map((row) => String(row.id)))]
  return [
    ...shape(platformIds, platformRows, 'platforms'),
    ...shape([...GENRE_IDS], genreRows, 'genres'),
  ]
}

export async function taxonomyRows() {
  const [platformRows, genreRows] = await Promise.all([
    query(
      `SELECT platform AS id, MAX(COALESCE(updated_at, created_at, added_at)) AS latest
         FROM games WHERE hidden = 0
        GROUP BY platform`,
    ),
    query(
      `SELECT gg.genre_id AS id, MAX(COALESCE(g.updated_at, g.created_at, g.added_at)) AS latest
         FROM game_genres gg JOIN games g ON g.id = gg.game_id
        WHERE g.hidden = 0
        GROUP BY gg.genre_id`,
    ),
  ])
  return pickTaxonomyRows(platformRows, genreRows)
}

export async function taxonomySitemap(req, res, next) {
  try {
    const language = String(req.params.language || '')
    if (!languageCodes.has(language)) {
      return res.status(404).set('Cache-Control', CACHE.notFound).type('text/plain').send('Not Found')
    }
    const rows = await taxonomyRows()
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(buildTaxonomySitemap(rows, language))
  } catch (error) {
    next(error)
  }
}


/* ---------------- sitemap 索引 ---------------- */

const STATIC_SITEMAP = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  'dist/client/sitemap-static.xml',
)

/** 构建产物里那份静态 sitemap 的时间；没构建过就不写 lastmod（协议里它是可选的）。 */
function staticSitemapLastmod() {
  try {
    return dateOnly(statSync(STATIC_SITEMAP).mtime)
  } catch {
    return ''
  }
}

/**
 * sitemap 索引。
 *
 * 为什么不能只用构建时生成的 public/sitemap.xml：那份里 8 条游戏 sitemap 的 lastmod
 * 是**构建当天**的日期，之后后台再上架多少款游戏它都不变。索引里的 lastmod 恰恰是
 * 搜索引擎判断「这份子 sitemap 要不要重新抓」的依据 —— 不变就等于告诉它们不必再看，
 * 于是游戏 sitemap 明明已经实时更新了，抓取却迟迟不来。
 * 这里把 lastmod 换成数据库里可见游戏的最新更新时间，上架即变。
 */
export function buildSitemapIndex({
  siteUrl = publicSiteUrl(),
  staticLastmod = '',
  gamesLastmod = '',
  postsLastmod = '',
  taxonomyLastmod = '',
} = {}) {
  /**
   * 每一类的 lastmod 都单独算，不共用一个时间戳。
   *
   * 索引里的 lastmod 是搜索引擎判断「这份子 sitemap 要不要重新抓」的唯一依据。
   * 共用的话，改一款游戏就会把 8 份文章 sitemap 的 lastmod 一起顶新，
   * 等于每次上架都骗它回来重抓一批没变过的文章；反过来漏更新则是它永远不回来。
   */
  const files = [
    { loc: `${siteUrl}/sitemap-static.xml`, lastmod: staticLastmod },
    ...SITE_LANGUAGES.map(({ code }) => ({
      loc: `${siteUrl}/sitemaps/games-${code}.xml`,
      lastmod: gamesLastmod,
    })),
    ...SITE_LANGUAGES.map(({ code }) => ({
      loc: `${siteUrl}/sitemaps/posts-${code}.xml`,
      lastmod: postsLastmod,
    })),
    ...SITE_LANGUAGES.map(({ code }) => ({
      loc: `${siteUrl}/sitemaps/taxonomy-${code}.xml`,
      lastmod: taxonomyLastmod,
    })),
  ]
  const entries = files.map(
    ({ loc, lastmod }) =>
      `  <sitemap>\n    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </sitemap>`,
  )
  return `${XML_HEADER}\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`
}

export async function sitemapIndex(_req, res, next) {
  try {
    const [gameRows, postRows] = await Promise.all([
      query('SELECT MAX(COALESCE(updated_at, created_at, added_at)) AS latest FROM games WHERE hidden = 0'),
      query('SELECT MAX(COALESCE(updated_at, created_at)) AS latest FROM posts WHERE published = 1'),
    ])
    // 一篇文章都没发布 / 一款游戏都没上架时 MAX() 是 NULL。这时不写 lastmod
    //（协议里它是可选的），而不是退回今天 —— 退回今天等于每天都宣告「有更新」，
    // 让搜索引擎白跑一趟，正好是我们想避免的那件事。
    const gamesLastmod = dateOnly(gameRows?.[0]?.latest)
    const postsLastmod = dateOnly(postRows?.[0]?.latest)
    // 平台页 / 类型页的内容就是那批游戏，所以跟着游戏的最新更新时间走。
    const taxonomyLastmod = gamesLastmod
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(
      buildSitemapIndex({
        siteUrl: publicSiteUrl(),
        staticLastmod: staticSitemapLastmod(),
        gamesLastmod,
        postsLastmod,
        taxonomyLastmod,
      }),
    )
  } catch (error) {
    next(error)
  }
}
