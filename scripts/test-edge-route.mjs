/**
 * 主站 / 亚洲 CDN 首次选路回归。
 *
 * 直接执行：node scripts/test-edge-route.mjs
 *
 * 不依赖浏览器：用极小的 window 替身覆盖 fetch、Cookie 和 Storage，验证真正发到
 * public/ 的启动脚本。重点不是某次毫秒数，而是不能因轻微抖动、超时或登录态把用户
 * 送到错误子域。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = new URL('..', import.meta.url)
const source = readFileSync(fileURLToPath(new URL('public/edge-route-v1.js', root)), 'utf8')
const HOST_MAIN = '8bitgo.com'
const HOST_ASIA = 'cn.8bitgo.com'

function makeStorage(values = {}) {
  return { getItem: (key) => (key in values ? values[key] : null) }
}

async function run({
  host = HOST_MAIN,
  path = '/games/test',
  search = '',
  hash = '',
  target = null,
  cookie = '',
  local = {},
  session = {},
  ua = 'Mozilla/5.0 Chrome/140 Safari/537.36',
  timings = { [HOST_MAIN]: 180, [HOST_ASIA]: 60 },
  nowMs = 1_000_000,
} = {}) {
  let redirected = null
  let pendingTimeouts = 0
  const requests = []
  const scheduled = []
  const timers = []
  const clock = { value: nowMs }
  const document = { cookie }
  const location = {
    protocol: 'https:',
    hostname: host,
    pathname: path,
    search,
    hash,
    replace(url) {
      redirected = url
    },
  }
  const window = {
    location,
    document,
    localStorage: makeStorage(local),
    sessionStorage: makeStorage(session),
    navigator: { userAgent: ua },
    performance: { now: () => clock.value },
    setTimeout(fn, delay) {
      pendingTimeouts++
      const timer = { fn, delay, active: true }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer?.active) {
        timer.active = false
        pendingTimeouts--
      }
    },
    fetch(url, options) {
      requests.push({ url, options })
      const requestedHost = new URL(url).hostname
      const delay = timings[requestedHost]
      return new Promise((resolve, reject) => scheduled.push({ delay, resolve, reject }))
    },
  }
  const FixedDate = class extends Date {
    static now() {
      return nowMs
    }
  }
  const context = createContext({ window, Promise, Date: FixedDate, Math, Number, String })
  runInContext(source, context)
  context.window.__8bitgoEdgeRoute(target ?? path + search + hash)

  // 两个探针现实中并行，按最短完成时间依次让回调观察到对应的 performance.now()。
  for (const item of scheduled.sort((a, b) => (a.delay ?? Infinity) - (b.delay ?? Infinity))) {
    if (item.delay === 'hang') continue
    if (item.delay == null) item.reject(new Error('network failed'))
    else {
      clock.value = nowMs + item.delay
      item.resolve({ type: 'opaque' })
    }
    await Promise.resolve()
  }
  for (const timer of timers) {
    if (!timer.active) continue
    clock.value = nowMs + timer.delay
    timer.active = false
    pendingTimeouts--
    timer.fn()
    await Promise.resolve()
  }
  await Promise.resolve()
  await Promise.resolve()
  return { redirected, requests, document, pendingTimeouts, probeTimeouts: timers.map((timer) => timer.delay) }
}

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error.message}`)
  }
}

console.log('一、测速与阈值')
await check('亚洲边缘明显更快时，保留完整路径、查询串和锚点', async () => {
  const result = await run({
    path: '/en/games/mario',
    search: '?from=share',
    hash: '#play',
    timings: { [HOST_MAIN]: 300, [HOST_ASIA]: 50 },
  })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/en/games/mario?from=share#play')
  assert.equal(result.requests.length, 2)
  assert.deepEqual(result.requests.map((request) => request.options.credentials), ['omit', 'omit'])
  assert.ok(result.requests.every((request) => request.url === `https://${new URL(request.url).hostname}/favicon.svg`))
  assert.ok(result.requests.every((request) => request.options.cache === 'no-store'))
})

await check('只有几十毫秒差异时留在主站，避免网络抖动来回切域', async () => {
  const result = await run({ timings: { [HOST_MAIN]: 200, [HOST_ASIA]: 150 } })
  assert.equal(result.redirected, null)
})

await check('亚洲边缘不可达时保持主站可用', async () => {
  const result = await run({ timings: { [HOST_MAIN]: 80, [HOST_ASIA]: null } })
  assert.equal(result.redirected, null)
})

await check('两个节点都不返回时，探测按 450ms 上限收敛且释放计时器', async () => {
  const result = await run({ timings: { [HOST_MAIN]: 'hang', [HOST_ASIA]: 'hang' } })
  assert.equal(result.redirected, null)
  assert.equal(result.pendingTimeouts, 0)
  assert.deepEqual(result.probeTimeouts, [450, 450])
  assert.equal(result.document.cookie, `8bitgo.edge=${HOST_MAIN}:1000000; Domain=.8bitgo.com; Path=/; Max-Age=7200; SameSite=Lax; Secure`)
})

console.log('\n二、跨域会话与缓存选择')
await check('已有登录态不测速、不跨域', async () => {
  const result = await run({ local: { '8bitgo.token': 'jwt' } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('登录页不测速、不跨域', async () => {
  const result = await run({ path: '/login', timings: { [HOST_MAIN]: 500, [HOST_ASIA]: 1 } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('记住的节点仍可用时，先验证再去亚洲边缘', async () => {
  const timestamp = 1_000_000 - 60 * 1000
  const result = await run({
    cookie: `8bitgo.edge=cn.8bitgo.com:${timestamp}`,
    target: '/ja/games/x?x=1#start',
    timings: { [HOST_ASIA]: 60 },
  })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/ja/games/x?x=1#start')
  assert.equal(result.requests.length, 1)
})

await check('记住的节点失联时留在已打开的站点并更新选择', async () => {
  const timestamp = 1_000_000 - 60 * 1000
  const result = await run({
    cookie: `8bitgo.edge=cn.8bitgo.com:${timestamp}`,
    timings: { [HOST_ASIA]: null },
  })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 1)
  assert.match(result.document.cookie, /8bitgo\.edge=8bitgo\.com:1000000/)
})

await check('同一节点的有效选择无需探测', async () => {
  const timestamp = 1_000_000 - 60 * 1000
  const result = await run({ cookie: `8bitgo.edge=8bitgo.com:${timestamp}` })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('从亚洲边缘访问时，主站明显更快也能切回', async () => {
  const result = await run({ host: HOST_ASIA, timings: { [HOST_MAIN]: 40, [HOST_ASIA]: 300 } })
  assert.equal(result.redirected, `https://${HOST_MAIN}/games/test`)
})

console.log('\n三、SEO 与错误保护')
await check('爬虫不测速、不跨域', async () => {
  const result = await run({ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +https://www.google.com/bot.html)' })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('错误 target 不能变成外站跳转', async () => {
  const result = await run({ target: '//evil.example/steal' })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/games/test')
})

if (failed) process.exitCode = 1
