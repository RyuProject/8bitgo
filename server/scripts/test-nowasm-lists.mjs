/**
 * 浏览器没有 WebAssembly 时的精简游戏库（2026-11-15）。跑：cd server && npm run test:nowasm-lists
 *
 * 守三件事：
 *   1. `nowasm=1` 时列表只查有纯 JS 后备的平台，Flash 只放行 AwayFL 已验证的逐款名单；
 *   2. 普通浏览器的公开目录只列开放平台；
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
globalThis.__fakeDb = {
  async query(sql, params = []) {
    calls.push({ sql: String(sql), params: [...(params ?? [])] })
    if (/GROUP BY\s+(g\.)?platform/i.test(sql)) return [{ platform: 'nes', n: 3 }, { platform: 'gba', n: 5 }, { platform: 'gb', n: 2 }]
    if (/COUNT\(/i.test(sql)) return [{ total: 0, n: 0 }]
    return []
  },
}

const { loadForRoute, invalidateContent } = await import('../src/content.js')
const { WASM_FREE_PLATFORM_IDS, WASM_FREE_GAME_SLUGS, gameRunsWithoutWasm } = await import('../../shared/wasm-free-platforms.js')
const { ENABLED_PLATFORM_IDS } = await import('../../shared/site-taxonomy.js')
assert.deepEqual([...WASM_FREE_PLATFORM_IDS], ['nes', 'gb', 'gbc', 'gba'])
assert.equal(gameRunsWithoutWasm('flash', 'untested-game'), false, '未验证的 Flash 游戏不能进入精简名单')
assert.ok(WASM_FREE_GAME_SLUGS.every((slug) => gameRunsWithoutWasm('flash', slug)), '已验证 Flash 名单必须能通过逐款筛选')

const IN = /platform IN \(\?, \?, \?, \?\)/
const listSql = () => calls.filter((c) => /FROM games g/.test(c.sql) && !/GROUP BY/i.test(c.sql))

async function run(path, qs) {
  invalidateContent()
  calls.length = 0
  return loadForRoute(path, new URLSearchParams(qs))
}

for (const path of ['/', '/games', '/platforms/nes', '/genres/rpg', '/rom-language/ja']) {
  await run(path, 'nowasm=1')
  const lists = listSql()
  assert.ok(lists.length > 0, `${path} 应该查了游戏列表`)
  for (const c of lists) {
    assert.match(c.sql, IN, `${path} 的列表 SQL 没带平台过滤：${c.sql.slice(0, 120)}`)
    for (const id of WASM_FREE_PLATFORM_IDS) assert.ok(c.params.includes(id), `${path} 少了参数 ${id}`)
  }
  await run(path, '')
  for (const c of listSql()) {
    assert.match(c.sql, /platform IN \(\?/, `${path} 普通访客必须只列前台开放平台：${c.sql.slice(0, 160)}`)
    for (const id of ENABLED_PLATFORM_IDS) assert.ok(c.params.includes(id), `${path} 普通模式少了开放平台 ${id}`)
  }
}

for (const qs of ['', 'nowasm=1']) {
  await run('/developers', qs)
  const developerQuery = calls.find((c) => /WITH RECURSIVE developer_parts/.test(c.sql))
  assert.ok(developerQuery, `/developers ${qs || '(normal)'} 应查询代表作列表`)
  assert.match(developerQuery.sql, /platform IN \(\?/, '开发商代表作必须限制在可见平台')
  const allowed = qs ? WASM_FREE_PLATFORM_IDS : ENABLED_PLATFORM_IDS
  for (const id of allowed) assert.ok(developerQuery.params.includes(id), `开发商列表缺少开放平台 ${id}`)
}

// 平台计数也只给能跑的平台
const facetsNw = (await run('/platforms', 'nowasm=1')).facets.platforms.map((p) => p.id)
assert.ok(facetsNw.every((id) => WASM_FREE_PLATFORM_IDS.includes(id) || (id === 'flash' && WASM_FREE_GAME_SLUGS.length > 0)), `精简模式露出了 ${facetsNw}`)
assert.equal(facetsNw.includes('flash'), WASM_FREE_GAME_SLUGS.length > 0, 'Flash 平台入口必须跟随逐款已验证名单显示')
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
  assert.match(src(`src/components/game/${f}.tsx`), /if \(!listed\) return null/, `${f} 没按浏览器能力隐藏`)
}
assert.match(src('src/components/home/HomeBanner.tsx'), /gameListed\(noWasm, g\.platform, g\.slug\)/, '首页横幅没按游戏名单过滤')
assert.match(src('src/components/home/sections.tsx'), /gameListed\(noWasm, g\.platform, g\.slug\)/, '首页类型样例没按游戏名单过滤')
assert.match(src('src/services/search.ts'), /gameRunsWithoutWasm\(g\.platform, g\.slug\)/, '搜索联想没按游戏名单过滤')
assert.match(src('src/components/layout/Layout.tsx'), /<NoWasmNotice \/>/, '没挂全站提示')
assert.match(src('src/locales/zh-Hans.ts'), /noWasmNotice: '当前浏览器不支持或者禁用了WebAssembly，无法显示全部游戏。'/)
// 名单要和播放器的纯 JS 退路一致：NES → jsnes，GB/GBC → binjgb-js，GBA → IodineGBA。
assert.match(src('src/emulator/registry.ts'), /\(platform === 'gb' \|\| platform === 'gbc'\) && \(ctx\.webglUnavailable \|\| ctx\.wasmUnavailable\)/)
assert.match(src('src/emulator/registry.ts'), /platform === 'gba' && \(ctx\.gbaWasmUnavailable \|\| ctx\.gbaWebglUnavailable\)/)
assert.match(src('src/emulator/EmulatorPlayer.tsx'), /flashAwayfl: awayflChoice\.use/)

console.log('✔ nowasm 列表过滤：SQL、平台计数、缓存隔离与前端接线都对')
process.exit(0)
