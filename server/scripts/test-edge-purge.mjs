// 边缘 HTML 长缓存 + 后台写入后清缓存（server/src/edge-purge.js）的回归。不联网、不连库。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
let passed = 0
const ok = (name) => {
  passed += 1
  console.log(`  ✓ ${name}`)
}

// ── 没令牌：不启用长缓存，也不发请求 ──
delete process.env.CF_ZONE_ID
delete process.env.CF_PURGE_API_TOKEN
process.env.EDGE_PURGE_DELAY_MS = '20'
const mod = await import('../src/edge-purge.js')
assert.equal(mod.edgePurgeEnabled(), false)
assert.equal(await mod.purgeHtmlNow({ fetchImpl: () => assert.fail('不该请求') }), false)
ok('没配令牌时不启用、不请求')

// ── 有令牌：按 html 标签清 ──
process.env.CF_ZONE_ID = 'zone123'
process.env.CF_PURGE_API_TOKEN = 'tok'
assert.equal(mod.edgePurgeEnabled(), true)
let seen = null
await mod.purgeHtmlNow({
  fetchImpl: async (url, init) => {
    seen = { url, init }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  },
})
assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/zones/zone123/purge_cache')
assert.equal(seen.init.headers.Authorization, 'Bearer tok')
assert.deepEqual(JSON.parse(seen.init.body), { tags: [mod.HTML_CACHE_TAG] })
ok('按 Cache-Tag 清全部 HTML')

// ── 429 可重试，403 不可重试 ──
await assert.rejects(
  mod.purgeHtmlNow({ fetchImpl: async () => new Response('{}', { status: 429 }) }),
  (e) => e.retryable === true,
)
await assert.rejects(
  mod.purgeHtmlNow({ fetchImpl: async () => new Response('{"success":false}', { status: 403 }) }),
  (e) => e.retryable === false,
)
ok('429 退避重试，权限错误不重试')

// ── 连续多次 schedulePurge 合并成一次 ──
const realFetch = globalThis.fetch
let calls = 0
globalThis.fetch = async () => {
  calls += 1
  return new Response(JSON.stringify({ success: true }), { status: 200 })
}
for (let i = 0; i < 10; i++) mod.schedulePurge()
await new Promise((r) => setTimeout(r, 120))
globalThis.fetch = realFetch
assert.equal(calls, 1)
ok('批量写入只清一次')

// ── 接线：所有后台写路径汇到 invalidateContent，它要调 schedulePurge ──
const content = read('../src/content.js')
assert.match(content, /export function invalidateContent\(\)[\s\S]*?schedulePurge\(\)[\s\S]*?\n}/)
ok('invalidateContent() 会清边缘')

// ── SSR：带 Cache-Tag；长缓存只在可缓存页面、非大陆入口、配了令牌时 ──
const ssr = read('../src/ssr.js')
assert.match(ssr, /'Cache-Tag': HTML_CACHE_TAG/)
assert.match(ssr, /longEdgeCache = !cnSite && cacheControl === CACHE\.page && Boolean\(CACHE\.pageEdge\) && edgePurgeEnabled\(\)/)
assert.match(ssr, /longEdgeCache \? \{ 'Cloudflare-CDN-Cache-Control': CACHE\.pageEdge \}/)
ok('SSR 只给普通页面、Cloudflare 一侧发长缓存')

// ── 通用 Cache-Control 不变：浏览器 / EdgeOne 仍是 5 分钟 ──
const { CACHE } = await import('../src/cache.js')
assert.match(CACHE.page, /max-age=0, s-maxage=300/)
assert.match(CACHE.pageEdge, /^max-age=86400\b/)
ok('浏览器与 EdgeOne 的缓存策略不变，Cloudflare 一天')

// ── 部署后清一次，否则新前端要等一天 ──
const redeploy = read('../../deploy/redeploy.sh')
assert.match(redeploy, /purge:edge-html/)
ok('redeploy.sh 发布成功后清 HTML')

console.log(`\n${passed} 项通过`)
