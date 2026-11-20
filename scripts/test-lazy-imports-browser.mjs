#!/usr/bin/env node
/**
 * 懒加载导入的真浏览器验收（需要 Playwright 与一份构建产物；不在 `npm test` 里，见 scripts/run-tests.mjs 的 MANUAL）。
 *
 *   npm run build:client
 *   npm run test:lazy-imports-browser                       # 默认读 dist/client
 *   npm run test:lazy-imports-browser -- --dist <目录>
 *   PLAYWRIGHT_MODULE=<装了 playwright 的 node_modules 目录> WEBKIT_EXECUTABLE=<pw_run.sh> …  # 本机没装在仓库里时
 *
 * 用一个只给 /api/games/<slug>/startup 打桩的静态服务器打开 /games/test-game，用 Playwright 的 route.abort 让详情页 chunk 的
 * 一个静态依赖（首屏之外的第一个，通常是 AgeGate-*.js）失败，核对 2026-11-19 的设计在两家引擎上成立：
 *
 *   Chromium（预加载助手先暖缓存、失败重试）            WebKit（保持 Vite 原来的 modulepreload）
 *   不出错：每个懒加载依赖只下一次                       不出错：每个懒加载依赖只下一次
 *   失败一 / 两次：页面里就好了，不刷新、不上报          失败一次：自动刷新一次后好了，补报一份 recovered
 *   一直失败：刷新一次后停在兜底页，只报一份 failed_again  一直失败：同左
 *
 * ⚠️ Playwright 一开 route 就关掉 HTTP 缓存，所以「只下一次」只在不拦截的那一轮量；拦截那几轮的服务器请求数不可比。
 * ⚠️ 打开 /games/test-game 时页面自己会跳语言 / 选线路（Chromium 两次、WebKit 一次导航），与本测试无关；
 *    「自动刷新」按兜底页写的 sessionStorage 标记判断，不按导航次数。
 */
import assert from 'node:assert/strict'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--dist')
const dist = flag > 0 ? path.resolve(process.argv[flag + 1]) : path.join(root, 'dist', 'client')
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`✗ 没有构建产物：${dist}（先 npm run build:client，或传 --dist）`)
  process.exit(2)
}

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    if (!process.env.PLAYWRIGHT_MODULE) return null
    return createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_MODULE), 'noop.js'))('playwright')
  }
}
const pw = await loadPlaywright()
if (!pw) {
  console.error('✗ 找不到 playwright：装到仓库里，或用 PLAYWRIGHT_MODULE 指向装了它的 node_modules')
  process.exit(2)
}

/* ---------- 构建里的懒加载依赖 ---------- */
const assets = path.join(dist, 'assets')
const manifest = JSON.parse(readFileSync(path.join(assets, readdirSync(assets).find((n) => /^integrity-.+\.json$/.test(n))), 'utf8'))
const entry = /src="\/assets\/(index-[\w-]+\.js)"/.exec(readFileSync(path.join(dist, 'index.html'), 'utf8'))[1]
const closure = (name, seen = new Set()) => {
  if (seen.has(name)) return seen
  seen.add(name)
  for (const dep of manifest.imports?.[name] ?? []) closure(dep, seen)
  return seen
}
const entryClosure = closure(entry)
const page = Object.keys(manifest.files).find((n) => n.startsWith('GameDetailPage-'))
const lazyDeps = [...closure(page)].filter((n) => !entryClosure.has(n))
const victim = lazyDeps.find((n) => n !== page)
assert.ok(victim, '详情页 chunk 至少有一个首屏之外的静态依赖')

/* ---------- 静态服务器 ---------- */
const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' }
let hits = {}
let posts = []
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local')
  const p = decodeURIComponent(url.pathname)
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try { posts.push({ path: p, body: JSON.parse(body) }) } catch { posts.push({ path: p, body }) }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }
  hits[p] = (hits[p] ?? 0) + 1
  if (p.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  const file = path.join(dist, p)
  if (p !== '/' && file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, {
      'content-type': types[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    createReadStream(file).pipe(res)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  createReadStream(path.join(dist, 'index.html')).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function scenario(engine, mode) {
  hits = {}
  posts = []
  const browser = await pw[engine].launch(engine === 'webkit' && process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {})
  try {
    const tab = await browser.newPage()
    if (mode !== 'none') {
      let aborted = 0
      await tab.route(mode === 'always' ? new RegExp(victim.replace(/\./g, '\\.')) : `**/assets/${victim}`, (route) => {
        if (mode === 'always' || aborted < (mode === 'twice' ? 2 : 1)) {
          aborted++
          return route.abort('failed')
        }
        return route.continue()
      })
    }
    await tab.goto(`${base}/games/test-game`)
    const deadline = Date.now() + (mode === 'always' ? 45_000 : 20_000)
    let settledAt = 0
    while (Date.now() < deadline) {
      await tab.waitForTimeout(250)
      if (posts.some((p) => p.path.endsWith('/startup'))) break
      if (!settledAt && (hits[`/assets/${page}`] ?? 0) > 0) settledAt = Date.now()
      if (mode !== 'always' && settledAt && Date.now() - settledAt > 5000) break
    }
    await tab.waitForTimeout(500)
    const state = await tab.evaluate(() => ({
      errorPage: /did not open correctly|没有正常打开/.test(document.body.innerText),
      reloaded: Object.keys(sessionStorage).some((k) => k.startsWith('8bitgo.chunk-reload:')),
    }))
    return {
      ...state,
      reports: posts.filter((p) => p.path.endsWith('/startup')).map((p) => ({ event: p.body.event, outcome: p.body.diagnostics?.recovery?.outcome ?? null })),
      lazyHits: Object.fromEntries(lazyDeps.map((n) => [n, hits[`/assets/${n}`] ?? 0])),
    }
  } finally {
    await browser.close()
  }
}

const results = []
function check(label, actual, expected) {
  results.push(label)
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${label}：${key}`)
}

for (const engine of ['chromium', 'webkit']) {
  const none = await scenario(engine, 'none')
  check(`${engine} 不出错`, none, { errorPage: false, reloaded: false, reports: [] })
  assert.deepEqual(Object.entries(none.lazyHits).filter(([, n]) => n !== 1), [], `${engine}：每个懒加载依赖只下一次`)
  if (engine === 'chromium') {
    check('chromium 依赖失败一次（页面里重试好）', await scenario(engine, 'once'), { errorPage: false, reloaded: false, reports: [] })
    check('chromium 依赖失败两次（整套再暖一遍）', await scenario(engine, 'twice'), { errorPage: false, reloaded: false, reports: [] })
  } else {
    check('webkit 依赖失败一次（刷新一次后好了）', await scenario(engine, 'once'), { errorPage: false, reloaded: true, reports: [{ event: 'recovered', outcome: 'recovered' }] })
  }
  check(`${engine} 依赖一直失败`, await scenario(engine, 'always'), { errorPage: true, reloaded: true, reports: [{ event: 'failed', outcome: 'failed_again' }] })
}
server.close()
console.log(`✔ 懒加载导入真浏览器验收（${victim} 作故障点）：${results.join('；')}`)
