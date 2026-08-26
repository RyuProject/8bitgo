/**
 * 把项目内置的游戏 / 文章写入数据库，并可选创建首个管理员。
 * 用法：cd server && npm run seed
 *
 * 说明：本脚本用 esbuild 直接读取前端的 src/data/*.ts（devDependency）。
 * 如果你的服务器只装了生产依赖（没有 esbuild），也可以改用另一条更简单的路：
 *   启动后端后，打开前端后台「数据」页点「导入内置数据到数据库」即可（走 /api/admin/import）。
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pool, query, queryOne } from '../src/db.js'
import { gameApiToRow, postApiToRow, buildUpsert } from '../src/mappers.js'
import { hashPassword } from '../src/auth.js'

async function loadTsArray(relPath, exportName) {
  let build
  try {
    ;({ build } = await import('esbuild'))
  } catch {
    console.error('缺少 esbuild（devDependency）。请先 `npm install`，或改用后台「导入内置数据到数据库」。')
    process.exit(1)
  }
  const entry = fileURLToPath(new URL(relPath, import.meta.url))
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  const code = r.outputFiles[0].text
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  return mod[exportName]
}

async function upsertAll(table, items, toRow) {
  let n = 0
  for (const it of items) {
    const row = toRow(it)
    const { sql, values } = buildUpsert(table, row, 'slug')
    await query(sql, values)
    n++
  }
  return n
}

try {
  const games = await loadTsArray('../../src/data/games.ts', 'games')
  const posts = await loadTsArray('../../src/data/posts.ts', 'posts')
  const g = await upsertAll('games', games, gameApiToRow)
  const p = await upsertAll('posts', posts, postApiToRow)
  console.log(`✅ 已写入 ${g} 款游戏、${p} 篇文章`)

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD || ''
  if (email && password) {
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    if (existing) {
      console.log(`ℹ️ 管理员 ${email} 已存在，跳过`)
    } else {
      const id = 'u_' + crypto.randomBytes(6).toString('hex')
      await query(
        'INSERT INTO users (id, email, nickname, avatar, password_hash, coins, role, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, email, process.env.ADMIN_NICKNAME || '管理员', '🛡️', await hashPassword(password), 0, 'admin', 'active', new Date().toISOString().slice(0, 10)],
      )
      console.log(`✅ 已创建管理员账号：${email}`)
    }
  }
} catch (e) {
  console.error('❌ 种子数据写入失败：', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
