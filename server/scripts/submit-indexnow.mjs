/**
 * 首次启用 IndexNow、或者自动提交曾经失败时，手动补交数据库里全部上架游戏。
 *
 * 用法：cd server && npm run indexnow
 * 只提交本站 URL；IndexNow 单次最多 10,000 条，底层会自动分批。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { gameDetailUrls, publicSiteUrl, submitIndexNowUrls } from '../src/indexnow.js'

try {
  const rows = await query('SELECT slug FROM games WHERE hidden = 0 ORDER BY id ASC')
  const siteUrl = publicSiteUrl()
  const urls = rows.flatMap((row) => gameDetailUrls(row.slug, siteUrl))
  const result = await submitIndexNowUrls(urls, { enabled: true, siteUrl })
  console.log(`✅ IndexNow 已接收 ${result.submitted} 个游戏 URL（${rows.length} 款游戏，${result.batches} 批）`)
  console.log(`   站点：${siteUrl}`)
} finally {
  await pool.end()
}

