#!/usr/bin/env node
/**
 * 给最近的启动失败 / 超时 / 慢启动补齐明确标记的摘要现场。
 * 默认只预览；只有显式传 --apply 才写库。最多回看诊断包的 30 天保留窗口。
 *
 *   cd server && node scripts/backfill-startup-diagnostics.mjs
 *   cd server && node scripts/backfill-startup-diagnostics.mjs --days=7 --apply
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { recordStartupDiagnostics } from '../src/startup-diagnostics.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const daysArg = args.find((arg) => arg.startsWith('--days='))?.slice('--days='.length) ?? '7'
const limitArg = args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length) ?? '500'
const days = Number(daysArg)
const limit = Number(limitArg)
const unknown = args.filter((arg) => arg !== '--apply' && !arg.startsWith('--days=') && !arg.startsWith('--limit='))

if (unknown.length || !Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(limit) || limit < 1 || limit > 5000) {
  console.error('参数无效：--days 只能是 1–30，--limit 只能是 1–5000；写库必须显式传 --apply。')
  process.exitCode = 2
} else {
  try {
    const rows = await query(
      `SELECT g.slug, e.visit_id AS visitId, e.attempt_id AS attemptId,
              e.event, e.runtime, e.platform, e.country, e.elapsed_ms AS elapsedMs,
              e.detail, e.created_at AS createdAt
         FROM game_startup_events e
         JOIN games g ON g.id = e.game_id
         LEFT JOIN game_startup_diagnostics d
           ON d.visit_id = e.visit_id AND d.attempt_id = e.attempt_id AND d.event = e.event
        WHERE e.event IN ('failed', 'timeout', 'slow_start')
          AND e.created_at >= UTC_TIMESTAMP() - INTERVAL ${days} DAY
          AND d.id IS NULL
        ORDER BY e.created_at DESC
        LIMIT ${limit}`,
    )
    const counts = rows.reduce((out, row) => {
      out[row.event] = (out[row.event] || 0) + 1
      return out
    }, {})
    console.log(`${apply ? '准备补齐' : '预览缺失'} ${rows.length} 条（${days} 天内；上限 ${limit}）：${JSON.stringify(counts)}`)
    if (!apply) {
      console.log('未写库；确认数量后加 --apply 执行。')
    } else {
      let saved = 0
      for (const row of rows) {
        if (await recordStartupDiagnostics(row.slug, row, null, {
          country: row.country,
          summaryNote: 'backfill',
          suppressSideEffects: true,
        })) saved++
      }
      console.log(`完成：新增 ${saved} 条摘要，未新增 ${rows.length - saved} 条（可能是并发写入、游戏已下架或数据库错误）。`)
    }
  } catch (error) {
    console.error('启动诊断摘要回填失败：', error?.message || error)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
