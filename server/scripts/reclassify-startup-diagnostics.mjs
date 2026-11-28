#!/usr/bin/env node
/**
 * 用当前诊断规则修正保留期内证据更强的历史现场，并同步更新后台归组签名。
 * 默认只预览；必须显式传 --apply 才写入。此脚本不改漏斗事件、不发告警，也不删除现场。
 *
 *   cd server && node scripts/reclassify-startup-diagnostics.mjs --days=30
 *   cd server && node scripts/reclassify-startup-diagnostics.mjs --days=30 --apply
 */
import 'dotenv/config'
import { pool, query, withTransaction } from '../src/db.js'
import { reclassifyStartupDiagnostic } from '../src/startup-diagnostics.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const daysArg = args.find((arg) => arg.startsWith('--days='))?.slice('--days='.length) ?? '30'
const batchArg = args.find((arg) => arg.startsWith('--batch-size='))?.slice('--batch-size='.length) ?? '200'
const maxArg = args.find((arg) => arg.startsWith('--max-rows='))?.slice('--max-rows='.length) ?? '0'
const days = Number(daysArg)
const batchSize = Number(batchArg)
const maxRows = Number(maxArg)
const unknown = args.filter((arg) => arg !== '--apply' && !arg.startsWith('--days=') &&
  !arg.startsWith('--batch-size=') && !arg.startsWith('--max-rows='))

if (unknown.length || !Number.isInteger(days) || days < 1 || days > 30 ||
  !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000 ||
  !Number.isInteger(maxRows) || maxRows < 0) {
  console.error('参数无效：--days 为 1–30，--batch-size 为 1–1000，--max-rows 为 0（不限）或正整数；写库必须显式传 --apply。')
  process.exitCode = 2
} else {
  try {
    // 固定本轮扫描的主键上界，避免部署期间持续写入的新现场让维护任务一直追着跑。
    const [snapshot] = await query(
      `SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) AS maxId
         FROM game_startup_diagnostics
        WHERE created_at >= UTC_TIMESTAMP() - INTERVAL ${days} DAY
          AND event IN ('failed', 'timeout', 'slow_start')`,
    )
    const maxId = String(snapshot?.maxId ?? '0')
    let lastId = '0'
    let scanned = 0
    let changed = 0
    const byCode = new Map()
    while (maxRows === 0 || scanned < maxRows) {
      const size = maxRows === 0 ? batchSize : Math.min(batchSize, maxRows - scanned)
      const rows = await query(
        `SELECT CAST(id AS CHAR) AS id, event, runtime, platform, elapsed_ms AS elapsedMs, payload
          FROM game_startup_diagnostics
          WHERE id > ?
            AND id <= ?
            AND created_at >= UTC_TIMESTAMP() - INTERVAL ${days} DAY
            AND event IN ('failed', 'timeout', 'slow_start')
          ORDER BY id ASC
          LIMIT ${size}`,
        [lastId, maxId],
      )
      if (!rows.length) break
      scanned += rows.length
      lastId = String(rows[rows.length - 1].id)
      const updates = rows.flatMap((row) => {
        const result = reclassifyStartupDiagnostic(row)
        if (!result) return []
        const code = result.diagnostics.diagnosis?.code ?? 'unknown'
        byCode.set(code, (byCode.get(code) ?? 0) + 1)
        return [{ id: String(row.id), ...result }]
      })
      changed += updates.length
      if (apply && updates.length) {
        await withTransaction(async (run) => {
          for (const update of updates) {
            await run(
              `UPDATE game_startup_diagnostics
                  SET signature = ?, signature_text = ?, payload = ?
                WHERE id = ?`,
              [update.signature, update.signatureText, JSON.stringify(update.diagnostics), update.id],
            )
          }
        })
      }
      if (rows.length < size) break
    }
    console.log(`${apply ? '已修正' : '预览可修正'} ${changed} 条，检查 ${scanned} 条（${days} 天内）；新分类：${JSON.stringify(Object.fromEntries(byCode))}`)
    if (!apply) console.log('未写库；检查分类数量后加 --apply 执行。')
  } catch (error) {
    console.error('历史启动诊断重分类失败：', error?.message || error)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
