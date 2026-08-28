#!/usr/bin/env node
/**
 * 把现有 MySQL 里的数据导成 D1（SQLite）能直接执行的 SQL。
 *
 *   node scripts/export-d1.mjs > d1-data.sql
 *   node scripts/export-d1.mjs --clean --out d1-data.sql
 *   wrangler d1 execute 8bitgo --remote --file=d1-data.sql
 *
 * 为什么不解析 mysqldump：dump 用的是 MySQL 的反斜杠转义（\' \\ \n \Z …），
 * 而 SQLite 只认「两个单引号」这一种转义，反斜杠在它眼里就是普通字符。
 * 拿正则去改写别人的转义规则，迟早会在某个含反斜杠的游戏简介上翻车。
 * 直接连库按行读、自己拼字面量，类型和转义都由这里说了算。
 *
 * 三个关键决定：
 *
 *   1. 连接时 dateStrings: true —— 让驱动把 DATE / TIMESTAMP 原样以字符串给出。
 *      否则 mysql2 会转成 JS Date，再转回字符串时要经过一次本地时区，
 *      导出机器和数据库时区不一致就整体偏几个小时，而且偏得悄无声息。
 *
 *   2. 值全部写成**字面量**，不用绑定参数 —— D1 一条语句最多 100 个绑定参数，
 *      而这里一条 INSERT 动辄几百个值。字面量没有这个限制。
 *
 *   3. 按依赖顺序导，父表在前 —— D1 的外键默认强制，且没有 MySQL 那种
 *      SET FOREIGN_KEY_CHECKS=0 可以临时关掉。
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import { writeFileSync } from 'node:fs'

/** 导出顺序 = 外键依赖顺序，父表在前 */
const TABLES = [
  'games',
  'posts',
  'users',
  'platform_bios',
  'game_genres',
  'game_tags',
  'game_search_tokens',
  'game_roms',
  // 游玩去重名单。不导的话所有人都会被重新算一次，plays 直接翻倍
  'game_plays',
  'post_tags',
  // saves 只在 v1 的 schema.sql 里定义过，v2 没重列，但 routes/saves.js 一直在用 —— 别漏
  'saves',
  'favorites',
  'recents',
]

/** D1 单条语句上限 100 KB，留足余量后按字节数分批 */
const MAX_STATEMENT_BYTES = 60_000

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const outIdx = args.indexOf('--out')
const outFile = outIdx >= 0 ? args[outIdx + 1] : null

/** SQLite 字面量：只有单引号需要转义，写成两个单引号 */
function literal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'bigint') return String(v)
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
  return `'${String(v).replaceAll("'", "''")}'`
}

const ident = (s) => `"${s}"`

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '8bitgo',
    charset: 'utf8mb4',
    // 见文件头「关键决定 1」
    dateStrings: true,
  })

  const out = []
  const counts = {}

  out.push('-- 8BitGo 数据导出（MySQL -> D1）')
  out.push(`-- 生成于 ${new Date().toISOString()}`)
  out.push('-- 表的先后顺序就是外键依赖顺序，不要重排')
  out.push('')

  if (clean) {
    out.push('-- --clean：先清空，顺序与导入相反（子表在前）')
    for (const t of [...TABLES].reverse()) out.push(`DELETE FROM ${ident(t)};`)
    // 不去动 sqlite_sequence：导出带着原始 id，插进去时 AUTOINCREMENT 的计数器
    // 会自己跟到 max(id)（实测：显式插 id=42，下一条自增就是 43）。
    // 而且那是张系统表，D1 未必允许写。
    out.push('')
  }

  for (const table of TABLES) {
    const [rows] = await conn.query(`SELECT * FROM \`${table}\``)
    counts[table] = rows.length
    if (!rows.length) {
      out.push(`-- ${table}: 空表`)
      out.push('')
      continue
    }

    const cols = Object.keys(rows[0])
    const head = `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES`
    out.push(`-- ${table}: ${rows.length} 行`)

    let batch = []
    let bytes = head.length
    const flush = () => {
      if (!batch.length) return
      out.push(`${head}\n${batch.join(',\n')};`)
      batch = []
      bytes = head.length
    }
    for (const row of rows) {
      const tuple = `  (${cols.map((c) => literal(row[c])).join(', ')})`
      const size = Buffer.byteLength(tuple, 'utf8') + 2
      if (bytes + size > MAX_STATEMENT_BYTES) flush()
      batch.push(tuple)
      bytes += size
    }
    flush()
    out.push('')
  }

  out.push('-- 自检：把下面这些数字和导出时的行数对一遍')
  for (const t of TABLES) out.push(`--   ${t.padEnd(20)} ${counts[t]}`)
  out.push('')

  const sql = out.join('\n')
  if (outFile) {
    writeFileSync(outFile, sql, 'utf8')
    console.error(`已写入 ${outFile}（${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB）`)
  } else {
    process.stdout.write(sql)
  }

  console.error('\n行数：')
  for (const t of TABLES) console.error(`  ${t.padEnd(20)} ${counts[t]}`)

  await conn.end()
}

main().catch((e) => {
  console.error('导出失败：', e.message)
  process.exit(1)
})
