/**
 * 浏览器没有 WebAssembly 时的精简游戏库（2026-11-15）。跑：cd server && npm run test:nowasm-lists
 *
 * 守三件事：
 *   1. `nowasm=1` 时首页 / 游戏库 / 平台 / 类型 / 相关推荐的每一条列表 SQL 都只查 nes / gb / gbc；
 *   2. 不带参数（SSR、正常浏览器）时 SQL 和以前一样，没有多出 IN 条件；
 *   3. 两种结果不共用缓存 key（否则正常访客会拿到精简版，或反过来）。
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

const calls = []
const GAME_ROW = { id: 7, slug: 'tetris', title: 'Tetris', platform: 'gb', hidden: 0, developer: 'Nintendo', genres: 'puzzle' }
globalThis.__fakeDb = {
  async query(sql, params = []) {
    calls.push({ sql: String(sql), params: [...(params ?? [])] })
    if (/GROUP BY\s+(g\.)?platform/i.test(sql)) return [{ platform: 'nes', n: 3 }, { platform: 'gba', n: 5 }, { platform: 'gb', n: 2 }]
    if (/COUNT\(/i.test(sql)) return [{ total: 0, n: 0 }]
    return []
  },
}

const { loadForRoute, invalidateContent } = await import('../src/content.js')
const { WASM_FREE_PLATFORM_IDS } = await import('../../shared/wasm-free-platforms.js')
assert.deepEqual([...WASM_FREE_PLATFORM_IDS], ['nes', 'gb', 'gbc'])

const IN = /platform IN \(\?, \?, \?\)/
const listSql = () => calls.filter((c) => /FROM games g/.test(c.sql) && !/GROUP BY/i.test(c.sql))

async function run(path, qs) {
  invalidateContent()
  calls.length = 0
  return loadForRoute(path, new URLSearchParams(qs))
}

for (const path of ['/', '/games', '/platforms/nes', '/genres/rpg']) {
  await run(path, 'nowasm=1')
  const lists = listSql()
  assert.ok(lists.length > 0, `${path} 应该查了游戏列表`)
  for (const c of lists) {
    assert.match(c.sql, IN, `${path} 的列表 SQL 没带平台过滤：${c.sql.slice(0, 120)}`)
    for (const id of WASM_FREE_PLATFORM_IDS) assert.ok(c.params.includes(id), `${path} 少了参数 ${id}`)
  }
  await run(path, '')
  for (const c of listSql()) assert.doesNotMatch(c.sql, IN, `${path} 普通访客不该带平台过滤`)
}

// 平台计数也只给能跑的平台
const facetsNw = (await run('/platforms', 'nowasm=1')).facets.platforms.map((p) => p.id)
assert.ok(facetsNw.every((id) => WASM_FREE_PLATFORM_IDS.includes(id)), `精简模式露出了 ${facetsNw}`)
const facetsAll = (await run('/platforms', '')).facets.platforms.map((p) => p.id)
assert.ok(facetsAll.includes('gba'), '普通访客的平台计数不该被筛')

// 缓存不串：先取普通版，再取精简版，精简版必须重新查（带 IN）
invalidateContent()
calls.length = 0
await loadForRoute('/', new URLSearchParams(''))
calls.length = 0
await loadForRoute('/', new URLSearchParams('nowasm=1'))
assert.ok(listSql().some((c) => IN.test(c.sql)), '精简版首页命中了普通版的缓存')

/* ---------- 前端接线（.tsx 加载不了，只扫结构） ---------- */
const { readFileSync } = await import('node:fs')
const root = new URL('../../', import.meta.url)
const src = (rel) => readFileSync(new URL(rel, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const noWasm = src('src/services/noWasm.ts')
assert.match(noWasm, /useSyncExternalStore\(noop, clientSnapshot, serverSnapshot\)/, '必须用 useSyncExternalStore，服务端快照固定 false')
assert.match(noWasm, /const serverSnapshot = \(\) => false/)
assert.match(src('src/services/pageData.ts'), /noWasm \? \{ \.\.\.params, nowasm: 1 \} : params/, 'usePageData 没带 nowasm')
for (const f of ['GameCard', 'GameCardWide', 'GameRankCard', 'PlatformCard']) {
  assert.match(src(`src/components/game/${f}.tsx`), /if \(!listed\) return null/, `${f} 没按平台隐藏`)
}
assert.match(src('src/components/home/HomeBanner.tsx'), /platformListed\(noWasm, g\.platform\)/, '首页横幅没过滤')
assert.match(src('src/components/home/sections.tsx'), /platformListed\(noWasm, g\.platform\)/, '首页类型样例没过滤')
assert.match(src('src/services/search.ts'), /platformRunsWithoutWasm\(g\.platform\)/, '搜索联想没过滤')
assert.match(src('src/components/layout/Layout.tsx'), /<NoWasmNotice \/>/, '没挂全站提示')
assert.match(src('src/locales/zh-Hans.ts'), /noWasmNotice: '当前浏览器不支持或者禁用了WebAssembly，无法显示全部游戏。'/)
// 名单要和播放器的纯 JS 退路一致：nes → jsnes，gb / gbc → binjgb-js
assert.match(src('src/emulator/registry.ts'), /\(platform === 'gb' \|\| platform === 'gbc'\) && \(ctx\.webglUnavailable \|\| ctx\.wasmUnavailable\)/)

console.log('✔ nowasm 列表过滤：SQL、平台计数、缓存隔离与前端接线都对')
process.exit(0)
