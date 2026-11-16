#!/usr/bin/env node
/**
 * 坏 chunk 自修复回归（不联网）：
 *   - 构建清单：文件名跟入口走、只收 /assets/ 子资源、按磁盘字节算 SHA-256；
 *   - 首页内联钩子：import map 改指、过期项丢弃、SyntaxError 才触发、点名文件解析、修复脚本加载经过；
 *   - 入口去掉 __assets=origin（兜底页改用主站资源重新载入）；
 *   - public/assets/asset-repair-v3.js：缓存坏→重取修好；边缘坏→回源地址 + 通知清缓存；源站坏→不刷新；
 *     正常文件不重取；点名文件强制覆盖；没清单只处理点名文件；一分钟内只刷新一次；
 *     取不下来→重试一次；大陆加速入口取不下来、主站正常→edgeOnly（诊断包 #761）；
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
  assetsFromCnEdge,
  consumeOriginAssetsParam,
  lazyChunkFile,
  lazyFailure,
  moduleLinkFailure,
  onOriginAssetsPage,
  originAssetsUrl,
  repairFixedSomething,
  resolveChunkUrl,
  summarizeRepair,
  tagLazyFailure,
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
/** vm 里的数组 / 对象原型和这边不同，deepStrictEqual 前转成普通值 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/**
 * 在 vm 里跑修复脚本。`serve(url, cacheMode)` 决定每次 fetch 返回什么：
 * 返回字符串 = 200 + 内容，数字 = HTTP 状态，null = 网络错误。
 */
function runRepair({ serve, opts = {}, resources = Object.keys(GOOD).map((n) => `${ORIGIN}/assets/${n}`), store = new Map(), session = new Map(), entry = ENTRY }) {
  // serve 可以返回 { error: 'AbortError' } 表示超时

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
      if (out && typeof out === 'object' && out.error) throw Object.assign(new Error('aborted'), { name: out.error })
      if (typeof out === 'number') return { ok: false, status: out, arrayBuffer: async () => enc('') }
      return { ok: true, status: 200, arrayBuffer: async () => enc(out) }
    },
    crypto: webcrypto,
    location: { pathname: '/games/x', origin: ORIGIN, href: `${ORIGIN}/games/x`, reload: () => { reloads++ } },
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
    URL,
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
  vm.runInContext(read('public/assets/asset-repair-v3.js'), context)
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

/* ---------- v3：取不下来的文件（诊断包 #761：微信 iOS 在 EdgeOne 上懒加载 GameDetailPage 失败） ---------- */
const CN = 'https://cn.8bitgo.com/_cn/assets'
const cnEntry = `${CN}/index-ABCD1234.js`
const cnManifest = `${CN}/integrity-ABCD1234.json`

{
  // 11. EdgeOne 上点名的 chunk 网络错误、重试还错，主站同名文件正常 → edgeOnly；不自己刷新，交给兜底页决定
  const r = await runRepair({
    entry: cnEntry,
    resources: [`${CN}/index-ABCD1234.js`],
    opts: { urls: [`${CN}/live-L1.js`] },
    serve(url) {
      if (url === cnManifest) return JSON.stringify(MANIFEST)
      if (url === `${CN}/live-L1.js`) return null
      return GOOD[fileOf(url)]
    },
  })
  assert.deepEqual(r.result.edgeOnly, ['live-L1.js'])
  assert.deepEqual(r.result.failed, [])
  assert.equal(r.result.from, 'cn.8bitgo.com')
  assert.equal(r.reloads, 0, 'edgeOnly 不算修好，脚本自己不刷新（刷新回来还是 EdgeOne）')
  assert.deepEqual(r.calls.filter((c) => fileOf(c.url) === 'live-L1.js').map((c) => [c.url, c.cache]), [
    [`${CN}/live-L1.js`, 'force-cache'],
    [`${CN}/live-L1.js`, 'reload'],
    [`${ORIGIN}/assets/live-L1.js`, 'reload'],
  ], '先缓存、再绕过缓存重试、最后才对照主站')
  assert.deepEqual(r.result.trace, ['live-L1.js 网络错误→网络错误，主站 正常'])
  assert.equal(r.posts.length, 0, '取不下来不是缓存坏字节，不请求清边缘缓存')
}

{
  // 12. 偶发：第一次取不下来，绕过缓存重试就好了 → recovered，算修好、刷新一次
  let hits = 0
  const r = await runRepair({
    entry: cnEntry,
    resources: [],
    opts: { urls: [`${CN}/live-L1.js`] },
    serve(url) {
      if (url === cnManifest) return JSON.stringify(MANIFEST)
      if (url === `${CN}/live-L1.js` && hits++ === 0) return 502
      return GOOD[fileOf(url)]
    },
  })
  assert.deepEqual(r.result.recovered, ['live-L1.js'])
  assert.deepEqual(r.result.trace, ['live-L1.js HTTP 502→重试正常'])
  assert.equal(r.reloads, 1)
  assert.equal(repairFixedSomething(r.result), true)
}

{
  // 13. EdgeOne 和主站都取不下来（访客断网）→ failed，trace 分得清超时和 HTTP 错误
  const r = await runRepair({
    entry: cnEntry,
    resources: [],
    opts: { urls: [`${CN}/live-L1.js`] },
    serve(url) {
      if (url === cnManifest) return JSON.stringify(MANIFEST)
      if (fileOf(url) === 'live-L1.js') return url.startsWith(CN) ? { error: 'AbortError' } : 503
      return GOOD[fileOf(url)]
    },
  })
  assert.deepEqual(r.result.failed, ['live-L1.js'])
  assert.deepEqual(r.result.edgeOnly, [])
  assert.deepEqual(r.result.trace, ['live-L1.js 超时→超时，主站 HTTP 503'])
  assert.equal(r.reloads, 0)
}

{
  // 14. 本来就同源（非大陆访客）：重试还取不下来就是 failed，没有「主站」可对照
  const r = await runRepair({
    resources: [],
    opts: { urls: [`${ORIGIN}/assets/live-L1.js`] },
    serve: (url) => (url === manifestUrl ? JSON.stringify(MANIFEST) : fileOf(url) === 'live-L1.js' ? 404 : GOOD[fileOf(url)]),
  })
  assert.deepEqual(r.result.failed, ['live-L1.js'])
  assert.equal(r.calls.filter((c) => fileOf(c.url) === 'live-L1.js').length, 2, '缓存一次 + 重试一次，不对照自己')
  assert.deepEqual(r.result.trace, ['live-L1.js HTTP 404→HTTP 404'])
}

/* ---------- 首页内联钩子 ---------- */
const html = read('index.html')
const hook = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('__8bitgoAssetRepair'))
assert.ok(hook, 'index.html 有坏 chunk 自修复钩子')
assert.ok(!/=>|\blet\b|\bconst\b|`/.test(hook), '钩子只能写 ES5')
assert.ok(html.indexOf('__8bitgoAssetRepair') < html.indexOf('type="module"'), '必须排在模块脚本之前，import map 才来得及生效')
assert.ok(html.indexOf('8bitgo.https-upgrade') < html.indexOf('__8bitgoAssetRepair'), 'HTTPS 守卫仍是第一段脚本')

function runHook({ remap, supports = true, entry = ENTRY, failing = [], hang = [], empty = [], timers = null } = {}) {
  const appended = []
  const listeners = {}
  const repairCalls = []
  const now = Date.now()
  const window = {
    HTMLScriptElement: { supports: () => supports },
    localStorage: { getItem: () => (remap ? JSON.stringify(remap) : null) },
    document: {
      head: {
        // 和真实浏览器一样：修复脚本「加载成功」时才定义 __8bitgoAssetRepairRun
        appendChild: (el) => {
          appended.push(el)
          if (!el.src || hang.includes(el.src)) return
          if (failing.includes(el.src)) return el.onerror?.()
          if (!empty.includes(el.src)) window.__8bitgoAssetRepairRun = run
          el.onload?.()
        },
      },
      createElement: () => ({}),
      querySelector: () => ({ src: entry }),
    },
    location: { href: `${ORIGIN}/games/test` },
    addEventListener: (type, fn) => { listeners[type] = fn },
    Promise,
    URL,
    setTimeout: timers ? (fn) => timers.push(fn) : setTimeout,
    clearTimeout: timers ? () => {} : clearTimeout,
    JSON,
    Date,
    Object,
    String,
  }
  window.window = window
  const run = (opts) => { repairCalls.push(opts); return { ok: true } }

  vm.runInContext(hook, vm.createContext(window))
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
  assert.equal(h.appended.filter((el) => el.src === `${ORIGIN}/assets/asset-repair-v3.js`).length, 1, '出错时跟随入口资源域加载修复脚本')
  assert.deepEqual(plain(h.window.__8bitgoAssetRepairLoad).map((a) => [a.u, a.r]), [[`${ORIGIN}/assets/asset-repair-v3.js`, 'ok']], '加载经过记下来')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual([...h.repairCalls[0].urls], [`${ORIGIN}/assets/index-ABCD1234.js`, live])
  h.listeners.error({ error: new TypeError('x'), filename: `${ORIGIN}/assets/a.js` })
  h.listeners.error({ error: new SyntaxError('Unexpected token'), filename: 'https://third.party/x.js' })
  assert.equal(h.repairCalls.length, 1, '别的错误、第三方脚本不触发')
}

{
  // 大陆入口：先从 EdgeOne 取修复脚本，加载失败再回主站；每一次的经过都记下来（诊断包 #761 只有「加载失败或超时」）
  const cnRepair = 'https://cn.8bitgo.com/_cn/assets/asset-repair-v3.js'
  const h = runHook({ entry: 'https://cn.8bitgo.com/_cn/assets/index-ABCD1234.js', failing: [cnRepair] })
  const result = await h.window.__8bitgoAssetRepair({ urls: [] })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(plain(h.window.__8bitgoAssetRepairLoad).map((a) => [a.u, a.r]), [[cnRepair, 'error'], [`${ORIGIN}/assets/asset-repair-v3.js`, 'ok']])
  assert.ok(h.window.__8bitgoAssetRepairLoad.every((a) => typeof a.ms === 'number' && a.ms >= 0))

  // 加载超时（5 秒没动静）：记 timeout，换下一个地址
  const timers = []
  const slow = runHook({ entry: 'https://cn.8bitgo.com/_cn/assets/index-ABCD1234.js', hang: [cnRepair], timers })
  const pending = slow.window.__8bitgoAssetRepair({ urls: [] })
  assert.equal(slow.window.__8bitgoAssetRepairLoad.length, 0)
  timers[0]()
  assert.deepEqual(await pending, { ok: true })
  assert.deepEqual(plain(slow.window.__8bitgoAssetRepairLoad).map((a) => a.r), ['timeout', 'ok'])

  // 两处都取不下来：结果为 null，经过里两条都在
  const dead = runHook({ entry: 'https://cn.8bitgo.com/_cn/assets/index-ABCD1234.js', failing: [cnRepair, `${ORIGIN}/assets/asset-repair-v3.js`] })
  assert.equal(await dead.window.__8bitgoAssetRepair({ urls: [] }), null)
  assert.deepEqual(plain(dead.window.__8bitgoAssetRepairLoad).map((a) => a.r), ['error', 'error'])

  // 加载了却没定义入口（拿到的不是这份脚本）
  const empty = runHook({ entry: 'https://cn.8bitgo.com/_cn/assets/index-ABCD1234.js', empty: [cnRepair] })
  await empty.window.__8bitgoAssetRepair({ urls: [] })
  assert.deepEqual(plain(empty.window.__8bitgoAssetRepairLoad).map((a) => a.r), ['empty', 'ok'])
}

{
  // __assets=origin：兜底页改用主站资源重新载入后，入口在路由读地址之前去掉参数，其余查询串和 hash 原样保留
  const hist = () => {
    const calls = []
    return { calls, state: { k: 1 }, replaceState: (state, _t, url) => calls.push([state, url]) }
  }
  const loc = (search) => ({ pathname: '/games/test', search, hash: '#top' })
  assert.equal(onOriginAssetsPage(), false)
  const h1 = hist()
  assert.equal(consumeOriginAssetsParam(loc('?__assets=origin'), h1), true)
  assert.deepEqual(h1.calls, [[{ k: 1 }, '/games/test#top']])
  assert.equal(onOriginAssetsPage(), true)
  const h2 = hist()
  consumeOriginAssetsParam(loc('?a=1&__assets=origin&b=2'), h2)
  assert.deepEqual(h2.calls.map((c) => c[1]), ['/games/test?a=1&b=2#top'])
  const h3 = hist()
  assert.equal(consumeOriginAssetsParam(loc('?a=1'), h3), false)
  assert.equal(h3.calls.length, 0)
  assert.equal(consumeOriginAssetsParam(loc('?__assets=originx'), hist()), false, '只认 origin 这一个值')
  assert.equal(consumeOriginAssetsParam(loc('?__assets=origin'), { state: null, replaceState() { throw new Error('SecurityError') } }), true, '改不了地址栏也不抛错')
  // 入口在渲染前调用；不放进内联钩子：钩子后面的语言跳转会用 location.search 拼地址
  const entry = read('src/entry-client.tsx')
  assert.ok(entry.indexOf('consumeOriginAssetsParam()') > 0 && entry.indexOf('consumeOriginAssetsParam()') < entry.indexOf('async function start()'))
  assert.doesNotMatch(hook, /__assets/, '内联钩子不碰 __assets')
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
  assert.match(boundary, /if \(repairFixedSomething\(result\)\) \{\s*reportRenderCrash\(error, info, note\)\s*if \(!reloadOnce\(\) && claimOriginReload\(edge\)\) toOrigin\(\)/, '修好了：先上报再刷新；一分钟内又坏了才换主站')
  assert.match(boundary, /if \(stale && reloadOnce\(\)\) return/, '404 那类旧 chunk 照旧刷新一次，不算故障')
  assert.match(boundary, /if \(!pending\) return stale \? reloadOnce\(\) : false/, '钩子不在时退回原来的行为')
  // 诊断包 #761：大陆加速入口取不下来、主站正常 → 先上报，再带 __assets=origin 整页重新载入
  assert.match(boundary, /if \(edge && result\?\.edgeOnly\?\.length && claimOriginReload\(edge\)\) \{\s*reportRenderCrash\([^;]+\)\s*toOrigin\(\)/)
  assert.ok(boundary.indexOf('result?.edgeOnly?.length') < boundary.indexOf('if (repairFixedSomething(result))'), 'edgeOnly 先于「修好了」判断：刷新回来还是 EdgeOne')
  assert.match(boundary, /const edge = stale && assetsFromCnEdge\(entrySrc, location\.origin\)/, '只有大陆加速入口上的加载失败才换主站')
  assert.match(boundary, /const toOrigin = \(\) => location\.replace\(originAssetsUrl\(location\)\)/)
  assert.match(boundary, /lazy\?\.file \? resolveChunkUrl\(`\.\/\$\{lazy\.file\}`, entrySrc\)/, '懒加载失败的 chunk 作为点名文件交给修复脚本')
  assert.match(boundary, /summarizeRepair\(result, repairLoadInfo\(\)\)/, '诊断包写出修复脚本的加载经过')
  assert.match(boundary, /if \(onOriginAssetsPage\(\)\) location\.replace\(originAssetsUrl\(location\)\)/, '退到主站之后再刷新也留在主站')

  const lazy = read('src/routes/lazy.tsx')
  assert.match(lazy, /tagLazyFailure\(error, lazyChunkFile\(load\), name\)/, 'lazyNamed 失败时把 chunk 文件名挂在错误上')

  assert.deepEqual(moduleLinkFailure("SyntaxError: The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'"), { specifier: './live-Cqhc9j-k.js', exportName: 'x' })
  assert.deepEqual(moduleLinkFailure('SyntaxError: import not found: x'), { specifier: null, exportName: 'x' })
  assert.deepEqual(moduleLinkFailure("SyntaxError: Importing binding name 'x' is not found."), { specifier: null, exportName: 'x' })
  assert.equal(moduleLinkFailure('TypeError: Failed to fetch dynamically imported module'), null)
  assert.equal(resolveChunkUrl('./live-a.js', 'https://cn.8bitgo.com/_cn/assets/index-a.js'), 'https://cn.8bitgo.com/_cn/assets/live-a.js')
  assert.equal(resolveChunkUrl('https://evil.example/x.js', ENTRY), null)

  // 生产构建里懒加载函数的源码就带着 chunk 文件名（2026-11-16 线上 index-BFBijGbj.js 的写法）
  const built = '()=>h(()=>import(`./GameDetailPage-BfqMSSyK.js`),__vite__mapDeps([28,1,2]),import.meta.url)'
  assert.equal(lazyChunkFile({ toString: () => built }), 'GameDetailPage-BfqMSSyK.js')
  assert.equal(lazyChunkFile({ toString: () => '()=>import("./BrowsePages-x1.js")' }), 'BrowsePages-x1.js')
  assert.equal(lazyChunkFile(() => import('@/pages/GameDetailPage')), null, '开发环境的源码路径认不出就算了')
  assert.equal(lazyChunkFile({ toString: () => '()=>import("https://evil.example/x.js")' }), null)
  const err = new TypeError('Importing a module script failed.')
  tagLazyFailure(err, 'GameDetailPage-BfqMSSyK.js', 'GameDetailPage')
  assert.deepEqual(lazyFailure(err), { file: 'GameDetailPage-BfqMSSyK.js', name: 'GameDetailPage' })
  assert.equal(Object.keys(err).length, 0, '不可枚举，不污染错误对象的序列化')
  assert.equal(lazyFailure(new Error('x')), null)
  tagLazyFailure(Object.freeze(new Error('frozen')), 'a.js', 'A')

  assert.equal(assetsFromCnEdge('https://cn.8bitgo.com/_cn/assets/index-a.js', 'https://8bitgo.com'), true)
  assert.equal(assetsFromCnEdge('https://8bitgo.com/assets/index-a.js', 'https://8bitgo.com'), false, '主站资源')
  assert.equal(assetsFromCnEdge('https://cn.8bitgo.com/assets/index-a.js', 'https://cn.8bitgo.com'), false, '大陆入口站点本身是同源')
  assert.equal(assetsFromCnEdge('', 'https://8bitgo.com'), false)
  assert.equal(originAssetsUrl({ pathname: '/games/x', search: '', hash: '' }), '/games/x?__assets=origin')
  assert.equal(originAssetsUrl({ pathname: '/de/games', search: '?page=2&__assets=origin', hash: '#c' }), '/de/games?page=2&__assets=origin#c', '不重复加参数')

  const empty = { manifest: true, checked: 3, ok: 3, repaired: [], refreshed: [], remapped: [], bad: [], failed: [], reloaded: false, ms: 12 }
  assert.equal(repairFixedSomething(empty), false)
  assert.equal(repairFixedSomething({ ...empty, remapped: ['a.js'] }), true)
  assert.equal(repairFixedSomething({ ...empty, recovered: ['a.js'] }), true, '重试后正常也算修好')
  assert.equal(repairFixedSomething({ ...empty, edgeOnly: ['a.js'] }), false, 'edgeOnly 要换主站，不是普通刷新能好的')
  assert.equal(repairFixedSomething(null), false)
  assert.match(summarizeRepair({ ...empty, repaired: ['live-L1.js'] }), /浏览器缓存里的坏副本已重取：live-L1\.js/)
  assert.match(summarizeRepair({ ...empty, remapped: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] }), /CDN 边缘副本是坏的.*等 5 个/)
  assert.match(
    summarizeRepair({ ...empty, from: 'cn.8bitgo.com', edgeOnly: ['GameDetailPage-x.js'], trace: ['GameDetailPage-x.js 网络错误→网络错误，主站 正常'] }),
    /资源在 cn\.8bitgo\.com.*大陆加速入口取不下来、主站正常：GameDetailPage-x\.js.*经过：GameDetailPage-x\.js 网络错误→网络错误，主站 正常/,
  )
  assert.match(summarizeRepair(null), /没有运行/, '旧调用方不给加载经过时保持原文')
  // 「修复脚本没有运行」分清加载失败 / 超时 / 已加载但核对没结束（诊断包 #761 只有一句「加载失败或超时」）
  const cnRepair = 'https://cn.8bitgo.com/_cn/assets/asset-repair-v3.js'
  assert.equal(
    summarizeRepair(null, { attempts: [{ u: cnRepair, r: 'error', ms: 812 }, { u: 'https://8bitgo.com/assets/asset-repair-v3.js', r: 'timeout', ms: 5003 }], timedOut: false, noHook: false }),
    `资源核对：修复脚本没有加载上：${cnRepair} 加载失败 812ms；https://8bitgo.com/assets/asset-repair-v3.js 5 秒超时 5003ms`,
  )
  assert.match(summarizeRepair(null, { attempts: [{ u: cnRepair, r: 'ok', ms: 90 }], timedOut: true, noHook: false }), /修复脚本已加载.*核对 20 秒内没有结束/)
  assert.match(summarizeRepair(null, { attempts: [], timedOut: true, noHook: false }), /20 秒内修复脚本一次加载都没结束/)
  assert.match(summarizeRepair(null, { attempts: [], timedOut: false, noHook: true }), /页面没有修复钩子/)
}

// 修复脚本只用 ES2017（页面兼容下限 Chrome 64）；旧的 v2 留着给已打开的旧页面用
{
  for (const file of ['public/assets/asset-repair-v3.js', 'public/assets/asset-repair-v2.js']) {
    const src = read(file)
    assert.ok(!/\?\.|\?\?|catch \{|=>/.test(src), `${file} 不用可选链、空值合并、省略 catch 参数和箭头函数`)
    assert.equal(createHash('sha256').update(src).digest('hex').length, 64)
  }
  assert.match(read('index.html'), /asset-repair-v3\.js/, '首页钩子加载 v3')
  assert.doesNotMatch(read('index.html'), /asset-repair-v2\.js/)
}

console.log('✔ 坏 chunk 自修复：构建清单、内联钩子（加载经过）、去 __assets 参数、缓存坏 / 边缘坏 / 源站坏 / EdgeOne 取不下来、清边缘接口、兜底页接线')
