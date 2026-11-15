/**
 * 公开热路径上互不依赖的查询必须并行（2026-11-15 系统优化 #11）。跑：cd server && npm run test:parallel-reads
 *
 * 覆盖：游戏详情 getGameBySlug（关联数据 ‖ 最新评论时间）、GET /api/comments（总数 ‖ 本页）、
 * GET/POST /api/ratings（汇总 ‖ 我的分）、GET /api/collections 与 listPublicCollections（总数 ‖ 本页）。
 *
 * 判据是「两条 SQL 的执行区间有没有重叠」：假库给每条查询 30ms 延迟并记下起止时间。
 * 有人把 Promise.all 改回逐条 await，区间就首尾相接、不再重叠，这里立刻失败。
 */
import { register } from 'node:module'
import assert from 'node:assert/strict'

process.env.JWT_SECRET ||= 'test-secret-for-parallel-reads-0123456789'

const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export const pool = null
  export async function query(sql, params) { return globalThis.__fakeDb.query(sql, params) }
  export async function queryOne(sql, params) { return (await globalThis.__fakeDb.query(sql, params))[0] }
  export async function ping() { return true }
  export async function withTransaction(fn) { return fn((s, p) => globalThis.__fakeDb.query(s, p)) }
  export function jsonMemberPath(name) { return name }
`)
register('data:text/javascript,' + encodeURIComponent(`
  const STUB = ${JSON.stringify(JSON.stringify(STUB))}
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/db.js')) return { url: JSON.parse(STUB), shortCircuit: true }
    return nextResolve(specifier, context)
  }
`))

let log = []
globalThis.__fakeDb = {
  async query(sql) {
    const entry = { sql: String(sql).replace(/\s+/g, ' '), start: performance.now(), end: 0 }
    log.push(entry)
    await new Promise((r) => setTimeout(r, 30))
    entry.end = performance.now()
    if (/FROM games WHERE slug = \?/.test(sql)) return [{ id: 7, slug: 'tetris', title: 'Tetris', platform: 'gb', hidden: 0 }]
    if (/COUNT\(\*\)/i.test(sql)) return [{ n: 3 }]
    if (/MAX\(created_at\)/.test(sql)) return [{ latest: null }]
    return []
  },
}

function overlaps(a, b) {
  const x = log.find((e) => a.test(e.sql))
  const y = log.find((e) => b.test(e.sql))
  assert.ok(x, `没执行 ${a}`)
  assert.ok(y, `没执行 ${b}`)
  return x.start < y.end && y.start < x.end
}

const { getGameBySlug } = await import('../src/games-repo.js')
const { listPublicCollections, collectionsRouter } = await import('../src/routes/collections.js')
const { commentsRouter } = await import('../src/routes/comments.js')
const { ratingsRouter } = await import('../src/routes/ratings.js')
const express = (await import('express')).default

// 1. 游戏详情
log = []
const game = await getGameBySlug('tetris')
assert.equal(game.slug, 'tetris')
assert.ok(overlaps(/FROM game_genres/, /MAX\(created_at\)/), '详情页：关联数据与最新评论时间应并行')

// 2. listPublicCollections（SSR /collections 与开放平台）
log = []
await listPublicCollections(1, 24)
assert.ok(overlaps(/COUNT\(\*\) AS n FROM collections/, /ORDER BY c\.updated_at DESC/), '合集列表：总数与本页应并行')

// 3. HTTP 路由
const app = express()
app.use(express.json())
app.use('/api/comments', commentsRouter)
app.use('/api/ratings', ratingsRouter)
app.use('/api/collections', collectionsRouter)
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }))
const server = app.listen(0)
await new Promise((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
const base = `http://127.0.0.1:${server.address().port}`
try {
  log = []
  let r = await fetch(`${base}/api/comments?game=tetris`)
  assert.equal(r.status, 200, await r.text())
  assert.ok(overlaps(/COUNT\(\*\) AS n FROM game_comments/, /ORDER BY c\.created_at DESC/), '评论：总数与本页应并行')

  log = []
  const anonId = 'a'.repeat(32)
  r = await fetch(`${base}/api/ratings?game=tetris&anonId=${anonId}`)
  const body = await r.text()
  if (r.status === 200) {
    assert.ok(overlaps(/GROUP BY score/, /FROM game_ratings WHERE game_id = \? AND/), '评分：汇总与我的分应并行')
  } else {
    throw new Error(`GET /api/ratings ${r.status}: ${body}`)
  }

  log = []
  r = await fetch(`${base}/api/collections`)
  assert.equal(r.status, 200, await r.text())
  assert.ok(overlaps(/COUNT\(\*\) AS n FROM collections/, /ORDER BY c\.updated_at DESC/), '合集接口：总数与本页应并行')
} finally {
  server.close()
}

console.log('✔ 热路径并行读：详情页、评论、评分、合集')
