#!/usr/bin/env node
/**
 * 懒加载导入的抗失败与构建检查（不联网、不开浏览器；真浏览器验收见 scripts/test-lazy-imports-browser.mjs）：
 *   - 预加载助手（scripts/lib/vite-resilient-preload.mjs）：Chromium 上 JS 依赖暖缓存、CSS 样式表等待并有限重试，
 *     同一依赖只取一次、失败链接移除、卡住会中止、确实取不下来时抛带标记的错误且不碰模块表；非 Chromium / legacy 原样交回 Vite；
 *   - Vite 的助手模板还是补丁认得的写法（升级 Vite 时第一个红的就是这里）；
 *   - importWithRetry：暖缓存失败后再走一遍原加载函数，而不是换查询串；
 *   - check-lazy-imports.mjs：缺懒加载目标 / 缺依赖 / 助手没换上 / 扇出超标 / 首屏超标都会拦。
 *
 * 2026-11-19 在 Chromium 153 与 WebKit 26.6 上量过的事实（用到的数字都来自这次实验，见 AGENTS.md §2.39）：
 *   - modulepreload（Vite 默认）：每个依赖只下一次，但依赖第一次 503 / 被中止，导入就失败且被本页模块表记住；
 *   - fetch 暖缓存再 import：依赖 503 一次后能恢复；Chromium（普通 / 无痕）与有磁盘缓存的 WebKit 只下一次，
 *     WebKit 临时会话（Safari 无痕）下两遍 → 助手只在 Chromium 上启用；
 *   - <link rel=preload as=script crossorigin>：两家都被模块加载器复用，但失败的预加载也被复用，重试无效。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {
  PRELOAD_FAILURE_PROP,
  RESILIENT_PRELOAD_CODE,
  RESILIENT_PRELOAD_MARKER,
  patchPreloadHelper,
} from './lib/vite-resilient-preload.mjs'
import { analyzeLazyImports, MAX_ENTRY_CLOSURE_BYTES, MAX_LAZY_FANOUT } from './check-lazy-imports.mjs'
import { importWithRetry, lazyFailure, preloadFailure, retryableImportError, tagLazyFailure, describeImportEvidence } from '../src/services/moduleLinkRecovery.ts'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const BASE = 'https://8bitgo.com/assets/'

/* ---------- Vite 助手模板没变 ---------- */
{
  const vite = read('node_modules/vite/dist/node/chunks/node.js')
  assert.match(vite, /const preloadMethod = `__vitePreload`;/, 'Vite 助手的导出名还是 __vitePreload')
  assert.match(vite, /export const \$\{preloadMethod\} = \$\{preloadMethodCode\}/, 'Vite 助手仍以 export const 导出（补丁改名靠它）')
  assert.match(vite, /const assetsURL = \$\{assetsURL\};/)
  assert.match(vite, /const isCssPreloadUrl = \$\{isCssPreloadUrl\.toString\(\)\};/)
  assert.match(vite, /const preloadHelperId = "\\0vite\/preload-helper\.js";/)
  // 和 Vite 生成的形状一致的样本：补丁把原函数改名、接上包装
  const sample = 'const scriptRel = "modulepreload";const assetsURL = function(dep, importerUrl) { return new URL(dep, importerUrl).href };const seen = {};const isCssPreloadUrl = function isCssPreloadUrl(url) { return url.pathname.endsWith(".css"); };const preloadOnce = function(){};export const __vitePreload = function preload(baseModule, deps, importerUrl) { return baseModule() }'
  const patched = patchPreloadHelper(sample)
  assert.ok(patched.includes('const __vitePreloadVite = function preload('))
  assert.equal(patched.match(/export const __vitePreload\b/g).length, 1, '只剩一个 __vitePreload 导出（包装）')
  assert.equal(patchPreloadHelper('export default 1'), null, '认不出写法就返回 null，插件让构建失败')
  assert.ok(RESILIENT_PRELOAD_CODE.includes(RESILIENT_PRELOAD_MARKER), '构建检查认的标记在助手代码里（错误文字，压缩后也留着）')
  assert.ok(RESILIENT_PRELOAD_CODE.includes(PRELOAD_FAILURE_PROP))
  const config = read('vite.config.ts')
  assert.match(config, /resilientPreloadPlugin\(\),/, 'vite 配置挂上了插件')
  assert.match(read('package.json'), /check-asset-integrity\.mjs && node scripts\/check-lazy-imports\.mjs/, 'postbuild 跑懒加载导入图检查')
  assert.doesNotMatch(RESILIENT_PRELOAD_CODE, /=>\s*\{[^}]*import\(/, '助手不自己发 import()')
}

/* ---------- 在 VM 里跑助手 ---------- */
function makeHelper({ chromium = true, modern = true, fetchImpl, cssImpl = () => true, links = [], cssLinks = [], scripts = [], timings = {} } = {}) {
  const calls = { vite: [], fetch: [], css: [] }
  const moduleLinks = links.map((href) => ({ href: new URL(href, BASE).href, rel: 'modulepreload', sheet: null }))
  const stylesheetLinks = cssLinks.map((href) => ({ href: new URL(href, BASE).href, rel: 'stylesheet', sheet: {} }))
  const makeLink = () => {
    const listeners = new Map()
    return {
      rel: '', href: '', crossOrigin: '', sheet: null, parentNode: null,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
      dispatch: (name) => { const fn = listeners.get(name); if (fn) fn() },
    }
  }
  const head = {
    appendChild: (link) => {
      link.parentNode = head
      stylesheetLinks.push(link)
      calls.css.push(link.href)
      Promise.resolve().then(() => cssImpl(link.href, calls.css.length)).then((loaded) => {
        if (loaded) { link.sheet = {}; link.dispatch('load') }
        else link.dispatch('error')
      }, () => link.dispatch('error'))
      return link
    },
    removeChild: (link) => {
      const index = stylesheetLinks.indexOf(link)
      if (index >= 0) stylesheetLinks.splice(index, 1)
      link.parentNode = null
      return link
    },
  }
  let code = RESILIENT_PRELOAD_CODE
    .replace('export const __vitePreload', 'globalThis.__vitePreload')
    .replaceAll('import.meta.url', JSON.stringify(`${BASE}index-X.js`))
    .replaceAll('__VITE_IS_MODERN__', String(modern))
  for (const [name, value] of Object.entries(timings)) code = code.replace(new RegExp(`const ${name} = [^;]+;`), `const ${name} = ${value};`)
  const context = {
    URL,
    Promise,
    Set,
    Object,
    TypeError,
    Error,
    AbortController,
    setTimeout,
    clearTimeout,
    navigator: chromium ? { userAgentData: { brands: [{ brand: 'Chromium', version: '150' }] } } : {},
    document: {
      head,
      createElement: (tag) => { assert.equal(tag, 'link'); return makeLink() },
      getElementsByTagName: (tag) => (tag === 'link' ? [...moduleLinks, ...stylesheetLinks] : scripts.map((src) => ({ src }))),
    },
    assetsURL: (dep, importerUrl) => new URL(dep, importerUrl).href,
    isCssPreloadUrl: (url) => url.pathname.endsWith('.css'),
    __vitePreloadVite: (baseModule, deps) => {
      calls.vite.push(deps ? [...deps] : deps)
      return baseModule()
    },
    fetch: async (href, init) => {
      calls.fetch.push(href)
      return fetchImpl(href, init)
    },
  }
  context.globalThis = context
  vm.runInContext(code, vm.createContext(context))
  return { preload: context.__vitePreload, calls, stylesheetLinks }
}
const ok = () => ({ ok: true, status: 200, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new Uint8Array(4) })) } } } })
const status = (code) => ({ ok: false, status: code })
const IMPORTER = `${BASE}index-X.js`

{
  // 1. 全部正常：每个 JS 依赖 fetch 一次，HTML 里已有 modulepreload 的不取，CSS 先加载；全部完成才导入
  let imported = false
  const { preload, calls } = makeHelper({ fetchImpl: () => ok(), links: [`${BASE}react-vendor-R.js`] })
  const result = await preload(async () => { imported = true; return { page: 1 } }, ['./Page-P.js', './dep-D.js', './react-vendor-R.js', './Page-P.css'], IMPORTER)
  assert.deepEqual(result, { page: 1 })
  assert.ok(imported)
  assert.deepEqual(calls.fetch, [`${BASE}Page-P.js`, `${BASE}dep-D.js`])
  assert.deepEqual(calls.css, [`${BASE}Page-P.css`], 'CSS 用 stylesheet link 加载并等待完成')
  assert.deepEqual(JSON.parse(JSON.stringify(calls.vite)), [[]], 'JS 和 CSS 均自行准备后，Vite 只负责执行导入')
}

{
  // 1a. CSS 首次失败：移除失败 link，用唯一查询串绕过缓存重试一次
  let attempts = 0
  const { preload, calls, stylesheetLinks } = makeHelper({
    timings: { __8bitgoWarmRetryMs: '[1]' },
    cssImpl: () => ++attempts > 1,
  })
  assert.equal(await preload(async () => 'page', ['./Page-P.css'], IMPORTER), 'page')
  assert.equal(calls.css.length, 2)
  assert.equal(new URL(calls.css[0]).searchParams.has('8bg-css-retry'), false)
  assert.ok(new URL(calls.css[1]).searchParams.has('8bg-css-retry'), '重试 URL 必须绕过失败响应缓存')
  assert.equal(stylesheetLinks.length, 1, '失败 stylesheet 已从文档移除')
  assert.equal(stylesheetLinks[0].href, calls.css[1])
  assert.deepEqual(JSON.parse(JSON.stringify(calls.vite)), [[]])
}

{
  // 1b. 持续失败：仅两次 link 请求，输出可供诊断与恢复逻辑使用的 CSS 文件名
  const { preload, calls } = makeHelper({ timings: { __8bitgoWarmRetryMs: '[1]' }, cssImpl: () => false })
  const error = await preload(async () => 'unreachable', ['./Page-P.css'], IMPORTER).then(() => null, (e) => e)
  assert.ok(error)
  assert.equal(calls.css.length, 2, 'CSS 有界重试一次，不能循环请求')
  assert.deepEqual(JSON.parse(JSON.stringify(error[PRELOAD_FAILURE_PROP])), { failed: ['Page-P.css'] })
  assert.deepEqual(JSON.parse(JSON.stringify(preloadFailure(error))), { failed: ['Page-P.css'] })
  assert.equal(retryableImportError(error), true)
  assert.match(error.message, /Unable to preload CSS for Page-P\.css/)
}

{
  // 1c. HTML 中已有成功的 stylesheet 直接复用；并发懒加载共享同一次请求
  const existing = makeHelper({ cssLinks: [`${BASE}Page-P.css`] })
  await existing.preload(async () => 'page', ['./Page-P.css'], IMPORTER)
  assert.deepEqual(existing.calls.css, [])
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const shared = makeHelper({ cssImpl: async () => { await gate; return true } })
  const a = shared.preload(async () => 'a', ['./Page-P.css'], IMPORTER)
  const b = shared.preload(async () => 'b', ['./Page-P.css'], IMPORTER)
  release()
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b'])
  assert.equal(shared.calls.css.length, 1, '相同 CSS 并发加载只插一次 stylesheet')
}

{
  // 2. 依赖第一次网络错误：600ms 后重试成功，导入照常
  let n = 0
  const { preload, calls } = makeHelper({
    timings: { __8bitgoWarmRetryMs: '[5]' },
    fetchImpl: (href) => (href.endsWith('dep-D.js') && n++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : ok()),
  })
  assert.deepEqual(await preload(async () => 'page', ['./Page-P.js', './dep-D.js'], IMPORTER), 'page')
  assert.equal(calls.fetch.filter((u) => u.endsWith('dep-D.js')).length, 2)
}

{
  // 3. 503 重试后仍 503：抛带标记的错误，没调用导入（模块表干净）；措辞仍被现有恢复逻辑认作可重试的懒加载失败
  let imported = false
  const { preload, calls } = makeHelper({
    timings: { __8bitgoWarmRetryMs: '[1]' },
    fetchImpl: (href) => (href.endsWith('dep-D.js') ? status(503) : ok()),
  })
  const error = await preload(async () => { imported = true }, ['./Page-P.js', './dep-D.js'], IMPORTER).then(() => null, (e) => e)
  assert.ok(error, '应当失败')
  assert.equal(imported, false, '不碰模块表')
  assert.deepEqual(JSON.parse(JSON.stringify(error[PRELOAD_FAILURE_PROP])), { failed: ['dep-D.js'] })
  assert.equal(calls.fetch.filter((u) => u.endsWith('dep-D.js')).length, 2, '5xx 重试一次')
  assert.equal(retryableImportError(error), true)
  assert.match(error.message, /Failed to fetch dynamically imported module \(dependency warm-up failed\): dep-D\.js/)
  assert.deepEqual(JSON.parse(JSON.stringify(preloadFailure(error))), { failed: ['dep-D.js'] })
  // 失败的不留在表里：下一次加载会重新取
  const again = await preload(async () => 'x', ['./dep-D.js'], IMPORTER).then(() => null, (e) => e)
  assert.ok(again)
  assert.equal(calls.fetch.filter((u) => u.endsWith('dep-D.js')).length, 4)
}

{
  // 4. 404 是确定性错误（部署切换的旧 chunk）：不重试
  const { preload, calls } = makeHelper({ fetchImpl: (href) => (href.endsWith('old-O.js') ? status(404) : ok()) })
  await assert.rejects(preload(async () => 'x', ['./Page-P.js', './old-O.js'], IMPORTER))
  assert.equal(calls.fetch.filter((u) => u.endsWith('old-O.js')).length, 1)
}

{
  // 5. 这一页 fetch() 从没成功过（策略 / 扩展拦了 fetch）：原样交回 Vite（含全部依赖），等于以前的行为
  let imported = false
  const { preload, calls } = makeHelper({ timings: { __8bitgoWarmRetryMs: '[1]' }, fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) })
  await preload(async () => { imported = true }, ['./Page-P.js', './dep-D.js'], IMPORTER)
  assert.ok(imported)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.vite)), [['./Page-P.js', './dep-D.js']])
}

{
  // 6. 非 Chromium（Safari / Firefox）与 legacy：完全不碰，交回 Vite
  for (const options of [{ chromium: false }, { modern: false }]) {
    const { preload, calls } = makeHelper({ ...options, fetchImpl: () => ok() })
    await preload(async () => 'x', ['./Page-P.js'], IMPORTER)
    assert.deepEqual(calls.fetch, [])
    assert.deepEqual(JSON.parse(JSON.stringify(calls.vite)), [['./Page-P.js']])
  }
  const { preload, calls } = makeHelper({ fetchImpl: () => ok() })
  await preload(async () => 'x', undefined, IMPORTER)
  await preload(async () => 'x', [], IMPORTER)
  assert.equal(calls.fetch.length, 0, '没有依赖表（legacy 传 void 0）')
}

{
  // 7. 两个懒加载同时用到同一个依赖：只取一次
  let release
  const gate = new Promise((r) => { release = r })
  const { preload, calls } = makeHelper({ fetchImpl: async () => { await gate; return ok() } })
  const a = preload(async () => 'a', ['./A-A.js', './shared-S.js'], IMPORTER)
  const b = preload(async () => 'b', ['./B-B.js', './shared-S.js'], IMPORTER)
  release()
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b'])
  assert.equal(calls.fetch.filter((u) => u.endsWith('shared-S.js')).length, 1)
}

{
  // 7a. 成功结果不能永久代替缓存状态：长驻页被浏览器淘汰缓存后，重试要重新暖依赖。
  const { preload, calls } = makeHelper({ fetchImpl: () => ok() })
  await preload(async () => 'first', ['./shared-S.js'], IMPORTER)
  await preload(async () => 'retry', ['./shared-S.js'], IMPORTER)
  assert.equal(calls.fetch.filter((u) => u.endsWith('shared-S.js')).length, 2,
    '每次新的懒加载尝试都应重新检查 HTTP 缓存；浏览器缓存命中时不会额外走网络')
}

{
  // 8. 正文卡住不动：按停滞时限中止、重试
  let n = 0
  const { preload, calls } = makeHelper({
    timings: { __8bitgoWarmRetryMs: '[1]', __8bitgoWarmStallMs: '20' },
    fetchImpl: (href, init) => {
      if (n++ > 0) return ok()
      return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }) } }
    },
  })
  assert.equal(await preload(async () => 'page', ['./slow-S.js'], IMPORTER), 'page')
  assert.equal(calls.fetch.length, 2)
}

/* ---------- importWithRetry：暖缓存失败后整套重来，不换查询串 ---------- */
{
  const warmError = (name = 'AgeGate-A.js') => {
    const e = new TypeError(`Failed to fetch dynamically imported module (dependency warm-up failed): ${name}`)
    Object.defineProperty(e, PRELOAD_FAILURE_PROP, { value: { failed: [name] }, configurable: true })
    return e
  }
  let loads = 0
  const urls = []
  const env = { sleep: async () => {}, waitOnline: async () => {}, online: () => true, importUrl: async (u) => { urls.push(u); return {} }, resources: () => [] }
  const result = await importWithRetry(async () => { if (loads++ < 2) throw warmError(); return { ok: true } }, 'GameDetailPage-G.js', `${BASE}index-X.js`, env)
  assert.deepEqual(result, { ok: true })
  assert.equal(loads, 3, '三次都走原加载函数（助手会重新暖缓存）')
  assert.deepEqual(urls, [], '不换查询串')

  let cssLoads = 0
  const cssUrls = []
  const cssResult = await importWithRetry(async () => { if (cssLoads++ === 0) throw warmError('Page-P.css'); return { css: true } }, 'GameDetailPage-G.js', `${BASE}index-X.js`, {
    ...env,
    importUrl: async (u) => { cssUrls.push(u); return {} },
  })
  assert.deepEqual(cssResult, { css: true })
  assert.equal(cssLoads, 2, 'CSS 预加载失败后重新走原加载函数')
  assert.deepEqual(cssUrls, [], 'CSS 预加载失败不能换懒加载入口查询串')

  // 三次都失败：证据标成 preload，兜底页据此写诊断包、把失败的依赖交给修复脚本
  let last
  await importWithRetry(async () => { throw (last = warmError()) }, 'GameDetailPage-G.js', `${BASE}index-X.js`, env).catch(() => {})
  tagLazyFailure(last, 'GameDetailPage-G.js', 'GameDetailPage')
  assert.deepEqual(lazyFailure(last).graph, { top: 'preload', failed: ['AgeGate-A.js'] })
  assert.match(describeImportEvidence(lazyFailure(last).graph), /静态依赖重试后仍取不下来.*AgeGate-A\.js/)
  // 暖缓存成功、模块加载器那一层才失败：照旧看模块图证据
  let n = 0
  const urls2 = []
  await importWithRetry(async () => { n++; throw n === 1 ? warmError() : new TypeError('Failed to fetch dynamically imported module: x') }, 'G-a.js', `${BASE}index-X.js`, {
    ...env,
    importUrl: async (u) => { urls2.push(u); return 'busted' },
    resources: () => [{ name: `${BASE}G-a.js`, decodedBodySize: 0, responseStatus: 503 }],
  }).catch(() => {})
  assert.equal(n, 2, '第二次是加载器层失败（入口没下下来）')
  assert.equal(urls2.length, 1, '入口自己失败：照旧换查询串')
}

/* ---------- check-lazy-imports.mjs ---------- */
function fakeDist({ helper = true, dynamicTarget = 'Page-P.js', missing = [], extraDeps = 0, entryBytes = 1000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lazy-imports-'))
  mkdirSync(path.join(dir, 'assets'))
  const files = {
    'index-E.js': `${'x'.repeat(entryBytes)};const load=()=>X(()=>import("./${dynamicTarget}"),[],import.meta.url)${helper ? `;"${RESILIENT_PRELOAD_MARKER}";"${PRELOAD_FAILURE_PROP}"` : ''}`,
    'Page-P.js': 'import"./dep-D.js"',
    'dep-D.js': 'export{}',
    'index-legacy-L.js': 'System.register(["./shared-legacy-S.js"],function(){});e.import("./Page-legacy-Q.js")',
    'shared-legacy-S.js': '',
    'Page-legacy-Q.js': '',
  }
  const imports = { 'Page-P.js': ['dep-D.js'] }
  for (let i = 0; i < extraDeps; i++) {
    files[`d${i}-H.js`] = 'export{}'
    imports['Page-P.js'].push(`d${i}-H.js`)
  }
  for (const [name, body] of Object.entries(files)) if (!missing.includes(name)) writeFileSync(path.join(dir, 'assets', name), body)
  writeFileSync(path.join(dir, 'assets', 'integrity-E.json'), JSON.stringify({ v: 2, alg: 'sha256', files: Object.fromEntries(Object.keys(files).filter((n) => !n.includes('legacy')).map((n) => [n, 'x'])), imports }))
  writeFileSync(path.join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-E.js"></script><script nomodule crossorigin id="vite-legacy-entry" data-src="/assets/index-legacy-L.js">System.import(this.getAttribute("data-src"))</script>')
  // 生产目录故意留着上一版的旧哈希文件（bdf1591）：它们引用的东西早就不在了，不能算进本次构建
  writeFileSync(path.join(dir, 'assets', 'old-Page-OLD.js'), 'import("./gone-GONE.js")')
  writeFileSync(path.join(dir, 'assets', 'old-legacy-OLD.js'), 'e.import("./gone-legacy-GONE.js")')
  return dir
}
{
  const good = analyzeLazyImports(fakeDist())
  assert.deepEqual(good.problems, [])
  assert.deepEqual(good.targets.map((t) => [t.target, t.fanout]), [['Page-P.js', 2]])
  assert.match(analyzeLazyImports(fakeDist({ helper: false })).problems.join(), /找不到抗失败的预加载助手/)
  assert.match(analyzeLazyImports(fakeDist({ missing: ['dep-D.js'] })).problems.join(), /Page-P\.js 的静态依赖 dep-D\.js 缺失/)
  assert.match(analyzeLazyImports(fakeDist({ dynamicTarget: 'Gone-G.js' })).problems.join(), /懒加载目标 Gone-G\.js 不在磁盘上/)
  assert.match(analyzeLazyImports(fakeDist({ missing: ['Page-legacy-Q.js'] })).problems.join(), /legacy 懒加载目标 Page-legacy-Q\.js 不在磁盘上/)
  assert.match(analyzeLazyImports(fakeDist({ missing: ['shared-legacy-S.js'] })).problems.join(), /legacy 文件 shared-legacy-S\.js 不在磁盘上（index-legacy-L\.js 引用）/)
  assert.equal(good.legacyTargets, 1, '从 legacy 入口走到了懒加载目标')
  assert.ok(!good.problems.some((p) => /gone/.test(p)), '旧哈希文件引用的东西不报')
  assert.match(analyzeLazyImports(fakeDist({ extraDeps: MAX_LAZY_FANOUT })).problems.join(), /超过预算 40/)
  assert.match(analyzeLazyImports(fakeDist({ entryBytes: MAX_ENTRY_CLOSURE_BYTES + 1 })).problems.join(), /首屏静态依赖闭包.*超过预算/)
}

console.log('✔ 懒加载导入：Chromium JS 暖缓存与 CSS stylesheet 有界重试、失败清理和去重，非 Chromium / legacy 原样交回 Vite；构建检查拦缺失 / 助手丢失 / 扇出与首屏超标')
