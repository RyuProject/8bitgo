import { query } from '../db.js'
import { CACHE } from '../cache.js'
import { localizedPublicUrl, publicSiteUrl } from '../indexnow.js'
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

