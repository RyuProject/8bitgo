#!/usr/bin/env node

/*
  用本机合法资源跑真实 WASM 的端到端冒烟；资源只通过 Playwright 路由喂给浏览器，不复制进仓库。
*/
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { chromium } from 'playwright'

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const mainPak = resolve(arg('main') || '.')
const pack = resolve(arg('pack') || '.')
const root = resolve(process.argv.includes('--dist') ? 'dist/client' : 'public')
const screenshot = resolve(arg('screenshot') || '/tmp/pvz-real-smoke.png')
if (!arg('main') || !arg('pack') || !existsSync(mainPak) || !existsSync(pack)) {
  console.error('用法：node scripts/test-pvz-real.mjs --main <main.pak> --pack <pvzpack.gz> [--dist]')
  process.exit(2)
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm' }
const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url, 'http://127.0.0.1').pathname
    if (pathname === '/web/PvZ/cn' || pathname === '/web/PvZ/cn/') pathname = '/web/PvZ/cn/index.html'
    const file = resolve(root, '.' + pathname)
    if (!file.startsWith(root)) throw new Error('bad path')
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
await page.route('https://html5.8bitgo.com/**', async (route) => {
  const pathname = new URL(route.request().url()).pathname
  let file
  if (pathname.endsWith('/main.pak')) file = mainPak
  else if (pathname.includes('/packs/')) file = pack
  else if (pathname.includes('/properties/')) file = resolve('public/web/PvZ/properties', pathname.split('/').pop())
  if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: 'missing' })
  const info = await stat(file)
  return route.fulfill({
    status: 200,
    path: file,
    headers: {
      'access-control-allow-origin': '*',
      'content-length': String(info.size),
      'content-type': pathname.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
    },
  })
})

try {
  await page.goto(origin + '/web/PvZ/cn', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => document.body.classList.contains('game-mode'), null, { timeout: 180000 })
  await page.waitForTimeout(8000)
  const state = await page.evaluate(() => ({
    gameStarted,
    startTs: window.__pvzStartTs || 0,
    status: document.getElementById('loading-drop-zone').textContent,
    error: document.getElementById('loading-drop-zone').classList.contains('has-error'),
    canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height],
  }))
  if (!state.gameStarted || !state.startTs || state.error || pageErrors.length) {
    throw new Error(`真实 WASM 未稳定启动：${JSON.stringify({ state, pageErrors })}`)
  }
  await page.locator('#canvas').screenshot({ path: screenshot })
  console.log(`PvZ 真实资源冒烟通过：canvas ${state.canvas.join('×')}，截图 ${screenshot}`)
} finally {
  await context.close()
  await browser.close()
  await new Promise((close) => server.close(close))
}
