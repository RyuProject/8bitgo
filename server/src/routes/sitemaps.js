import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '../db.js'
import { CACHE } from '../cache.js'
import { localizedPublicUrl, publicSiteUrl } from '../site-urls.js'
import { SITE_LANGUAGES } from '../../../shared/site-languages.js'

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'
const languageCodes = new Set(SITE_LANGUAGES.map((item) => item.code))

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 10)
}

/**
 * 每种语言单独一份，避免游戏增长后「游戏数 × 8 种语言」撞上单份 sitemap
 * 最多 50,000 URL 的协议上限。各语言之间的关系由页面 head 的 hreflang 说明。
 */
export function buildGameSitemap(rows, language, siteUrl = publicSiteUrl()) {
  if (!languageCodes.has(language)) throw new Error(`不支持的 sitemap 语言：${language}`)
  const entries = rows.map((row) => {
    const loc = localizedPublicUrl(`/games/${encodeURIComponent(String(row.slug))}`, language, siteUrl)
    const lastmod = dateOnly(row.updated_at || row.created_at || row.added_at)
    return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`
  })
  return `${XML_HEADER}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
}

/** 始终从数据库读取上架游戏，后台新增后不需要等下一次前端构建。 */
export async function gameSitemap(req, res, next) {
  try {
    const language = String(req.params.language || '')
    if (!languageCodes.has(language)) {
      return res.status(404).set('Cache-Control', CACHE.notFound).type('text/plain').send('Not Found')
    }
    const rows = await query(
      'SELECT slug, added_at, created_at, updated_at FROM games WHERE hidden = 0 ORDER BY id ASC',
    )
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res.type('application/xml; charset=utf-8').send(buildGameSitemap(rows, language))
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
export function buildSitemapIndex(gamesLastmod, siteUrl = publicSiteUrl(), staticLastmod = '') {
  const files = [
    { loc: `${siteUrl}/sitemap-static.xml`, lastmod: staticLastmod },
    ...SITE_LANGUAGES.map(({ code }) => ({
      loc: `${siteUrl}/sitemaps/games-${code}.xml`,
      lastmod: gamesLastmod,
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
    const rows = await query(
      'SELECT MAX(COALESCE(updated_at, created_at, added_at)) AS latest FROM games WHERE hidden = 0',
    )
    const latest = dateOnly(rows?.[0]?.latest) || dateOnly(new Date())
    res.setHeader('Cache-Control', CACHE.meta)
    res.setHeader('Vary', 'Accept-Encoding')
    res
      .type('application/xml; charset=utf-8')
      .send(buildSitemapIndex(latest, publicSiteUrl(), staticSitemapLastmod()))
  } catch (error) {
    next(error)
  }
}
