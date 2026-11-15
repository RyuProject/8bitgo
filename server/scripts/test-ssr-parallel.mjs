/**
 * SSR 取数里互不依赖的查询必须并行（2026-11-15 系统优化）。跑：cd server && npm run test:ssr-parallel
 *
 * 为什么要测：/games 列表页以前先 await listGames 再 await loadFacets，缓存未命中时
 * TTFB = 两段 SQL 往返之和。改成 Promise.all 之后任何人「顺手」改回串行都不会报错，
 * 只会让页面悄悄慢一截 —— 所以用一个带延迟的假库量「同一时刻在飞的查询数」。
 */
import { register } from 'node:module'
import assert from 'node:assert/strict'

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

let inFlight = 0
let peak = 0
const DELAY_MS = 40
globalThis.__fakeDb = {
  async query(sql) {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, DELAY_MS))
    inFlight -= 1
    if (/GROUP BY/i.test(sql)) return []
    if (/COUNT\(/i.test(sql)) return [{ total: 0, n: 0 }]
    return []
  },
}

const { loadForRoute, invalidateContent, loadFacets } = await import('../src/content.js')
const { listGames } = await import('../src/games-repo.js')

/** 单独跑一个取数函数时的峰值并发：列表 / facets 自己内部也可能并行，基线要按它们各自量 */
async function peakOf(fn) {
  invalidateContent()
  peak = 0
  await fn()
  return peak
}

async function measure(path, qs = '') {
  invalidateContent()
  peak = 0
  const t0 = performance.now()
  const data = await loadForRoute(path, new URLSearchParams(qs))
  return { data, peak, ms: performance.now() - t0 }
}

// /games：列表与 facets 必须同时在飞
{
  const r = await measure('/games', 'sort=popular')
  assert.equal(r.data.route, 'games')
  assert.ok(r.data.list, '仍返回列表')
  assert.ok(r.data.facets, '仍返回筛选面板')
  const alone = Math.max(await peakOf(() => listGames({ sort: 'popular' })), await peakOf(() => loadFacets({})))
  // 串行时峰值 = 两者中较大的那个；并行时两边的查询会叠在一起
  assert.ok(r.peak > alone, `/games 的列表和 facets 应并行查询（实测同时在飞 ${r.peak} 条，单独跑最多 ${alone} 条）`)
}

// 带搜索词（不进缓存的那条路）同样并行
{
  const r = await measure('/games', 'q=mario')
  const alone = Math.max(await peakOf(() => listGames({ q: 'mario' })), await peakOf(() => loadFacets({})))
  assert.ok(r.peak > alone, `带搜索词的 /games 也应并行（实测 ${r.peak}，单独跑最多 ${alone}）`)
}

// 首页本来就是 Promise.all，守住不退化
{
  const r = await measure('/')
  assert.equal(r.data.route, 'home')
  assert.ok(r.peak >= 4, `首页各栏应并行查询（实测 ${r.peak}）`)
}

console.log('✔ SSR 取数并行：/games 列表 + facets、首页各栏')
