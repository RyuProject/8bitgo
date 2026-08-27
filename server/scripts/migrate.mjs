/**
 * 建库建表 + 给已有库打补丁。
 * 用法：cd server && npm run migrate
 * 需要 .env 里的 DB_* 有建库权限（root 或有 CREATE 权限的账号）。
 *
 * 分三步：
 *   1. 建库并选中 —— 库名一律以 .env 的 DB_NAME 为准
 *   2. 执行 schema.sql —— 都是 CREATE TABLE IF NOT EXISTS，只对全新的库有效
 *   3. 打补丁 —— CREATE TABLE IF NOT EXISTS 不会给**已经建好**的表补上新增的列和索引，
 *      所以后来加的东西都要在这里逐条判断后执行。每条都是幂等的，重复跑没有副作用。
 *
 * ⚠️ schema.sql 里的 CREATE DATABASE / USE 写死了 `8bitgo`。以前是整个文件原样执行的，
 * 于是 DB_NAME 配成别的名字时，表建在 `8bitgo`，而后端和补丁检查连的是 DB_NAME 那个库 ——
 * 两边对不上，补丁会把「表根本不在这个库里」误判成「已是最新」，非常难查。
 * 现在把那两行剥掉，由本脚本按 DB_NAME 建库并 USE。
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const DB_NAME = process.env.DB_NAME || '8bitgo'

const schemaPath = fileURLToPath(new URL('../schema.sql', import.meta.url))
const rawSchema = await readFile(schemaPath, 'utf8')
// 剥掉写死库名的 CREATE DATABASE / USE，库名统一由 DB_NAME 决定
const schema = rawSchema
  .replace(/^\s*CREATE\s+DATABASE[\s\S]*?;\s*$/gim, '')
  .replace(/^\s*USE\s+[`'"]?[\w-]+[`'"]?\s*;\s*$/gim, '')

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
})

const one = async (q, p) => (await conn.query(q, p))[0][0]

/** 用 DATABASE() 而不是变量，保证检查的就是当前真正选中的库 */
async function hasTable(table) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  )
  return Number(r?.n ?? 0) > 0
}
async function hasColumn(table, column) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  )
  return Number(r?.n ?? 0) > 0
}
async function hasIndex(table, index) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, index],
  )
  return Number(r?.n ?? 0) > 0
}

/**
 * 补丁清单。每条给出 table，跑之前统一确认表在不在 ——
 * 「表不存在」和「已经是最新」是两回事，不能都报成 OK。
 * 新增补丁往后面追加，不要修改已有的。
 */
const patches = [
  {
    name: 'games.created_at（真实入库时间，用于自动生成上线日期）',
    table: 'games',
    needed: async () => !(await hasColumn('games', 'created_at')),
    run: () => conn.query('ALTER TABLE `games` ADD COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `roms`'),
  },
  {
    name: 'favorites.idx_fav_game（删游戏时按 game_slug 清理）',
    table: 'favorites',
    needed: async () => !(await hasIndex('favorites', 'idx_fav_game')),
    run: () => conn.query('ALTER TABLE `favorites` ADD INDEX `idx_fav_game` (`game_slug`)'),
  },
  {
    name: 'recents.idx_recent_game（同上）',
    table: 'recents',
    needed: async () => !(await hasIndex('recents', 'idx_recent_game')),
    run: () => conn.query('ALTER TABLE `recents` ADD INDEX `idx_recent_game` (`game_slug`)'),
  },
  {
    name: '清理孤儿收藏（指向已删除游戏的记录）',
    table: 'favorites',
    needed: async () => {
      if (!(await hasTable('games'))) return false
      const r = await one('SELECT COUNT(*) AS n FROM favorites f LEFT JOIN games g ON g.slug = f.game_slug WHERE g.slug IS NULL')
      return Number(r?.n ?? 0) > 0
    },
    run: () => conn.query('DELETE f FROM favorites f LEFT JOIN games g ON g.slug = f.game_slug WHERE g.slug IS NULL'),
  },
  {
    name: '清理孤儿最近游玩',
    table: 'recents',
    needed: async () => {
      if (!(await hasTable('games'))) return false
      const r = await one('SELECT COUNT(*) AS n FROM recents r LEFT JOIN games g ON g.slug = r.game_slug WHERE g.slug IS NULL')
      return Number(r?.n ?? 0) > 0
    },
    run: () => conn.query('DELETE r FROM recents r LEFT JOIN games g ON g.slug = r.game_slug WHERE g.slug IS NULL'),
  },
]

const TABLES = ['games', 'posts', 'users', 'favorites', 'recents']

try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await conn.query(`USE \`${DB_NAME}\``)

  const server = await one('SELECT VERSION() AS v')
  console.log(`数据库：${DB_NAME} @ ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}（${server?.v ?? '?'}）\n`)

  await conn.query(schema)
  console.log('✅ 建表完成（schema.sql 已执行）')

  let applied = 0
  let missing = 0
  for (const p of patches) {
    if (!(await hasTable(p.table))) {
      console.log(`⚠️  ${p.name}：${p.table} 表不存在，已跳过`)
      missing++
      continue
    }
    if (!(await p.needed())) {
      console.log(`· ${p.name}：已是最新`)
      continue
    }
    await p.run()
    console.log(`✅ ${p.name}：已应用`)
    applied++
  }

  // 收尾报告：把库里到底有什么摊开说清楚，省得再出现「说已是最新其实查错了库」这种事
  console.log('\n当前库内容：')
  for (const t of TABLES) {
    if (!(await hasTable(t))) {
      console.log(`  ${t.padEnd(10)} 不存在`)
      continue
    }
    const r = await one(`SELECT COUNT(*) AS n FROM \`${t}\``)
    console.log(`  ${t.padEnd(10)} ${String(r?.n ?? 0).padStart(6)} 行`)
  }

  if (missing) console.log(`\n⚠️  有 ${missing} 条补丁因为表不存在被跳过。表建好之后再跑一次 npm run migrate。`)
  else console.log(applied ? `\n共应用 ${applied} 条补丁。` : '\n数据库结构已是最新，无需改动。')
} catch (e) {
  console.error('❌ 迁移失败：', e.message)
  process.exitCode = 1
} finally {
  await conn.end()
}
