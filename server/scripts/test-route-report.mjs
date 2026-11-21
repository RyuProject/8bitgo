/**
 * 优选线路的真实用户回报（server/src/route-report.js）：
 *   cd server && npm run test:route-report
 *
 * 锁住：只收白名单域名与大陆访客、一人一票、窗口与 since 过滤、内部汇总只给本机直连（经 nginx 进来的一律 404）。
 * 不联网、不用数据库。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createRouteReportRouter, createRouteReportStore, parseRouteReport, trustedLocalRequest } from '../src/route-report.js'
import { resetBuckets } from '../src/rateLimit.js'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    failed++
    console.log('  ✗ ' + name)
    console.error(e)
  }
}

await check('解析：只留白名单域名、截断计数、坏包返回 null', () => {
  const r = parseRouteReport('{"r":[{"h":"ROM.8bitgo.com","ok":3,"fail":999},{"h":"evil.example","ok":1},{"h":"download.8bitgo.com","ok":0,"fail":0}]}')
  assert.deepEqual([...r], [['rom.8bitgo.com', { ok: 3, fail: 50 }]])
  assert.equal(parseRouteReport('not json'), null)
  assert.equal(parseRouteReport({ r: [{ h: 'evil.example', ok: 1 }] }), null)
  assert.equal(parseRouteReport('x'.repeat(5000)), null)
})

await check('汇总：一人一票，只失败的访客单独计数', () => {
  const store = createRouteReportStore()
  const t = 1_000_000
  store.record('rom.8bitgo.com', 'a', { ok: 0, fail: 5 }, t)
  store.record('rom.8bitgo.com', 'a', { ok: 0, fail: 5 }, t + 1)
  store.record('rom.8bitgo.com', 'b', { ok: 1, fail: 3 }, t)
  store.record('rom.8bitgo.com', 'c', { ok: 2, fail: 0 }, t)
  const s = store.summary(0, t + 10).hosts['rom.8bitgo.com']
  assert.deepEqual(s, { visitors: 3, okVisitors: 2, failOnlyVisitors: 1, okEvents: 3, failEvents: 13 })
})

await check('汇总：since 之前与窗口外的回报不算', () => {
  const store = createRouteReportStore({ windowMs: 1000 })
  store.record('rom.8bitgo.com', 'old', { ok: 0, fail: 1 }, 0)
  store.record('rom.8bitgo.com', 'mid', { ok: 0, fail: 1 }, 1500)
  store.record('rom.8bitgo.com', 'new', { ok: 1, fail: 0 }, 1900)
  assert.equal(store.summary(0, 2000).hosts['rom.8bitgo.com'].visitors, 2, '窗口外的被清掉')
  assert.equal(store.summary(1800, 2000).hosts['rom.8bitgo.com'].visitors, 1, 'since 之后才算')
})

await check('访客上限：满了丢最久没动静的', () => {
  const store = createRouteReportStore({ maxVisitors: 2 })
  store.record('rom.8bitgo.com', 'a', { ok: 1, fail: 0 }, 1)
  store.record('rom.8bitgo.com', 'b', { ok: 1, fail: 0 }, 2)
  store.record('rom.8bitgo.com', 'a', { ok: 1, fail: 0 }, 3)
  store.record('rom.8bitgo.com', 'c', { ok: 1, fail: 0 }, 4)
  assert.equal(store.summary(0, 5).hosts['rom.8bitgo.com'].visitors, 2)
  assert.equal(store.summary(0, 5).hosts['rom.8bitgo.com'].okEvents, 3, 'b 被丢掉，a 的两条 + c')
})

await check('本机判定：带任何反代头都不算', () => {
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers })
  assert.equal(trustedLocalRequest(req('127.0.0.1')), true)
  assert.equal(trustedLocalRequest(req('::ffff:127.0.0.1')), true)
  assert.equal(trustedLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false, '经 nginx 进来的')
  assert.equal(trustedLocalRequest(req('10.0.0.5')), false)
})

await check('HTTP：大陆访客计入、海外丢弃、内部接口只给本机', async () => {
  resetBuckets()
  const store = createRouteReportStore()
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/api', createRouteReportRouter({ store, hosts: ['rom.8bitgo.com'], countryOf: (req) => req.headers['x-test-country'] }))
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const post = (country, ip, body) => fetch(`${base}/api/route-health`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-test-country': country, 'x-forwarded-for': ip },
      body,
    })
    const body = JSON.stringify({ r: [{ h: 'rom.8bitgo.com', ok: 0, fail: 2 }] })
    assert.equal((await post('CN', '1.1.1.1', body)).status, 204)
    assert.equal((await post('CN', '1.1.1.2', JSON.stringify({ r: [{ h: 'rom.8bitgo.com', ok: 1 }] }))).status, 204)
    assert.equal((await post('US', '1.1.1.3', body)).status, 204)
    assert.equal((await post('CN', '1.1.1.4', 'garbage')).status, 400)

    const viaProxy = await fetch(`${base}/api/internal/route-health`, { headers: { 'x-forwarded-for': '9.9.9.9' } })
    assert.equal(viaProxy.status, 404, '经反代来的读不到')
    const direct = await (await fetch(`${base}/api/internal/route-health`)).json()
    assert.deepEqual(direct.hosts['rom.8bitgo.com'], { visitors: 2, okVisitors: 1, failOnlyVisitors: 1, okEvents: 1, failEvents: 2 })
  } finally {
    server.close()
  }
})

if (failed) {
  console.error(`\n❌ ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✅ route-report：全部通过')
