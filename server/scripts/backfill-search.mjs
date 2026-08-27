/**
 * 把现有全库灌进搜索倒排索引。
 * 用法：cd server && npm run backfill-search
 *
 * 什么时候要跑：
 *   - 第一次上这个功能（migrate 建出来的表是空的）
 *   - 改过 src/search.js 的分词 / 权重规则
 *   - 直接改过数据库、绕开了后台接口
 *
 * 分批处理，不会把整个游戏库读进内存；重复跑没有副作用（每款游戏都是先删后插）。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { buildGameTokens } from '../src/search.js'

const BATCH = 500
const CHUNK = 400

const t0 = Date.now()
let done = 0
let tokens = 0
let lastId = 0

try {
  const [{ n: total }] = await query('SELECT COUNT(*) AS n FROM games')
  console.log(`共 ${total} 款游戏，开始重建索引…`)

  for (;;) {
    // 按 id 游标翻页，不用 OFFSET —— 十万行时 OFFSET 会越翻越慢
    const rows = await query(
      'SELECT id, title, title_zh, developer FROM games WHERE id > ? ORDER BY id LIMIT ?',
      [lastId, BATCH],
    )
    if (!rows.length) break
    lastId = rows[rows.length - 1].id

    const ids = rows.map((r) => r.id)
    const holes = ids.map(() => '?').join(',')
    const tagRows = await query(`SELECT game_id, tag FROM game_tags WHERE game_id IN (${holes})`, ids)
    const tagsBy = new Map()
    for (const r of tagRows) {
      const k = String(r.game_id)
      if (!tagsBy.has(k)) tagsBy.set(k, [])
      tagsBy.get(k).push(r.tag)
    }

    await query(`DELETE FROM game_search_tokens WHERE game_id IN (${holes})`, ids)

    /** 攒成一条大 INSERT，一款一条会让往返次数等于游戏数 */
    const values = []
    for (const r of rows) {
      const map = buildGameTokens({ ...r, tags: tagsBy.get(String(r.id)) ?? [] })
      for (const [token, weight] of map) values.push([token, r.id, weight])
    }
    for (let i = 0; i < values.length; i += CHUNK) {
      const part = values.slice(i, i + CHUNK)
      await query(
        `INSERT INTO game_search_tokens (token, game_id, weight) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}
         ON DUPLICATE KEY UPDATE weight = VALUES(weight)`,
        part.flat(),
      )
    }
    done += rows.length
    tokens += values.length
    process.stdout.write(`\r  ${done}/${total}  索引条目 ${tokens}`)
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n✅ 完成：${done} 款游戏，${tokens} 条索引，用时 ${secs}s`)
  console.log(`   平均每款 ${done ? (tokens / done).toFixed(1) : 0} 条`)
} catch (e) {
  console.error('\n❌ 重建失败：', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
