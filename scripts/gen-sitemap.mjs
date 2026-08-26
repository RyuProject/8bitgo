/**
 * 生成 public/sitemap.xml。
 *
 * 数据来源优先级：
 *   1) 后端 API（.env 里配了 VITE_API_URL 时）—— 上架后以数据库为准
 *   2) 项目内置的 src/data/*.ts —— 没有后端时的兜底
 *
 * 用法：npm run sitemap     （build 前会自动执行，见 package.json 的 prebuild）
 * 站点域名取 .env 的 VITE_SITE_URL，没配则用 https://8bitgo.com。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

function envValue(key, fallback) {
  for (const f of ['.env', '.env.local', '.env.example']) {
    const p = root + f
    if (!existsSync(p)) continue
    const m = readFileSync(p, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
    if (m && m[1].trim()) return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return fallback
}

const SITE = envValue('VITE_SITE_URL', 'https://8bitgo.com').replace(/\/+$/, '')
const API = envValue('VITE_API_URL', '').replace(/\/+$/, '')

async function loadTs(rel, name) {
  const r = await build({
    entryPoints: [root + rel], bundle: true, format: 'esm',
    platform: 'node', write: false, logLevel: 'silent',
  })
  const mod = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'))
  return mod[name]
}

async function fromApi(path) {
  if (!API) return null
  try {
    const res = await fetch(`${API}${path}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const enabled = await loadTs('src/config/platforms.ts', 'ENABLED_PLATFORMS')
const LANGUAGES = await loadTs('src/config/languages.ts', 'LANGUAGES')
const DEFAULT_LANG = await loadTs('src/config/languages.ts', 'DEFAULT_LANG')
const HREFLANG = await loadTs('src/config/languages.ts', 'HREFLANG')
let games = await fromApi('/api/games')
if (!games) {
  games = await loadTs('src/data/games.ts', 'games')
  console.log('  （用内置数据；配置 VITE_API_URL 后会改从数据库读取）')
} else {
  console.log(`  （从后端 API 读到 ${games.length} 款游戏）`)
}
let posts = await fromApi('/api/posts')
if (!posts) posts = await loadTs('src/data/posts.ts', 'posts')

const genres = await loadTs('src/data/genres.ts', 'genres')
const platforms = await loadTs('src/data/platforms.ts', 'platforms')

// 隐藏的游戏、未发布的文章、未启用的平台都不该进 sitemap
const visibleGames = games.filter((g) => !g.hidden && enabled.includes(g.platform))
const visiblePosts = posts.filter((p) => p.published !== false)
const visiblePlatforms = platforms.filter((p) => enabled.includes(p.id))

const today = new Date().toISOString().slice(0, 10)
const urls = []
const add = (path, priority, changefreq) => urls.push({ path, priority, changefreq })

add('/', '1.0', 'daily')
add('/games', '0.9', 'daily')
add('/platforms', '0.8', 'weekly')
add('/genres', '0.8', 'weekly')
add('/developers', '0.6', 'weekly')
add('/play-local', '0.6', 'monthly')
add('/blog', '0.7', 'weekly')
for (const p of visiblePlatforms) add(`/games?platform=${p.id}`, '0.7', 'weekly')
for (const g of genres) add(`/games?genre=${g.id}`, '0.7', 'weekly')
for (const g of visibleGames) add(`/games/${encodeURIComponent(g.slug)}`, '0.8', 'weekly')
for (const p of visiblePosts) add(`/blog/${encodeURIComponent(p.slug)}`, '0.5', 'monthly')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 某语言下的完整路径：默认语言不带前缀 */
const localized = (path, lang) => {
  const prefix = lang === DEFAULT_LANG ? '' : '/' + lang
  if (path === '/') return prefix || '/'
  return prefix + path
}

/**
 * 每个页面输出 8 条 URL（每种语言一条），每条都用 xhtml:link 列出全部语言版本。
 * Google 要求 hreflang 必须「互相指向」，所以每个语言版本都要带完整的 alternates。
 */
const entries = []
for (const u of urls) {
  for (const l of LANGUAGES) {
    entries.push({ ...u, lang: l.code, loc: SITE + localized(u.path, l.code) })
  }
}

const alternatesFor = (path) =>
  LANGUAGES.map(
    (l) => `    <xhtml:link rel="alternate" hreflang="${HREFLANG[l.code]}" href="${esc(SITE + localized(path, l.code))}" />`,
  ).join('\n') +
  `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(SITE + localized(path, DEFAULT_LANG))}" />`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.map((u) => `  <url>
    <loc>${esc(u.loc)}</loc>
${alternatesFor(u.path)}
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`

writeFileSync(root + 'public/sitemap.xml', xml, 'utf8')

// robots.txt 里的 Sitemap 行跟着域名走
const robotsPath = root + 'public/robots.txt'
if (existsSync(robotsPath)) {
  const r = readFileSync(robotsPath, 'utf8').replace(/^Sitemap:.*$/m, `Sitemap: ${SITE}/sitemap.xml`)
  writeFileSync(robotsPath, r, 'utf8')
}

console.log(`✅ sitemap.xml：${entries.length} 条 URL（${urls.length} 个页面 × ${LANGUAGES.length} 种语言）（游戏 ${visibleGames.length}、文章 ${visiblePosts.length}、平台 ${visiblePlatforms.length}、类型 ${genres.length}）`)
console.log(`   域名：${SITE}`)
