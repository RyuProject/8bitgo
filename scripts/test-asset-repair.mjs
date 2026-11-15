#!/usr/bin/env node
/**
 * 坏 chunk 自修复回归（不联网）：
 *   - 构建清单：文件名跟入口走、只收 /assets/ 子资源、按磁盘字节算 SHA-256；
 *   - 首页内联钩子：import map 改指、过期项丢弃、SyntaxError 才触发、点名文件解析；
 *   - public/asset-repair-v1.js：缓存坏→重取修好；边缘坏→回源地址 + 通知清缓存；源站坏→不刷新；
 *     正常文件不重取；点名文件强制覆盖；没清单只处理点名文件；一分钟内只刷新一次；
 *   - 服务端 /api/asset-repair：只认清单里且磁盘一致的文件、限流、每个文件 15 分钟清一次；
 *   - React 兜底页的接线与诊断摘要。
 */
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {
  buildIntegrityManifest,
  integrityManifestName,
  isIntegrityTarget,
  sha256Base64,
} from './lib/vite-asset-integrity.mjs'
import { createAssetRepairRouter, parseRepairRequest } from '../server/src/routes/asset-repair.js'
import {
  moduleLinkFailure,
  repairFixedSomething,
  resolveChunkUrl,
  summarizeRepair,
} from '../src/services/moduleLinkRecovery.ts'

// express 装在 server/ 下，根目录没有
const { default: express } = await import(new URL('../server/node_modules/express/index.js', import.meta.url).href)

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/* ---------- 构建清单 ---------- */
assert.equal(integrityManifestName('assets/index-BszfwrRT.js'), 'integrity-BszfwrRT.json')
assert.equal(integrityManifestName('assets/index--IFWo9je.js'), 'integrity--IFWo9je.json', '哈希可以以 - 开头')
assert.equal(integrityManifestName('assets/index-legacy-abc123.js'), null, 'legacy 入口不写清单')
assert.equal(integrityManifestName('assets/live-abc.js'), null)
assert.equal(isIntegrityTarget('assets/live-Cqhc9j-k.js'), true)
assert.equal(isIntegrityTarget('assets/index-BOVHu4x9.css'), true)
assert.equal(isIntegrityTarget('assets/integrity-abc.json'), false)
assert.equal(isIntegrityTarget('assets/live.js.map'), false)
assert.equal(isIntegrityTarget('index.html'), false)
assert.equal(isIntegrityTarget('emulatorjs/loader.js'), false, '只管 /assets/')
assert.equal(sha256Base64('abc'), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
assert.deepEqual(Object.keys(buildIntegrityManifest('assets/index-x.js', { b: '2', a: '1' }).files), ['a', 'b'], '按文件名排序，内容稳定')
{
  const config = read('vite.config.ts')
  assert.match(config, /assetIntegrityPlugin\(\)/, 'vite 配置挂上了清单插件')
  const plugin = read('scripts/lib/vite-asset-integrity.mjs')
  assert.match(plugin, /writeBundle\(options, bundle\)/, '在 writeBundle 里算：哈希的是写到磁盘上的字节')
  assert.match(plugin, /readFileSync\(path\.join\(dir, fileName\)\)/)
  assert.match(plugin, /renameSync\(tmp, target\)/, '先写临时文件再改名')
  assert.match(read('package.json'), /check-asset-integrity\.mjs/, 'postbuild 核对清单')
}

/* ---------- 测试用的「站点」 ---------- */
const ORIGIN = 'https://8bitgo.com'
const ENTRY = `${ORIGIN}/assets/index-ABCD1234.js`
const GOOD = {
  'index-ABCD1234.js': 'import"./live-L1.js";console.log(1)',
  'live-L1.js': 'export{a as x}',
  'other-O1.js': 'export{b as y}',
  'style-S1.css': 'body{}',
}
const MANIFEST = buildIntegrityManifest('assets/index-ABCD1234.js', Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, sha256Base64(v)])))
const enc = (text) => new TextEncoder().encode(text).buffer

/**
 * 在 vm 里跑修复脚本。`serve(url, cacheMode)` 决定每次 fetch 返回什么：
 * 返回字符串 = 200 + 内容，数字 = HTTP 状态，null = 网络错误。
 */
function runRepair({ serve, opts = {}, resources = Object.keys(GOOD).map((n) => `${ORIGIN}/assets/${n}`), store = new Map(), session = new Map(), entry = ENTRY }) {
  const calls = []
  const posts = []
  let reloads = 0
  const storage = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  })
  const window = {
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive })
        return { ok: true, status: 202 }
      }
      calls.push({ url, cache: init.cache })
      const out = serve(url, init.cache)
      if (out === null) throw new TypeError('Failed to fetch')
      if (typeof out === 'number') return { ok: false, status: out, arrayBuffer: async () => enc('') }
      return { ok: true, status: 200, arrayBuffer: async () => enc(out) }
    },
    crypto: webcrypto,
    location: { pathname: '/games/x', reload: () => { reloads++ } },
    localStorage: storage(store),
    sessionStorage: storage(session),
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
    document: { querySelector: () => (entry ? { src: entry } : null) },
    console: { warn() {} },
    AbortController,
    TextDecoder,
    btoa,
    setTimeout,
    clearTimeout,
    Promise,
    Uint8Array,
    JSON,
    Date,
    Object,
    String,
    Number,
    Boolean,
  }
  window.window = window
  window.crypto = webcrypto
  const context = vm.createContext(window)
  vm.runInContext(read('public/asset-repair-v1.js'), context)
  return window.__8bitgoAssetRepairRun(opts).then((result) => ({ result: JSON.parse(JSON.stringify(result)), calls, posts, reloads, store, session }))
}

const manifestUrl = `${ORIGIN}/assets/integrity-ABCD1234.json`
const fileOf = (url) => /\/assets\/([^/?#]+)/.exec(url)?.[1]

{
  // 1. 浏览器缓存里的 live 坏了，绕过缓存重取是好的 → 修好、刷新一次
  const r = await runRepair({
    serve(url, mode) {
      if (url === manifestUrl) return JSON.stringify(MANIFEST)
      const name = fileOf(url)
      if (name === 'live-L1.js' && mode === 'force-cache') return 'function x(){}' // 缺导出的坏副本
      return GOOD[name]
    },
  })
  assert.deepEqual(r.result.repaired, ['live-L1.js'])
  assert.equal(r.result.ok, 3)
  assert.equal(r.reloads, 1, '修好后刷新一次')
  assert.equal(r.result.reloaded, true)
  assert.ok(!r.calls.some((c) => c.cache === 'reload' && fileOf(c.url) !== 'live-L1.js'), '正常文件不重取，不费流量')
  assert.ok(r.calls.filter((c) => fileOf(c.url) !== 'integrity-ABCD1234.json').every((c) => c.cache === 'force-cache' || fileOf(c.url) === 'live-L1.js'))
  assert.equal(r.posts.length, 0, '只是浏览器缓存坏，不用清边缘')
}

{
  // 2. CDN 边缘那份就是坏的：重取还坏，带查询串回源是好的 → 记 import map、通知服务端清缓存
  const r = await runRepair({
    serve(url) {
      if (url === manifestUrl) return JSON.stringify(MANIFEST)
      const name = fileOf(url)
      if (name === 'live-L1.js' && !url.includes('?asset-repair=1')) return 'function x(){}'
      return GOOD[name]
    },
  })
  assert.deepEqual(r.result.remapped, ['live-L1.js'])
  const remap = JSON.parse(r.store.get('8bitgo.asset-remap'))
  assert.equal(remap[`${ORIGIN}/assets/live-L1.js`].to, `${ORIGIN}/assets/live-L1.js?asset-repair=1`)
  assert.ok(remap[`${ORIGIN}/assets/live-L1.js`].until > Date.now())
  assert.deepEqual(r.posts.map((p) => [p.url, p.body, p.keepalive]), [['/api/asset-repair', { build: 'ABCD1234', files: ['live-L1.js'] }, true]])
  assert.equal(r.reloads, 1)
  const bypass = r.calls.find((c) => c.url.includes('?asset-repair=1'))
  assert.equal(bypass.cache, 'no-store')
}

{
  // 3. 回源也对不上（部署本身坏了）：不刷新，留给诊断
  const r = await runRepair({
    serve(url) {
      if (url === manifestUrl) return JSON.stringify(MANIFEST)
      return fileOf(url) === 'live-L1.js' ? 'garbage' : GOOD[fileOf(url)]
    },
  })
  assert.deepEqual(r.result.bad, ['live-L1.js'])
  assert.equal(r.reloads, 0, '修不好就别刷新，免得来回跳')
  assert.equal(r.store.has('8bitgo.asset-remap'), false)
}

{
  // 4. 全部正常、也没点名：只读缓存，不刷新
  const r = await runRepair({ serve: (url) => (url === manifestUrl ? JSON.stringify(MANIFEST) : GOOD[fileOf(url)]) })
  assert.equal(r.result.ok, 4)
  assert.equal(r.reloads, 0)
  assert.ok(r.calls.every((c) => c.cache === 'force-cache'), '正常路径不发任何绕过缓存的请求')
}

{
  // 5. 错误点名的文件缓存里看着正常（缓存键可能不同）：仍强制重取覆盖一遍
  const r = await runRepair({
    opts: { urls: [`${ORIGIN}/assets/live-L1.js`] },
    serve: (url) => (url === manifestUrl ? JSON.stringify(MANIFEST) : GOOD[fileOf(url)]),
  })
  assert.deepEqual(r.result.refreshed, ['live-L1.js'])
  assert.equal(r.reloads, 1)
}

{
  // 6. 清单不存在（旧构建）：只处理点名文件，其余不碰
  const r = await runRepair({
    opts: { urls: [`${ORIGIN}/assets/live-L1.js`] },
    serve: (url) => (url === manifestUrl ? 404 : GOOD[fileOf(url)]),
  })
  assert.equal(r.result.manifest, false)
  assert.equal(r.result.checked, 1)
  assert.deepEqual(r.result.refreshed, ['live-L1.js'])
}

{
  // 7. 清单本身在缓存里坏了：绕过缓存再取一次
  const r = await runRepair({
    serve(url, mode) {
      if (url === manifestUrl) return mode === 'force-cache' ? '{"v":1,' : JSON.stringify(MANIFEST)
      return GOOD[fileOf(url)]
    },
  })
  assert.equal(r.result.manifest, true)
}

{
  // 8. reload:false（React 兜底页先上报再自己刷新）与一分钟冷却
  const serve = (url, mode) => {
    if (url === manifestUrl) return JSON.stringify(MANIFEST)
    return fileOf(url) === 'live-L1.js' && mode === 'force-cache' ? 'bad' : GOOD[fileOf(url)]
  }
  const noReload = await runRepair({ serve, opts: { reload: false } })
  assert.equal(noReload.reloads, 0)
  assert.deepEqual(noReload.result.repaired, ['live-L1.js'])
  const session = new Map([['8bitgo.asset-repair-reload:/games/x', String(Date.now() - 1000)]])
  const cooled = await runRepair({ serve, session })
  assert.equal(cooled.reloads, 0, '一分钟内刚刷过，不再刷')
}

{
  // 9. 别的构建 / 别的目录的资源不归它管；带查询串的 import map 地址照样核对
  const r = await runRepair({
    resources: [`${ORIGIN}/assets/live-L1.js?asset-repair=1`, `${ORIGIN}/assets/someone-else.js`, `${ORIGIN}/emulatorjs/loader.js`],
    serve: (url) => (url === manifestUrl ? JSON.stringify(MANIFEST) : GOOD[fileOf(url)] ?? 'x'),
  })
  assert.equal(r.result.checked, 1)
  assert.equal(r.calls.find((c) => fileOf(c.url) === 'live-L1.js').url, `${ORIGIN}/assets/live-L1.js?asset-repair=1`)
}

{
  // 10. 大陆入口：清单跟着入口目录走（cn.8bitgo.com/_cn/assets/）
  const cnEntry = 'https://cn.8bitgo.com/_cn/assets/index-ABCD1234.js'
  const r = await runRepair({
    entry: cnEntry,
    resources: ['https://cn.8bitgo.com/_cn/assets/live-L1.js'],
    serve: (url) => (url === 'https://cn.8bitgo.com/_cn/assets/integrity-ABCD1234.json' ? JSON.stringify(MANIFEST) : GOOD[fileOf(url)]),
  })
  assert.equal(r.result.manifest, true)
  assert.equal(r.result.ok, 1)
}

/* ---------- 首页内联钩子 ---------- */
const html = read('index.html')
const hook = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('__8bitgoAssetRepair'))
assert.ok(hook, 'index.html 有坏 chunk 自修复钩子')
assert.ok(!/=>|\blet\b|\bconst\b|`/.test(hook), '钩子只能写 ES5')
assert.ok(html.indexOf('__8bitgoAssetRepair') < html.indexOf('type="module"'), '必须排在模块脚本之前，import map 才来得及生效')
assert.ok(html.indexOf('8bitgo.https-upgrade') < html.indexOf('__8bitgoAssetRepair'), 'HTTPS 守卫仍是第一段脚本')

function runHook({ remap, supports = true }) {
  const appended = []
  const listeners = {}
  const repairCalls = []
  const now = Date.now()
  const window = {
    HTMLScriptElement: { supports: () => supports },
    localStorage: { getItem: () => (remap ? JSON.stringify(remap) : null) },
    document: {
      head: { appendChild: (el) => { appended.push(el); if (el.src && el.onload) el.onload() } },
      createElement: () => ({}),
      querySelector: () => ({ src: ENTRY }),
    },
    addEventListener: (type, fn) => { listeners[type] = fn },
    Promise,
    URL,
    JSON,
    Date,
    Object,
    String,
  }
  window.window = window

  vm.runInContext(hook, vm.createContext(window))
  window.__8bitgoAssetRepairRun = (opts) => { repairCalls.push(opts); return { ok: true } }
  return { window, appended, listeners, repairCalls, now }
}

{
  const live = `${ORIGIN}/assets/live-L1.js`
  const h = runHook({ remap: { [live]: { to: `${live}?asset-repair=1`, until: Date.now() + 60_000 }, old: { to: 'x', until: 1 } } })
  const map = h.appended.find((el) => el.type === 'importmap')
  assert.ok(map, '有记录时插 import map')
  assert.deepEqual(JSON.parse(map.textContent), { imports: { [live]: `${live}?asset-repair=1` } }, '过期项丢掉')
  assert.equal(runHook({ remap: { [live]: { to: 'y', until: Date.now() + 1 } }, supports: false }).appended.length, 0, '不支持 import map 的浏览器不插')
  assert.equal(runHook({}).appended.length, 0, '正常访问什么都不插、不加载修复脚本')

  // 入口模块链接失败：window 收到 SyntaxError，解析出被导入的那个文件
  const err = Object.assign(new SyntaxError("The requested module './live-L1.js' does not provide an export named 'x'"), {})
  h.listeners.error({ error: err, filename: `${ORIGIN}/assets/index-ABCD1234.js` })
  assert.equal(h.appended.filter((el) => el.src === '/asset-repair-v1.js').length, 1, '出错才加载修复脚本')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual([...h.repairCalls[0].urls], [`${ORIGIN}/assets/index-ABCD1234.js`, live])
  h.listeners.error({ error: new TypeError('x'), filename: `${ORIGIN}/assets/a.js` })
  h.listeners.error({ error: new SyntaxError('Unexpected token'), filename: 'https://third.party/x.js' })
  assert.equal(h.repairCalls.length, 1, '别的错误、第三方脚本不触发')
}

/* ---------- 服务端 ---------- */
assert.deepEqual(parseRepairRequest({ build: 'ABCD1234', files: ['live-L1.js', 'live-L1.js', '../x.js', 'integrity-a.json', 7] }), { build: 'ABCD1234', files: ['live-L1.js'] })
assert.equal(parseRepairRequest({ build: 'legacy-abc1', files: ['a.js'] }), null)
assert.equal(parseRepairRequest({ build: 'ABCD1234', files: [] }), null)
assert.equal(parseRepairRequest({ build: '../../etc', files: ['a.js'] }), null)
{
  const dir = mkdtempSync(path.join(tmpdir(), 'asset-repair-'))
  mkdirSync(path.join(dir, 'assets'))
  for (const [name, text] of Object.entries(GOOD)) writeFileSync(path.join(dir, 'assets', name), text)
  writeFileSync(path.join(dir, 'assets', 'other-O1.js'), 'tampered on disk')
  writeFileSync(path.join(dir, 'assets', 'integrity-ABCD1234.json'), JSON.stringify(MANIFEST))
  const purged = []
  const logs = []
  let clock = 1_000_000
  const app = express()
  app.set('trust proxy', false)
  app.use(express.json())
  app.use('/api/asset-repair', createAssetRepairRouter({
    clientDir: dir,
    siteOrigin: ORIGIN,
    purge: async (urls) => { purged.push(urls) },
    purgeEnabled: () => true,
    now: () => clock,
    log: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  }))
  const server = app.listen(0)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}/api/asset-repair`
  const post = (body) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const settle = () => new Promise((r) => setTimeout(r, 30))
  try {
    let res = await post({ build: 'ABCD1234', files: ['live-L1.js', 'other-O1.js', 'not-in-manifest.js'] })
    assert.equal(res.status, 202)
    assert.equal((await res.json()).accepted, 2)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    await settle()
    assert.deepEqual(purged, [[`${ORIGIN}/assets/live-L1.js`]], '只清磁盘与清单一致的文件，清完整 URL')
    assert.ok(logs.some((m) => /other-O1\.js 和构建清单对不上/.test(m)), '磁盘坏了打错误日志')

    res = await post({ build: 'ABCD1234', files: ['live-L1.js'] })
    await settle()
    assert.equal(purged.length, 1, '同一文件 15 分钟内只清一次')
    clock += 16 * 60 * 1000
    await post({ build: 'ABCD1234', files: ['live-L1.js'] })
    await settle()
    assert.equal(purged.length, 2)

    assert.equal((await post({ build: 'NOPE0000', files: ['a.js'] })).status, 404, '没有这一版的清单')
    assert.equal((await post({ build: 'x', files: ['a.js'] })).status, 400)
    let limited = false
    for (let i = 0; i < 8; i++) if ((await post({ build: 'ABCD1234', files: ['live-L1.js'] })).status === 429) limited = true
    assert.ok(limited, '按 IP 限流')
  } finally {
    server.close()
  }
  const indexJs = read('server/src/index.js')
  assert.match(indexJs, /app\.use\('\/api\/asset-repair', createAssetRepairRouter\(/)
  assert.match(read('server/src/cache.js'), /asset-repair-v\\d\+\\\.js/, '修复脚本按文件名代次长期缓存')
}

/* ---------- React 兜底页 ---------- */
{
  const boundary = read('src/components/AppErrorBoundary.tsx')
  assert.match(boundary, /if \(!recoverBrokenAsset\(error, info\)\) reportRenderCrash\(error, info\)/)
  assert.match(boundary, /if \(repairFixedSomething\(result\)\) \{\s*reportRenderCrash\(error, info, summarizeRepair\(result\)\)\s*reloadOnce\(\)/, '修好了：先上报再刷新')
  assert.match(boundary, /if \(stale && reloadOnce\(\)\) return/, '404 那类旧 chunk 照旧刷新一次，不算故障')
  assert.match(boundary, /if \(!pending\) return stale \? reloadOnce\(\) : false/, '钩子不在时退回原来的行为')

  assert.deepEqual(moduleLinkFailure("SyntaxError: The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'"), { specifier: './live-Cqhc9j-k.js', exportName: 'x' })
  assert.deepEqual(moduleLinkFailure('SyntaxError: import not found: x'), { specifier: null, exportName: 'x' })
  assert.deepEqual(moduleLinkFailure("SyntaxError: Importing binding name 'x' is not found."), { specifier: null, exportName: 'x' })
  assert.equal(moduleLinkFailure('TypeError: Failed to fetch dynamically imported module'), null)
  assert.equal(resolveChunkUrl('./live-a.js', 'https://cn.8bitgo.com/_cn/assets/index-a.js'), 'https://cn.8bitgo.com/_cn/assets/live-a.js')
  assert.equal(resolveChunkUrl('https://evil.example/x.js', ENTRY), null)

  const empty = { manifest: true, checked: 3, ok: 3, repaired: [], refreshed: [], remapped: [], bad: [], failed: [], reloaded: false, ms: 12 }
  assert.equal(repairFixedSomething(empty), false)
  assert.equal(repairFixedSomething({ ...empty, remapped: ['a.js'] }), true)
  assert.equal(repairFixedSomething(null), false)
  assert.match(summarizeRepair({ ...empty, repaired: ['live-L1.js'] }), /浏览器缓存里的坏副本已重取：live-L1\.js/)
  assert.match(summarizeRepair({ ...empty, remapped: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] }), /CDN 边缘副本是坏的.*等 5 个/)
  assert.match(summarizeRepair(null), /没有运行/)
}

// 修复脚本只用 ES2017（页面兼容下限 Chrome 64）
{
  const src = read('public/asset-repair-v1.js')
  assert.ok(!/\?\.|\?\?|catch \{|=>/.test(src), '修复脚本不用可选链、空值合并、省略 catch 参数和箭头函数')
  assert.equal(createHash('sha256').update(src).digest('hex').length, 64)
}

console.log('✔ 坏 chunk 自修复：构建清单、内联钩子、缓存坏 / 边缘坏 / 源站坏三种处理、清边缘接口、兜底页接线')
