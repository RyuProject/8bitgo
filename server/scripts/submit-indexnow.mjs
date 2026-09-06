/**
 * 首次启用 IndexNow、或者自动提交曾经失败时，手动全量补交。
 *
 * 覆盖三类内容：上架游戏详情页、已发布文章详情页、平台/类型聚合页 ——
 * 每一类都会展开成全部 8 种语言的 URL。
 * （以前这里只捞游戏；文章和聚合页有独立的 H1、正文与结构化数据，却从来
 *   没被主动提交过。IndexNow 实际上没有配额压力，没有理由漏掉它们。）
 *
 * 用法：
 *   cd server && npm run indexnow
 *   cd server && npm run indexnow -- --dry-run     # 只打印，不发请求
 *   cd server && npm run indexnow -- --only games  # games / posts / taxonomy
 *
 * 只提交本站 URL；IndexNow 单次最多 10,000 条，底层会自动分批。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { gameDetailUrls, postDetailUrls, publicSiteUrl, submitIndexNowUrls, taxonomyDetailUrls } from '../src/indexnow.js'
import { taxonomyRows } from '../src/routes/sitemaps.js'

const argv = process.argv.slice(2)
const KINDS = ['games', 'posts', 'taxonomy']
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
const dryRun = argv.includes('--dry-run')

if (only !== undefined && !KINDS.includes(only)) {
  console.error(`--only 只能是：${KINDS.join(' / ')}`)
  process.exit(1)
}
const wants = (kind) => only === undefined || only === kind

try {
  const siteUrl = publicSiteUrl()
  const groups = []

  if (wants('games')) {
    const rows = await query('SELECT slug FROM games WHERE hidden = 0 ORDER BY id ASC')
    groups.push({ label: '游戏详情页', items: rows.length, urls: rows.flatMap((row) => gameDetailUrls(row.slug, siteUrl)) })
  }

  if (wants('posts')) {
    // 草稿在前台是 404，不推。
    const rows = await query('SELECT slug FROM posts WHERE published = 1 ORDER BY id ASC')
    groups.push({ label: '文章详情页', items: rows.length, urls: rows.flatMap((row) => postDetailUrls(row.slug, siteUrl)) })
  }

  if (wants('taxonomy')) {
    // 复用 sitemap 那份筛选：空平台、白名单外的平台、已下线的类型都已经被剔掉了。
    const rows = await taxonomyRows()
    groups.push({ label: '平台 / 类型页', items: rows.length, urls: taxonomyDetailUrls(rows, siteUrl) })
  }

  const seen = new Set()
  const urls = []
  for (const group of groups) {
    for (const url of group.urls) {
      if (seen.has(url)) continue
      seen.add(url)
      urls.push(url)
    }
  }

  console.log(`站点：${siteUrl}`)
  for (const group of groups) console.log(`  ${group.label}：${group.items} 项 → ${group.urls.length} 个 URL`)
  console.log(`合计（去重后）：${urls.length} 个 URL`)

  if (!urls.length) {
    console.log('没有需要提交的 URL。')
  } else if (dryRun) {
    console.log('--dry-run：以下 URL 不会真的提交')
    for (const url of urls.slice(0, 20)) console.log(`  ${url}`)
    if (urls.length > 20) console.log(`  …… 其余 ${urls.length - 20} 条`)
  } else {
    const result = await submitIndexNowUrls(urls, { enabled: true, siteUrl })
    console.log(`✅ IndexNow 已接收 ${result.submitted} 个 URL（${result.batches} 批）`)
  }
} catch (error) {
  console.error(`❌ IndexNow 提交失败：${error?.message || error}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
