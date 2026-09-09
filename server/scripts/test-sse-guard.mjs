/**
 * SSE 准入闸的回归测试。跑：cd server && npm run test:sse-guard
 *
 * 盯的是 2026-09-09 那次事故的三条修法：爬虫不给开流、并发有上限、流不会永生。
 * 每一条都配了「反向用例」—— 只验证"挡住了"很容易写出一个把所有人都挡住的闸。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

process.env.SSE_MAX_PER_IP = '3'
process.env.SSE_MAX_TOTAL = '5'
process.env.SSE_MAX_LIFETIME_MS = '600000'

const { admitSse, isCrawlerUa, resetSseCounters, sseStats } = await import('../src/sseGuard.js')

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m))
}

/** 只实现 admitSse 用到的那几个方法的 req/res 替身 */
function fake(ua = 'Mozilla/5.0 (Macintosh) Chrome/140', ip = '203.0.113.5') {
  const req = { headers: { 'user-agent': ua, 'cf-connecting-ip': ip }, socket: { remoteAddress: ip } }
  const res = new EventEmitter()
  Object.assign(res, {
    code: 200,
    headers: {},
    ended: false,
    body: null,
    set(a, b) {
      if (typeof a === 'string') res.headers[a.toLowerCase()] = b
      else for (const [k, v] of Object.entries(a)) res.headers[k.toLowerCase()] = v
      return res
    },
    status(n) {
      res.code = n
      return res
    },
    json(o) {
      res.body = o
      return res.end()
    },
    // 真 Node 里响应结束会让请求侧发 close，替身也照做，否则名额永远还不回来
    end() {
      if (!res.ended) {
        res.ended = true
        res.emit('close')
      }
      return res
    },
    flushHeaders() {},
  })
  return { req, res }
}

console.log('── 爬虫 ──')
resetSseCounters()
for (const ua of [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15 Applebot/0.1',
  'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
  'curl/8.4.0',
]) {
  const { req, res } = fake(ua)
  const admitted = admitSse(req, res)
  ok(!admitted && res.code === 204, `拒掉 ${ua.slice(0, 42)}…（回 204）`)
}
ok(sseStats().total === 0, '被拒的爬虫一条名额都不占')

console.log('\n── 真人不能被误伤 ──')
resetSseCounters()
for (const ua of [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Mobile Safari/537.36',
]) {
  ok(!isCrawlerUa(ua), `不误判：${ua.slice(0, 46)}…`)
}
ok(!isCrawlerUa(''), 'UA 为空**不算**爬虫 —— 否则自家测试和健康检查会被一起挡掉')

console.log('\n── 响应头 ──')
resetSseCounters()
{
  const { req, res } = fake()
  ok(admitSse(req, res) === true, '正常浏览器放行')
  ok(res.headers['content-type'] === 'text/event-stream; charset=utf-8', 'Content-Type 是 event-stream')
  ok(res.headers['x-accel-buffering'] === 'no', '带 X-Accel-Buffering: no（少了 nginx 会把流缓冲住）')
  ok(/no-cache/.test(res.headers['cache-control'] || ''), 'Cache-Control 不缓存')
}

console.log('\n── per-IP 上限 ──')
resetSseCounters()
{
  const live = []
  for (let i = 0; i < 3; i++) {
    const { req, res } = fake('Chrome/140', '203.0.113.9')
    ok(admitSse(req, res) === true, `同一 IP 第 ${i + 1} 条放行`)
    live.push(res)
  }
  const { req, res } = fake('Chrome/140', '203.0.113.9')
  ok(admitSse(req, res) === false && res.code === 503, '同一 IP 第 4 条被拒（503）')
  ok(res.headers['retry-after'] === '30', '拒的时候给了 Retry-After')

  const other = fake('Chrome/140', '198.51.100.7')
  ok(admitSse(other.req, other.res) === true, '换个 IP 不受影响 —— 闸是按 IP 关的，不是全站关的')

  live[0].end()
  const again = fake('Chrome/140', '203.0.113.9')
  ok(admitSse(again.req, again.res) === true, '断开一条就还回一个名额')
}

console.log('\n── 反代没透传真实 IP 时不能把整站限死 ──')
resetSseCounters()
{
  // 直播的每 IP 房间数踩过同一个坑：XFF 没配好时全站访客都长成 127.0.0.1
  let all = true
  for (let i = 0; i < 5; i++) {
    const req = { headers: { 'user-agent': 'Chrome/140' }, socket: { remoteAddress: '127.0.0.1' } }
    const { res } = fake()
    if (admitSse(req, res) !== true) all = false
  }
  ok(all, '内网/回环地址不计 per-IP，超过 per-IP 上限照样放行')
}

console.log('\n── 总量上限（最后一道兜底）──')
resetSseCounters()
{
  for (let i = 0; i < 5; i++) {
    const { req, res } = fake('Chrome/140', `198.51.100.${i}`)
    admitSse(req, res)
  }
  const { req, res } = fake('Chrome/140', '198.51.100.200')
  ok(admitSse(req, res) === false && res.code === 503, '到总量上限后连新 IP 也拒')
  ok(sseStats().total === 5, 'sseStats 报的条数对得上')
}

console.log('\n── 最长存活时间 ──')
resetSseCounters()
{
  process.env.SSE_MAX_LIFETIME_MS = '60'
  // 查询串换一个 = 拿到一份全新的模块实例，好用不同的上限跑
  const short = await import('../src/sseGuard.js?lifetime=60')
  const { req, res } = fake()
  short.admitSse(req, res)
  ok(!res.ended, '刚开的流不会立刻被收掉')
  await new Promise((r) => setTimeout(r, 200))
  ok(res.ended, '到了最长存活时间就主动收（EventSource 会自己重连，玩家无感）')
  ok(short.sseStats().total === 0, '收掉之后名额也还回来了')
}

console.log('\n── 源码守卫：两条 SSE 都必须过这道闸 ──')
{
  // 先剥注释再断言 —— 否则会被上面那些解释病因的注释骗过去
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  for (const [file, route] of [
    ['../src/index.js', '/api/live/events'],
    ['../src/netplay.js', '/api/netplay/events'],
  ]) {
    const src = strip(readFileSync(new URL(file, import.meta.url), 'utf8'))
    const at = src.indexOf(route)
    assert.ok(at > 0, `${file} 里找不到 ${route}`)
    const body = src.slice(at, at + 400)
    ok(/admitSse\(req,\s*res\)/.test(body), `${route} 的 handler 开头就调了 admitSse`)
    ok(!/text\/event-stream/.test(body), `${route} 不再自己写响应头（统一由 admitSse 写）`)
  }
}

console.log(`\n${fail ? '❌' : '✅'} SSE 准入闸：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
