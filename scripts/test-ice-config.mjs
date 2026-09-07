/**
 * `fetchIceConfig()` 的回归测试 —— 钉住三条只在**线上**才发作的行为。
 *
 * 1. **拿到过期的凭证不能报 hasTurn:true。**
 *    2026-09-07 线上实测：`/api/netplay/ice` 被前面那层缓存了 13.7 小时（源站发的是
 *    `Cache-Control: no-store`，Cloudflare 的 "Cache Everything" 规则把它盖掉了），
 *    于是发给所有人的 TURN 凭证是十几个小时前签的。自建 coturn 走 use-auth-secret，
 *    username 就是 `<过期时间戳>:label`，过期即 401 —— 那一路对所有人都废了，
 *    而 hasTurn 一路如实报 true，观众端于是把「没有中继」的锅甩给了用户自己的网络。
 *
 * 2. **接口挂一次不能把「这个站没有 TURN」缓存到页面死亡。**
 *    失败那一路以前写 `expiry: 0`，而 0 的语义是「永不过期」—— 网关一次 502 抖动之后，
 *    这个页面**直到刷新为止**建的每条 PeerConnection 都没有 TURN。
 *
 * 3. **请求要带分钟桶参数**，否则又会被缓存住（带 query 就是另一个 cache key，必然回源）。
 *
 * ⚠️ 全程只有**一个**模块实例：`iceCached` 是模块级状态，而 `import('...?fresh=1')`
 * 拿不到新实例（ESM 按解析后的 URL 缓存，loader 会把 query 归一化掉）。
 * 所以下面是按状态顺序推进的一条线，每一步都靠「该续期了 / 过了 retryAt」逼它真的回源。
 *
 * 跑：npm run test:ice-config
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

let n = 0
const ok = (cond, msg) => {
  n++
  assert.ok(cond, msg)
  console.log('✅ ' + msg)
}

/* ---------------- 打桩 ---------------- */

globalThis.__viteEnv = { VITE_NETPLAY_URL: 'https://8bitgo.com/netplay' }

/** 可控的时钟：fetchIceConfig 通篇用 Date.now() 判过期 */
let clock = Date.UTC(2026, 8, 7, 6, 0, 0)
const realNow = Date.now
Date.now = () => clock
const advance = (sec) => (clock += sec * 1000)
const nowSec = () => Math.floor(clock / 1000)

/** 假 fetch：记下每次请求的 URL，按 nextResponse 给响应（数字 = HTTP 错误码） */
const calls = []
let nextResponse = null
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const r = nextResponse
  if (typeof r === 'number') return { ok: false, status: r, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => r }
}

const warnings = []
const realWarn = console.warn
console.warn = (...a) => warnings.push(a.join(' '))

const { fetchIceConfig } = await import(fileURLToPath(new URL('../src/services/netplay.ts', import.meta.url)))

const stun = { urls: 'stun:stun.example:3478' }
/** 自建 coturn 那种凭证：username 就是 `<过期时间戳>:label`，过期即 401 */
const turn = (expiry) => ({ urls: 'turn:turn.8bitgo.com:3478', username: `${expiry}:guest`, credential: 'x' })
const fresh = () => {
  const e = nowSec() + 3600
  return { iceServers: [stun, turn(e)], hasTurn: true, turnSources: ['self-hosted'], expiry: e }
}
/** 推进到「距过期只剩 200 秒」——提前 5 分钟续期的闸会开 */
const nearExpiry = () => advance(3600 - 200)

/* ---------------- 1. 正常一份 ---------------- */
console.log('── 正常响应 ──')
{
  nextResponse = fresh()
  const cfg = await fetchIceConfig()
  ok(cfg.hasTurn === true && cfg.expiry === nowSec() + 3600, '新鲜的凭证：hasTurn 照实报 true')
  ok(calls.length === 1, '发了一次请求')
  const bucket = Math.floor(clock / 60_000)
  ok(calls[0].includes(`?t=${bucket}`), `⭐ 请求带分钟桶参数（绕开 CDN 缓存）：?t=${bucket}`)
  ok(calls[0].startsWith('https://8bitgo.com/api/netplay/ice'), '打的是 /api/netplay/ice（URL 尾巴上的 /netplay 被换掉）')
}

/* ---------------- 2. 有效期内走内存 ---------------- */
console.log('\n── 有效期内不重复回源 ──')
{
  await fetchIceConfig()
  advance(600)
  await fetchIceConfig()
  ok(calls.length === 1, '10 分钟内不再回源')
}

/* ---------------- 3. ⭐ 服务端发来 13 小时前签的凭证（被 CDN 缓存住的那种） ---------------- */
console.log('\n── 拿到过期的凭证 ──')
{
  advance(3600 - 600 - 200) // 距过期剩 200 秒，该续了
  const staleExp = nowSec() - 13 * 3600
  nextResponse = { iceServers: [stun, turn(staleExp)], hasTurn: true, turnSources: ['self-hosted', 'cloudflare'], expiry: staleExp }
  const cfg = await fetchIceConfig()
  ok(calls.length === 2, '快过期了，确实回源了')
  ok(cfg.hasTurn === false, '⭐ 凭证已经过期 → hasTurn 拉回 false，不再骗观众端「有中继」')
  ok(cfg.iceServers.length === 2, 'iceServers 原样留着 —— STUN 那几条不带凭证、永远有效，多数人还能直连')
  ok(cfg.expiry === 0, 'expiry 归 0：别让「过期时间在过去」把续期判断变成每次调用都回源')
  ok(typeof cfg.retryAt === 'number' && cfg.retryAt > nowSec(), '挂上 retryAt，缓存刷新之后能自愈')
  ok(warnings.some((w) => w.includes('CDN') && w.includes('过期')), '控制台留一行指得出原因的警告（下次省三小时）')

  await fetchIceConfig()
  ok(calls.length === 2, 'retryAt 之前不反复回源')
}

/* ---------------- 4. ⭐ 接口 502：退路不能被记一辈子 ---------------- */
console.log('\n── 接口 502（网关抖动）──')
{
  advance(61) // 过了 retryAt
  nextResponse = 502
  const bad = await fetchIceConfig()
  ok(calls.length === 3, '过了 retryAt 会再问一次')
  ok(bad.hasTurn === false && bad.iceServers.length > 0, '打不通就退回公共 STUN，功能不断')
  ok(typeof bad.retryAt === 'number', '⭐ 退路带 retryAt，而不是 expiry:0（那等于「永不过期」，一次 502 毁掉整个页面）')
  await fetchIceConfig()
  ok(calls.length === 3, 'retryAt 之前不狂打接口')
}

/* ---------------- 5. 后端好了要能自愈 ---------------- */
console.log('\n── 自愈 ──')
{
  advance(61)
  nextResponse = fresh()
  const healed = await fetchIceConfig()
  ok(calls.length === 4 && healed.hasTurn === true, '⭐ 60 秒后再问，后端 / 缓存好了就恢复 TURN')
  const bucket = Math.floor(clock / 60_000)
  ok(calls[3].includes(`?t=${bucket}`), '分钟桶跟着时间走，不会一直命中同一个缓存对象')
}

/* ---------------- 6. expiry:0 = 没有会过期的凭证（纯 STUN / 固定账号密码） ---------------- */
console.log('\n── expiry:0 的语义 ──')
{
  nearExpiry()
  warnings.length = 0
  nextResponse = { iceServers: [stun], hasTurn: false, expiry: 0 }
  await fetchIceConfig()
  ok(calls.length === 5, '（前置）该续期时回源')
  advance(86_400)
  await fetchIceConfig()
  ok(calls.length === 5, 'expiry:0 的语义是「永不过期」，隔一天也不重取')
  ok(warnings.length === 0, '没有把 expiry:0 误判成「凭证已过期」')
}

Date.now = realNow
console.warn = realWarn
console.log(`\n✅ ICE 配置测试通过（${n} 项）`)
process.exit(0)
