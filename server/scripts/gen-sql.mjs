/**
 * 生成「一键建库 + 数据」的纯 SQL 文件：schema + 全部内置游戏 / 文章。
 * 产物：server/8bitgo-setup.sql —— 可直接粘进 DBGate / Navicat / mysql 客户端执行。
 * 用法：cd server && node scripts/gen-sql.mjs
 *
 * 说明：用 esbuild 直接读取前端的 src/data/*.ts，转成 INSERT ... ON DUPLICATE KEY UPDATE，
 * 因此重复执行是安全的（幂等）。JSON 列（genres/tags/roms）以字符串字面量写入。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gameApiToRow, postApiToRow } from '../src/mappers.js'

async function loadTsArray(relPath, exportName) {
  const { build } = await import('esbuild')
  const entry = fileURLToPath(new URL(relPath, import.meta.url))
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  const code = r.outputFiles[0].text
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  return mod[exportName]
}

/** MySQL 字符串字面量转义 */
function sqlStr(s) {
  return "'" + String(s).replace(/[\0\b\n\r\t\x1a\\'"]/g, (ch) => {
    switch (ch) {
      case '\0': return '\\0'
      case '\b': return '\\b'
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      case '\x1a': return '\\Z'
      case '\\': return '\\\\'
      case "'": return "\\'"
      case '"': return '\\"'
      default: return ch
    }
  }) + "'"
}

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0'
  if (typeof v === 'boolean') return v ? '1' : '0'
  return sqlStr(v)
}

function buildUpsertSQL(table, row, pk) {
  const cols = Object.keys(row)
  const vals = cols.map((c) => sqlVal(row[c]))
  const updates = cols.filter((c) => c !== pk).map((c) => `\`${c}\`=VALUES(\`${c}\`)`).join(', ')
  return `INSERT INTO \`${table}\` (${cols.map((c) => '`' + c + '`').join(', ')}) VALUES (${vals.join(', ')})\n  ON DUPLICATE KEY UPDATE ${updates};`
}

const games = await loadTsArray('../../src/data/games.ts', 'games')
const posts = await loadTsArray('../../src/data/posts.ts', 'posts')

const schema = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8').trimEnd()

const parts = []
parts.push('-- ============================================================')
parts.push('-- 8BitGo 一键建库脚本：建库 + 建表 + 导入全部内置数据')
parts.push('-- 直接粘进 DBGate 的 SQL 查询窗口执行即可（可重复执行，幂等）。')
parts.push(`-- 生成内容：${games.length} 款游戏、${posts.length} 篇文章`)
parts.push('-- ============================================================')
parts.push('')
parts.push('-- 强制 utf8mb4：客户端默认 latin1 时中文会被双重编码存成乱码')
parts.push('SET NAMES utf8mb4;')
parts.push('')
parts.push('-- ---------- 1. 表结构 ----------')
parts.push(schema)
parts.push('')
parts.push('USE `8bitgo`;')
parts.push('')
parts.push(`-- ---------- 2. 游戏数据（${games.length} 条）----------`)
for (const g of games) parts.push(buildUpsertSQL('games', gameApiToRow(g), 'slug'))
parts.push('')
parts.push(`-- ---------- 3. 博客文章（${posts.length} 条）----------`)
for (const p of posts) parts.push(buildUpsertSQL('posts', postApiToRow(p), 'slug'))
parts.push('')
parts.push('-- ---------- 4. 管理员账号 ----------')
parts.push('-- 管理员不在此脚本创建（需要密码哈希）。两种方式二选一：')
parts.push('--   A) 在网站上正常注册一个账号，然后在 DBGate 执行（把邮箱换成你的）：')
parts.push("--      UPDATE users SET role='admin' WHERE email='you@example.com';")
parts.push('--   B) 在服务器上：server/.env 填 ADMIN_EMAIL / ADMIN_PASSWORD，然后 `npm run seed`。')
parts.push('')
parts.push('-- 完成。可执行以下语句自检：')
parts.push("SELECT 'games' AS t, COUNT(*) AS n FROM games")
parts.push("UNION ALL SELECT 'posts', COUNT(*) FROM posts")
parts.push("UNION ALL SELECT 'users', COUNT(*) FROM users;")
parts.push('')

const out = fileURLToPath(new URL('../8bitgo-setup.sql', import.meta.url))
writeFileSync(out, parts.join('\n'), 'utf8')
console.log(`✅ 生成 ${out}`)
console.log(`   游戏 ${games.length} 条、文章 ${posts.length} 条`)
