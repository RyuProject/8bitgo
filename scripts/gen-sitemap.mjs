/**
 * 生成 sitemap 索引和构建期静态 sitemap。
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

/**
 * 读 .env 里的值。
 *
 * ⚠️ 顺序必须和 Vite 一致：`.env.production.local` > `.env.local` > `.env` > `.env.example`，
 * 后读到的覆盖先读到的。以前这里是 `.env` 优先并且读到就返回，跟 Vite 正好相反 ——
 * 结果构建产物里烘的是 .env.local 的正式域名，sitemap 和 robots.txt 里却是 .env 的
 * 本地地址，上线后整份 sitemap 和全部 hreflang 互指都指向 127.0.0.1，等于作废。
 */
function envValue(key, fallback) {
  let found
  for (const f of ['.env.example', '.env', '.env.local', '.env.production', '.env.production.local']) {
    const p = root + f
    if (!existsSync(p)) continue
    const m = readFileSync(p, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
    if (m && m[1].trim()) found = m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return found ?? fallback
}

const SITE = envValue('VITE_SITE_URL', 'https://8bitgo.com').replace(/\/+$/, '')

const RAW_API = envValue('VITE_API_URL', '').trim()
/**
 * VITE_API_URL=same-origin 表示「和站点同域」，是给浏览器用的相对路径写法。
 * 这个脚本在 Node 里跑，fetch 需要绝对地址，所以要换算成本地后端地址；
 * 以前直接拿 'same-origin' 去 fetch，抛 URL 解析错误被 catch 吞掉，
 * 静默退回内置演示数据 —— sitemap 里永远没有数据库里真实上架的游戏。
 */
const LOCAL_API = `http://127.0.0.1:${process.env.PORT || 8788}`
const API = (RAW_API === 'same-origin' || RAW_API === '/' ? LOCAL_API : RAW_API).replace(/\/+$/, '')

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

// 平台白名单和类型 id 都在 shared/site-taxonomy.js（纯 .js，后端也 import 同一份），
// 所以不用再走 loadTs / esbuild。
const { ENABLED_PLATFORM_IDS, isPlatformEnabledId } = await import('../shared/site-taxonomy.js')
const enabled = ENABLED_PLATFORM_IDS
const LANGUAGES = await loadTs('src/config/languages.ts', 'LANGUAGES')
const DEFAULT_LANG = await loadTs('src/config/languages.ts', 'DEFAULT_LANG')
const FALLBACK_LANG = await loadTs('src/config/languages.ts', 'FALLBACK_LANG')
const HREFLANG = await loadTs('src/config/languages.ts', 'HREFLANG')
/**
 * 取全部游戏。
 *
 * v2 的 /api/games 返回的是**一页**（{items, total, page, totalPages}），不再是整个数组 ——
 * 这正是为了让上千款游戏时前台不用下载整个目录。但 sitemap 恰恰需要全量，
 * 所以这里按页翻完。翻页上限兜一道，避免接口异常时无限循环。
 */
async function fetchAllGames() {
  const first = await fromApi('/api/games?pageSize=100&page=1')
  if (!first) return null
  // 兼容 v1 的数组形状：老部署里可能还跑着旧后端
  if (Array.isArray(first)) return first
  if (!Array.isArray(first.items)) return null
  const all = [...first.items]
  const totalPages = Math.min(Number(first.totalPages) || 1, 200)
  for (let p = 2; p <= totalPages; p++) {
    const page = await fromApi(`/api/games?pageSize=100&page=${p}`)
    if (!page?.items?.length) break
    all.push(...page.items)
  }
  return all
}

let games = await fetchAllGames()
if (!games) {
  games = await loadTs('src/data/games.ts', 'games')
  console.log(`  （用内置数据；${API ? `连不上后端 ${API}，请先启动 server/ 再跑 npm run sitemap` : '配置 VITE_API_URL 后会改从数据库读取'}）`)
} else {
  console.log(`  （从后端 API 读到 ${games.length} 款游戏）`)
}
let posts = await fromApi('/api/posts')
if (!Array.isArray(posts)) posts = await loadTs('src/data/posts.ts', 'posts')


// 隐藏的游戏、未发布的文章、未启用的平台都不该进 sitemap
// ⚠️ 用 isPlatformEnabledId 而不是 enabled.includes：白名单清空成 [] 的语义是
// 「全部平台开放」，写 includes 的话会反过来变成「全部平台都被禁」，sitemap 直接空掉。
const visibleGames = games.filter((g) => !g.hidden && isPlatformEnabledId(g.platform))
const visiblePosts = posts.filter((p) => p.published !== false)

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
add('/about', '0.5', 'monthly')
// 筛选页（/games?platform=…、?genre=…）不进 sitemap：
// 这些页面自己的 canonical 指向 /games，收进来只会让 Search Console 报
// 「Alternate page with proper canonical tag」；而且 robots.txt 里 Disallow: /games?
// 本来就禁止抓取它们，放进 sitemap 属于自相矛盾。
/**
 * 这份静态 sitemap 现在**只放上面那些真正固定的页面**。
 *
 * 平台页 /platforms/<id>、类型页 /genres/<id>、游戏详情页、文章详情页全都不在这里 ——
 * 它们的存在与否只有数据库知道，烘进构建产物就意味着「不重新部署永远不更新」。
 * 这个坑真出过事：上线后后台陆续加了上百款游戏，线上 sitemap 里却长期只有
 * /platforms/flash 和 /platforms/html5 两个平台页，全部类型页一条都没有。
 *
 * 现在它们由后端实时生成（见 server/src/routes/sitemaps.js）：
 *   /sitemaps/games-<lang>.xml     游戏详情
 *   /sitemaps/posts-<lang>.xml     文章详情
 *   /sitemaps/taxonomy-<lang>.xml  平台页 + 类型页
 * 下面只统计数量，好在构建日志里和数据库实际情况对一眼。
 */
const visiblePlatformCount = new Set(visibleGames.map((g) => g.platform)).size
const visibleGenreCount = new Set(visibleGames.flatMap((g) => g.genres ?? [])).size

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
  // 和页面 head 保持一致：访客语言不在支持列表中时，统一落到英语版。
  `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(SITE + localized(path, FALLBACK_LANG))}" />`

const staticXml = `<?xml version="1.0" encoding="UTF-8"?>
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

writeFileSync(root + 'public/sitemap-static.xml', staticXml, 'utf8')

/**
 * 游戏和文章都不烘进构建产物：后台可以在两次部署之间继续上架游戏、发布文章，
 * 静态 sitemap 会漏掉它们。主索引直接列出每种语言各 3 份动态 sitemap，由后端每次从数据库
 * 生成；每种语言拆一份，也避免未来游戏数增长后撞上单份 sitemap 最多 50,000 URL 的上限。
 */
const sitemapFiles = [
  `${SITE}/sitemap-static.xml`,
  ...LANGUAGES.map((language) => `${SITE}/sitemaps/games-${language.code}.xml`),
  ...LANGUAGES.map((language) => `${SITE}/sitemaps/posts-${language.code}.xml`),
  ...LANGUAGES.map((language) => `${SITE}/sitemaps/taxonomy-${language.code}.xml`),
]
const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapFiles.map((loc) => `  <sitemap>
    <loc>${esc(loc)}</loc>
    <lastmod>${today}</lastmod>
  </sitemap>`).join('\n')}
</sitemapindex>
`
writeFileSync(root + 'public/sitemap.xml', sitemapIndex, 'utf8')

// robots.txt 里的 Sitemap 行跟着域名走
const robotsPath = root + 'public/robots.txt'
if (existsSync(robotsPath)) {
  const r = readFileSync(robotsPath, 'utf8').replace(/^Sitemap:.*$/m, `Sitemap: ${SITE}/sitemap.xml`)
  writeFileSync(robotsPath, r, 'utf8')
}

console.log(`✅ sitemap.xml：1 份静态 + 每种语言各 3 份动态（游戏 / 文章 / 平台类型），共 ${1 + LANGUAGES.length * 3} 份`)
console.log(`   sitemap-static.xml：${entries.length} 条 URL（${urls.length} 个固定页面 × ${LANGUAGES.length} 种语言）`)
console.log(`   由后端实时生成（下列数字只是构建时的快照，线上以数据库为准）：`)
console.log(`     游戏 ${visibleGames.length} 款 / 文章 ${visiblePosts.length} 篇 / 平台 ${visiblePlatformCount} 个 / 类型 ${visibleGenreCount} 个`)
console.log(`   域名：${SITE}`)
