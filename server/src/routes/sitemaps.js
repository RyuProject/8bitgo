import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '../db.js'
import { CACHE } from '../cache.js'
import { assetPublicUrl, localizedPublicUrl, publicSiteUrl } from '../site-urls.js'
import { SITE_DEFAULT_LANGUAGE, SITE_LANGUAGES } from '../../../shared/site-languages.js'
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
 * 从 JSON 列里取某个语言的译文。
 *
 * mysql2 会把 JSON 列直接解析成对象，但同一份代码也可能读到字符串
 * （不同驱动版本、或者列被存成了 TEXT），所以两种形状都认。认不出就当没翻译。
 */
function i18nText(raw, language) {
  let map = raw
  if (typeof map === 'string') {
    try {
      map = JSON.parse(map)
    } catch {
      return ''
    }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return ''
  const value = map[language]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 这一行内容在 `language` 下**有没有真正属于这门语言的正文**。
 *
 * ── 为什么 sitemap 要管这件事 ────────────────────────────────
 * 站点有 8 种语言，游戏 210 款 —— 全展开就是 1,680 条 URL 交给 Google。而译文是
 * **按需生成**的（见 [[8bitgo-i18n-content]] 那套 pretranslate）：没生成的语言，
 * 页面正文会一路回退到英文简介、繁体回退到简体（`i18nData.ts` 的 gameDescription
 * 就是这么写的，那是刻意的用户体验兜底，不是 bug）。
 *
 * 对读者这个兜底是好事，对搜索引擎是灾难：/de/、/es/、/fr/、/it/、/ja/ 五份页面的
 * 正文会是**同一段英文**。Google 抓上几条就得出「这站的 URL 不值得抓」的结论，
 * 剩下的全落进「已发现 - 尚未编入索引」（2026-09-08 实测：1,952 条里 929 条如此），
 * 顺带把真正有内容的页面也拖慢。抓取预算是全站共享的，喂重复页 = 从正文页那里偷。
 *
 * 所以规则是：**sitemap 只承诺那些正文确实是这门语言的 URL**。
 * 译文一生成，这里下一次被抓时就自动带上了 —— 不需要重新部署，也不用手工维护名单。
 *
 * ⚠️ 页面本身照旧可访问、head 里的 hreflang 照旧列全 8 种（Google 靠它归簇、
 * 也照样能从别处发现这些 URL）。这里减的只是「我们主动请它去抓」的那一份。
 *
 * ⚠️ 基准语言（zh-Hans）无条件保留：它是 canonical 那一条，
 * 连简介都还没写的游戏也得有一条 URL 进得去，否则整款游戏从 sitemap 里消失。
 *
 * @param row 数据库行
 * @param language 站点语言码（已经过 languageCodes 校验）
 * @param cols `{ i18n: 'description_i18n', en: 'description_en' }` —— 存译文的列名，
 *             `en` 是「这门语言有独立基准列」的特例（游戏的英文简介是单独一列，文章没有）
 */
export function hasLocalizedBody(row, language, cols = {}) {
  if (language === SITE_DEFAULT_LANGUAGE) return true
  if (cols.i18n && i18nText(row?.[cols.i18n], language)) return true
  // 英文简介在 games 里是独立的一列，不在 description_i18n 里
  if (language === 'en' && cols.en && String(row?.[cols.en] ?? '').trim()) return true
  return false
}

/** 这一类的译文列在数据库里不存在（migrate 还没跑），已经退回过一次 */
const missingI18nColumns = new Set()
const isUnknownColumn = (error) =>
  error?.code === 'ER_BAD_FIELD_ERROR' || /unknown column/i.test(String(error?.message || ''))

/**
 * 取 sitemap 的数据行：先按「带译文列」查，列不存在就退回原来那句，
 * 并**回报这一份数据到底带不带译文列**（`gate`）。
 *
 * 为什么要退回：译文列是靠 `npm run migrate` 加的，而这个仓库的常态是
 * **代码先上、迁移后跑**（见 [[8bitgo-local-env]]）。那个空窗期里如果直接抛，
 * sitemap.xml 会变成 500 —— 搜索引擎拿不到任何 URL，比「多提交了几百条重复页」
 * 严重得多。**记下来不再重试**：sitemap 是给爬虫打的，别为每次抓取都白扔一条错查询；
 * migrate 跑完之后进程重启一次就自然恢复。
 *
 * ⚠️ `gate` 这个返回值不是可选的讲究，是这段的**要害**：退回来的行里根本没有
 * `description_i18n` 这一列，此时若照旧按 hasLocalizedBody 过滤，
 * 每一行都会被判成「没有译文」—— 7 种语言的 sitemap 会**全部变成空的**，
 * 比不做这个功能糟糕一百倍，而且看不出来（XML 合法、HTTP 200、日志安静）。
 * 所以列不在时必须整个关掉过滤，退回「展开全部语言」的旧行为。
 */
async function sitemapRows(key, sqlWithI18n, sqlPlain) {
  if (!missingI18nColumns.has(key)) {
    try {
      return { rows: await query(sqlWithI18n), gate: true }
    } catch (error) {
      if (!isUnknownColumn(error)) throw error
      missingI18nColumns.add(key)
      console.warn(`[sitemap] ${key}：数据库还没有译文列，这一份退回「展开全部语言」（跑 npm run migrate 再重启即可）：`, error.message)
    }
  }
  return { rows: await query(sqlPlain), gate: false }
}

/**
 * 每种语言单独一份，避免游戏增长后「游戏数 × 8 种语言」撞上单份 sitemap
 * 最多 50,000 URL 的协议上限。各语言之间的关系由页面 head 的 hreflang 说明。
 */
export function buildGameSitemap(rows, language, siteUrl = publicSiteUrl(), { gate = true } = {}) {
  return buildUrlsetSitemap(
    // 只承诺正文确实是这门语言的那些游戏，见 hasLocalizedBody。
    // gate=false 是「这批行里没有译文列」，此时不能过滤，见 sitemapRows
    gate
      ? rows.filter((row) => hasLocalizedBody(row, language, { i18n: 'description_i18n', en: 'description_en' }))
      : rows,
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
    const { rows, gate } = await sitemapRows(
      'games',
      'SELECT slug, cover, added_at, created_at, updated_at, description_en, description_i18n FROM games WHERE hidden = 0 ORDER BY id ASC',
      'SELECT slug, cover, added_at, created_at, updated_at FROM games WHERE hidden = 0 ORDER BY id ASC',
    )
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(buildGameSitemap(rows, language, publicSiteUrl(), { gate }))
  } catch (error) {
    next(error)
  }
}


/* ---------------- 文章 sitemap ---------------- */

/**
 * 和游戏 sitemap 同构，单独一份的理由也一样：后台随时能发文章，
 * 烘进构建产物的话，不重新部署就永远进不了 sitemap。
 */
export function buildPostSitemap(rows, language, siteUrl = publicSiteUrl(), { gate = true } = {}) {
  // `date` 是作者手填的发布日期，可能留空也可能是未来日期，所以只当最后的兜底。
  return buildUrlsetSitemap(
    // 同游戏那套；文章没有「独立英文正文」这一列，所以 en 也得看 content_i18n
    gate ? rows.filter((row) => hasLocalizedBody(row, language, { i18n: 'content_i18n' })) : rows,
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
    const { rows, gate } = await sitemapRows(
      'posts',
      'SELECT slug, `date`, created_at, updated_at, content_i18n FROM posts WHERE published = 1 ORDER BY id ASC',
      'SELECT slug, `date`, created_at, updated_at FROM posts WHERE published = 1 ORDER BY id ASC',
    )
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(buildPostSitemap(rows, language, publicSiteUrl(), { gate }))
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
  /**
   * 哪几门语言的游戏 / 文章 sitemap 里**真的有 URL**。传 null = 全都有。
   *
   * 为什么要有这个：语言门控只承诺「正文确实是这门语言」的 URL，某门语言译文还没生成时
   * 那一份就是个合法但空的 `<urlset></urlset>`。而**空 sitemap 在 GSC 里是一条永久错误**
   * （报的是「XML 标记缺失：父标记 urlset，标记 url」—— 就是「里面一个 url 都没有」），
   * 2026-09-11 es / fr 两份正是这样。挂着的错误会一直响，还会盖住别的 sitemap 的真问题。
   *
   * ⚠️ **拿不准的时候一律当「有」。** 少列一门语言 = 那门语言整个从搜索引擎视野里消失，
   * 比多列一个空文件严重得多。所以 null、异常、译文列不存在，全都走「全列」。
   */
  gamesLangs = null,
  postsLangs = null,
} = {}) {
  const hasGames = (code) => !gamesLangs || gamesLangs.has(code)
  const hasPosts = (code) => !postsLangs || postsLangs.has(code)
  /**
   * 每一类的 lastmod 都单独算，不共用一个时间戳。
   *
   * 索引里的 lastmod 是搜索引擎判断「这份子 sitemap 要不要重新抓」的唯一依据。
   * 共用的话，改一款游戏就会把 8 份文章 sitemap 的 lastmod 一起顶新，
   * 等于每次上架都骗它回来重抓一批没变过的文章；反过来漏更新则是它永远不回来。
   */
  const files = [
    { loc: `${siteUrl}/sitemap-static.xml`, lastmod: staticLastmod },
    ...SITE_LANGUAGES.filter(({ code }) => hasGames(code)).map(({ code }) => ({
      loc: `${siteUrl}/sitemaps/games-${code}.xml`,
      lastmod: gamesLastmod,
    })),
    ...SITE_LANGUAGES.filter(({ code }) => hasPosts(code)).map(({ code }) => ({
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

/**
 * 算出哪几门语言的 games / posts sitemap 里真的有 URL，好让索引不去列空文件。
 *
 * ⚠️ **失败方向必须是「全列」。** 少列一门语言 = 那门语言整个从搜索引擎视野里消失；
 * 多列一个空文件只是 GSC 里一条警告。所以：译文列不存在（gate=false）→ null，
 * 查询抛了 → null，两者调用方都当成「全都有」。
 *
 * 查的是**只带 i18n 列的轻量版**，不是 sitemap 那两句完整查询 —— 这里只需要判断有没有，
 * 不需要 slug / 封面 / 时间。`/sitemap.xml` 本身带 CACHE.meta（边缘缓存 1 小时），
 * 多这两句不会打到库上。
 */
async function langsWithContent() {
  const pick = (rows, gate, cols) => {
    if (!gate) return null
    const set = new Set()
    for (const { code } of SITE_LANGUAGES) {
      if (rows.some((row) => hasLocalizedBody(row, code, cols))) set.add(code)
    }
    return set
  }
  try {
    const [g, p] = await Promise.all([
      sitemapRows(
        'index-games',
        'SELECT description_en, description_i18n FROM games WHERE hidden = 0',
        'SELECT slug FROM games WHERE hidden = 0',
      ),
      sitemapRows(
        'index-posts',
        'SELECT content_i18n FROM posts WHERE published = 1',
        'SELECT slug FROM posts WHERE published = 1',
      ),
    ])
    return {
      gamesLangs: pick(g.rows, g.gate, { i18n: 'description_i18n', en: 'description_en' }),
      postsLangs: pick(p.rows, p.gate, { i18n: 'content_i18n' }),
    }
  } catch (error) {
    console.warn('[sitemap] 算不出各语言有没有内容，索引照旧全列：', error?.message)
    return { gamesLangs: null, postsLangs: null }
  }
}

export async function sitemapIndex(_req, res, next) {
  try {
    const [gameRows, postRows, langs] = await Promise.all([
      query('SELECT MAX(COALESCE(updated_at, created_at, added_at)) AS latest FROM games WHERE hidden = 0'),
      query('SELECT MAX(COALESCE(updated_at, created_at)) AS latest FROM posts WHERE published = 1'),
      langsWithContent(),
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
        // 没译文的语言那一份是空的，空 sitemap 在 GSC 里是永久错误 —— 干脆别列
        gamesLangs: langs.gamesLangs,
        postsLangs: langs.postsLangs,
      }),
    )
  } catch (error) {
    next(error)
  }
}
