/**
 * 主站 / 亚洲 CDN 首次选路回归（public/edge-route-v5.js）。
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
const source = readFileSync(fileURLToPath(new URL('public/edge-route-v5.js', root)), 'utf8')
const HOST_MAIN = '8bitgo.com'
const HOST_ASIA = 'cn.8bitgo.com'

function makeStorage(values = {}) {
  const keys = Object.keys(values)
  return { getItem: (key) => (key in values ? values[key] : null), key: (i) => keys[i] ?? null, length: keys.length }
}

/** databases：undefined = 没有 indexedDB；'unsupported' = 没有 databases()；'reject' / 'hang' / 名字数组 */
function makeIndexedDb(databases) {
  if (databases === undefined) return undefined
  if (databases === 'unsupported') return {}
  return {
    databases() {
      if (databases === 'reject') return Promise.reject(new Error('broken'))
      if (databases === 'hang') return new Promise(() => {})
      return Promise.resolve(databases.map((name) => ({ name, version: 1 })))
    },
  }
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
  hint = null,
  site = null,
  databases,
  interact = false,
} = {}) {
  let redirected = null
  let pendingTimeouts = 0
  const requests = []
  const scheduled = []
  const timers = []
  const clock = { value: nowMs }
  const document = {
    cookie,
    documentElement: { getAttribute: (name) => (name === 'data-8bitgo-cdn' ? hint : name === 'data-8bitgo-site' ? site : null) },
  }
  const listeners = new Map()
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
    indexedDB: makeIndexedDb(databases),
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn))
    },
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
  if (interact) for (const fn of listeners.get('pointerdown') ?? []) fn()

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
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const listening = [...listeners.values()].reduce((sum, list) => sum + list.length, 0)
  return { redirected, requests, document, pendingTimeouts, probeTimeouts: timers.map((timer) => timer.delay), listening }
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

await check('两个节点都不返回时，探测按 180ms 上限收敛且释放计时器', async () => {
  const result = await run({ timings: { [HOST_MAIN]: 'hang', [HOST_ASIA]: 'hang' } })
  assert.equal(result.redirected, null)
  assert.equal(result.pendingTimeouts, 0)
  assert.deepEqual(result.probeTimeouts, [180, 180])
  assert.equal(result.document.cookie, `8bitgo.edge=${HOST_MAIN}:1000000; Domain=.8bitgo.com; Path=/; Max-Age=7200; SameSite=Lax; Secure`)
})

await check('从亚洲边缘首访：不测速、不跨域，也不写 cookie', async () => {
  const result = await run({ host: HOST_ASIA, timings: { [HOST_MAIN]: 'hang', [HOST_ASIA]: 'hang' } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
  assert.equal(result.document.cookie, '')
  assert.equal(result.pendingTimeouts, 0)
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

await check('从亚洲边缘访问时，主站探针更快也不切回（2026-11-20 大陆直连：探针 0.45 秒判主站赢，主站 HTML 却要 4～25 秒）', async () => {
  const result = await run({ host: HOST_ASIA, timings: { [HOST_MAIN]: 40, [HOST_ASIA]: 300 } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('亚洲边缘上记着「主站」的旧 cookie 也不理（v2 / v3 的测速记下的）', async () => {
  const result = await run({ host: HOST_ASIA, cookie: `8bitgo.edge=8bitgo.com:${1_000_000 - 60_000}`, timings: { [HOST_MAIN]: 40 } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('亚洲边缘上的语言跳转照常完成', async () => {
  const result = await run({ host: HOST_ASIA, path: '/games/x', target: '/ja/games/x' })
  assert.equal(result.redirected, '/ja/games/x')
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

console.log('\n三点五、经 EdgeOne 打开的主域（v5，NS 迁出 Cloudflare 后）')

await check('主域页面带 data-8bitgo-site=cn：已在亚洲边缘上，留下、不探测、不写 cookie', async () => {
  const result = await run({ site: 'cn', hint: 'cn', timings: { [HOST_MAIN]: 1000, [HOST_ASIA]: 60 } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
  assert.equal(result.document.cookie, '')
})

await check('带标记时旧 cookie 记着 cn 子域也不跳过去', async () => {
  const result = await run({ site: 'cn', cookie: `8bitgo.edge=${HOST_ASIA}:${1_000_000 - 60_000}` })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('带标记时语言跳转照常在当前域完成', async () => {
  const result = await run({ site: 'cn', path: '/games/x', target: '/zh-Hans/games/x' })
  assert.equal(result.redirected, '/zh-Hans/games/x')
})

await check('标记只认 cn：其它值按原逻辑处理', async () => {
  const result = await run({ site: 'main', hint: 'cn', timings: { [HOST_MAIN]: 1000, [HOST_ASIA]: 1600 } })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/games/test')
})

console.log('\n四、按 Cloudflare 的地域结论选路（v3 起）')
const ASIA_COOKIE = `8bitgo.edge=${HOST_ASIA}:1000000; Domain=.8bitgo.com; Path=/; Max-Age=7200; SameSite=Lax; Secure`
const SLOW = { [HOST_MAIN]: 1000, [HOST_ASIA]: 1600 } // 大陆直连实测量级：180ms 的测速永远超时

await check('主站判为大陆、没有本地痕迹：只验证亚洲边缘能连上就过去，不比快慢', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, path: '/zh-Hans/games/mario', search: '?from=share', hash: '#play' })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/zh-Hans/games/mario?from=share#play')
  assert.equal(result.requests.length, 1)
  assert.equal(result.requests[0].url, `https://${HOST_ASIA}/favicon.svg`)
  // 带凭据：整页跳转能复用这条已握手的连接
  assert.equal(result.requests[0].options.credentials, 'include')
  assert.equal(result.requests[0].options.cache, 'no-store')
  assert.deepEqual(result.probeTimeouts, [3000])
  assert.equal(result.document.cookie, ASIA_COOKIE)
  assert.equal(result.pendingTimeouts, 0)
  assert.equal(result.listening, 0, '交互监听要摘掉')
})

await check('语言跳转的目标照样带过去', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, path: '/games/x', target: '/zh-Hans/games/x' })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/zh-Hans/games/x')
})

await check('亚洲边缘连不上：留在主站，不记选择', async () => {
  const result = await run({ hint: 'cn', timings: { [HOST_ASIA]: null } })
  assert.equal(result.redirected, null)
  assert.equal(result.document.cookie, '')
})

await check('亚洲边缘 3 秒没回音：留在主站，计时器释放', async () => {
  const result = await run({ hint: 'cn', timings: { [HOST_ASIA]: 'hang' } })
  assert.equal(result.redirected, null)
  assert.equal(result.pendingTimeouts, 0)
})

await check('旧逻辑记下的「主站」选择不挡路（那是 180ms 测速全超时记下的）', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, cookie: `8bitgo.edge=8bitgo.com:${1_000_000 - 60_000}` })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/games/test')
})

for (const [label, local] of [
  ['最近玩过列表', { '8bitgo.recents': '["contra"]' }],
  ['EmulatorJS 游戏设置', { 'ejs-123-nes-contra-settings': '{}' }],
  ['电池存档同步记录', { '8bitgo.battery-sync.v1:contra': '{}' }],
  ['Ruffle 存档', { '8bitgo.com/flash-frames/fireboy/fireboy.swf/save': 'x' }],
  ['存档位置偏好', { '8bitgo.save.target': 'local' }],
]) {
  await check(`主站上有${label}：留下，不探测`, async () => {
    const result = await run({ hint: 'cn', timings: SLOW, local })
    assert.equal(result.redirected, null)
    assert.equal(result.requests.length, 0)
  })
}

await check('空的最近玩过列表不算痕迹', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, local: { '8bitgo.recents': '[]', '8bitgo.lang': 'zh-Hans' } })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/games/test')
})

await check('主站上有本地存档库（IndexedDB 8bitgo / /data/saves）：留下', async () => {
  for (const name of ['8bitgo', '/data/saves']) {
    const result = await run({ hint: 'cn', timings: SLOW, databases: [name] })
    assert.equal(result.redirected, null, name)
  }
})

await check('只有缓存库（EmulatorJS-Cache / ROM 缓存）：照样过去', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, databases: ['EmulatorJS-Cache', '8bitgo-roms', '8bitgo-rom-downloads'] })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/games/test')
})

await check('查不了库（报错 / 卡住）：按有存档处理，留下', async () => {
  for (const databases of ['reject', 'hang']) {
    const result = await run({ hint: 'cn', timings: SLOW, databases })
    assert.equal(result.redirected, null, databases)
    assert.equal(result.pendingTimeouts, 0, databases)
  }
})

await check('浏览器没有 databases()：只看 localStorage 痕迹', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, databases: 'unsupported' })
  assert.equal(result.redirected, 'https://cn.8bitgo.com/games/test')
})

await check('等结论期间用户已经点过：不整页跳走打断他', async () => {
  const result = await run({ hint: 'cn', timings: SLOW, interact: true })
  assert.equal(result.redirected, null)
  assert.equal(result.listening, 0)
})

await check('已登录、登录页、爬虫：都不探测、不跨域', async () => {
  for (const extra of [{ local: { '8bitgo.token': 'jwt' } }, { path: '/login' }, { ua: 'Mozilla/5.0 (compatible; Baiduspider/2.0)' }]) {
    const result = await run({ hint: 'cn', timings: SLOW, ...extra })
    assert.equal(result.redirected, null, JSON.stringify(extra))
    assert.equal(result.requests.length, 0, JSON.stringify(extra))
  }
})

await check('EdgeOne 取不下资源后改从主站载入（__assets=origin）：留下并钉住主站两小时', async () => {
  const fallback = await run({ hint: 'cn', timings: SLOW, search: '?__assets=origin' })
  assert.equal(fallback.redirected, null)
  assert.equal(fallback.requests.length, 0)
  assert.match(fallback.document.cookie, /^8bitgo\.edge\.pin=8bitgo\.com:1000000;/)
  const next = await run({ hint: 'cn', timings: SLOW, cookie: `8bitgo.edge.pin=8bitgo.com:${1_000_000 - 60_000}` })
  assert.equal(next.redirected, null)
  assert.equal(next.requests.length, 0)
  const expired = await run({ hint: 'cn', timings: SLOW, cookie: `8bitgo.edge.pin=8bitgo.com:${1_000_000 - 3 * 60 * 60_000}` })
  assert.equal(expired.redirected, 'https://cn.8bitgo.com/games/test')
})

await check('主站判为海外：不测速、不跨域，省掉一条到香港的冷连接', async () => {
  const result = await run({ hint: 'main', timings: { [HOST_MAIN]: 300, [HOST_ASIA]: 50 } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('海外访客的语言跳转照常完成', async () => {
  const result = await run({ hint: 'main', path: '/games/x', target: '/ja/games/x' })
  assert.equal(result.redirected, '/ja/games/x')
})

await check('大陆入口上的 cn 不是地域结论，也不测速：留在 cn', async () => {
  const result = await run({ host: HOST_ASIA, hint: 'cn', timings: { [HOST_MAIN]: 40, [HOST_ASIA]: 300 } })
  assert.equal(result.redirected, null)
  assert.equal(result.requests.length, 0)
})

await check('主站送过来的大陆访客到了 cn 不会被送回（不再三次加载）', async () => {
  const onMain = await run({ hint: 'cn', timings: SLOW })
  assert.equal(onMain.redirected, 'https://cn.8bitgo.com/games/test')
  const onAsia = await run({ host: HOST_ASIA, hint: 'cn', cookie: onMain.document.cookie.split(';')[0], timings: { [HOST_MAIN]: 40, [HOST_ASIA]: 300 } })
  assert.equal(onAsia.redirected, null)
})

if (failed) process.exitCode = 1
