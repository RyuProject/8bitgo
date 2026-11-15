/**
 * index.html 最前面那段「不在明文 HTTP 上跑」的内联脚本（2026-11-15 Android 模拟器 Chrome 110：
 * HTTPS 连不上、退回 http://cn.8bitgo.com，页面崩到兜底页）。直接从 index.html 抽出原文在 vm 里跑。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
const guard = scripts.find((s) => s.includes('8bitgo.https-upgrade'))
assert.ok(guard, 'index.html 里要有 HTTPS 守卫')
assert.ok(html.indexOf('8bitgo.https-upgrade') < html.indexOf('<script src="/edge-route-v2.js">'), '必须排在所有脚本之前')
// 只用 ES5：旧浏览器也要能执行这句提示
assert.ok(!/=>|\blet\b|\bconst\b|`/.test(guard), 'HTTPS 守卫只能写 ES5')

function run(href, { store = new Map(), storageThrows = false, cookieJar = { value: '' }, now = 1_000_000, readyState = 'complete', lang = 'zh-Hans' } = {}) {
  const url = new URL(href)
  const replaced = []
  const inserted = []
  const body = { firstChild: null, insertBefore: (el) => inserted.push(el) }
  const sessionStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('denied'); return store.get(k) ?? null },
    setItem: (k, v) => { if (storageThrows) throw new Error('denied'); store.set(k, v) },
  }
  const document = {
    // 浏览器的 document.cookie：写一条进罐子，读回整罐；cookieJar 为 null 时模拟 Cookie 被禁（写了也读不回）
    get cookie() { return cookieJar ? cookieJar.value : '' },
    set cookie(v) { if (cookieJar) cookieJar.value = String(v).split(';')[0] },
    readyState, body,
    documentElement: { lang },
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, set textContent(v) { this.text = v }, get textContent() { return this.text } }),
    addEventListener: (_e, fn) => fn(),
  }
  const ctx = {
    window: { location: { protocol: url.protocol, hostname: url.hostname, host: url.host, pathname: url.pathname, search: url.search, hash: url.hash, replace: (u) => replaced.push(u) } },
    sessionStorage, document, navigator: { language: lang },
    Date: { now: () => now }, Number, String,
  }
  vm.runInNewContext(guard, ctx)
  return { replaced, inserted, store }
}

// 1. 第一次落在 HTTP：换成 HTTPS，保留路径、查询和锚点
{
  const r = run('http://cn.8bitgo.com/games/the-king-of-fighters-97?x=1#top')
  assert.deepEqual(r.replaced, ['https://cn.8bitgo.com/games/the-king-of-fighters-97?x=1#top'])
  assert.equal(r.inserted.length, 0)
}
// 2. 一分钟内又被退回 HTTP（HTTPS 真连不上）：不再跳，顶部说清楚
{
  const store = new Map([['8bitgo.https-upgrade', String(1_000_000 - 5_000)]])
  const r = run('http://cn.8bitgo.com/games/the-king-of-fighters-97', { store })
  assert.equal(r.replaced.length, 0, '不能来回跳')
  assert.equal(r.inserted.length, 1)
  assert.match(r.inserted[0].textContent, /日期和时间/)
  const en = run('http://8bitgo.com/en', { store, lang: 'en' })
  assert.match(en.inserted[0].textContent, /date and time/)
}
// 3. 过了一分钟再来：可以再试一次 HTTPS
{
  const store = new Map([['8bitgo.https-upgrade', String(1_000_000 - 120_000)]])
  assert.equal(run('http://8bitgo.com/', { store }).replaced.length, 1)
}
// 4. sessionStorage 不可用（安卓 WebView 默认不开 DOM 存储）：退到 Cookie 记号，照样升级一次，回来后不再跳
{
  const cookieJar = { value: '' }
  const first = run('http://8bitgo.com/games/x', { storageThrows: true, cookieJar })
  assert.equal(first.replaced.length, 1, 'sessionStorage 不能用时也要升级 HTTPS')
  assert.match(cookieJar.value, /8bitgo_https_try=1000000/)
  const back = run('http://8bitgo.com/games/x', { storageThrows: true, cookieJar, now: 1_000_000 + 5_000 })
  assert.equal(back.replaced.length, 0, '一分钟内又被退回：不能来回跳')
  assert.equal(back.inserted.length, 1)
}
// 4b. 存储和 Cookie 都不可用：没法防循环，不跳，只提示
{
  const r = run('http://8bitgo.com/', { storageThrows: true, cookieJar: null })
  assert.equal(r.replaced.length, 0)
  assert.equal(r.inserted.length, 1)
}
// 5. HTTPS、本机 / 局域网开发地址都不动
for (const href of ['https://8bitgo.com/', 'http://localhost:5173/', 'http://127.0.0.1:8788/games/x', 'http://192.168.1.5:5173/', 'http://172.20.0.3:5173/', 'http://app.localhost/', 'http://8bitgo.test/']) {
  const r = run(href)
  assert.equal(r.replaced.length + r.inserted.length, 0, href)
}

console.log('test:https-guard 通过')
