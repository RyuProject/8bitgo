/**
 * 按 ROM 重算 auto 模式游戏的联机人数（见 src/netplay-auto.js）。
 *
 *   cd server && npm run netplay-players -- --dry-run   只列出会怎么改
 *   cd server && npm run netplay-players                真正写入
 *
 * `npm run migrate` 已经会做同一件事；这个脚本用来在部署前预览，或者
 * 更新 shared/arcade-players.json 之后单独重跑。
 */
import 'dotenv/config'
import { query, pool } from '../src/db.js'
import { recomputeAllNetplay } from '../src/netplay-auto.js'

const dryRun = process.argv.includes('--dry-run')
const changed = await recomputeAllNetplay(query, { dryRun })
const label = (v) => (v.multiplayer ? `${v.players} 人联机` : '不联机')
for (const c of changed) {
  console.log(`${c.slug}: ${label(c.from)} → ${label(c.to)}${c.inferred != null ? `（FBNeo ${c.inferred} 人）` : ''}`)
}
console.log(`${dryRun ? '将改动' : '已改动'} ${changed.length} 款`)
await pool.end()
