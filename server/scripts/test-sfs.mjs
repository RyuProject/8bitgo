import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import express from 'express'
import { WebSocket } from 'ws'
import { createSfsService, readSfsConfig } from '../src/sfs.js'

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address()))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

const receiveOne = (ws) => new Promise((resolve, reject) => {
  ws.once('message', (data) => resolve(Buffer.from(data)))
  ws.once('error', reject)
})

const openWs = (url, origin) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { origin })
  ws.once('open', () => resolve(ws))
  ws.once('error', reject)
})

const waitClosed = (ws, timeoutMs = 3500) => new Promise((resolve, reject) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve()
  const timer = setTimeout(() => reject(new Error('等待幽灵连接被心跳清理超时')), timeoutMs)
  timer.unref()
  ws.once('close', () => {
    clearTimeout(timer)
    resolve()
  })
})

const rejectedStatus = (url, origin) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { origin })
  ws.once('unexpected-response', (_request, response) => {
    response.resume()
    resolve(response.statusCode)
  })
  ws.once('error', () => {})
  setTimeout(() => reject(new Error('等待拒绝响应超时')), 1500).unref()
})

const upstream = createTcpServer((socket) => {
  socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from([0x45]), data])))
})
const upstreamAddress = await listen(upstream)

const app = express()
app.get('/main-project-still-works', (_req, res) => res.json({ ok: true }))
const silent = { log() {}, warn() {} }
const service = createSfsService({
  logger: silent,
  env: {
    SFS_ENABLED: '1',
    SFS_TCP_HOST: '127.0.0.1',
    SFS_TCP_PORT: String(upstreamAddress.port),
    SFS_MAX_PER_IP: '2',
    SFS_CONNECT_TIMEOUT_MS: '500',
    SFS_HEARTBEAT_INTERVAL_MS: '1000',
  },
})
const disabled = createSfsService({ logger: silent, env: { SFS_ENABLED: '0', SFS_WS_PATH: '/sfs/disabled' } })
app.use('/api/sfs', service.router)
app.use('/api/sfs-disabled', disabled.router)

const http = createHttpServer(app)
service.attach(http)
disabled.attach(http)
const address = await listen(http)
const origin = `http://127.0.0.1:${address.port}`

try {
  const parsed = readSfsConfig({
    SFS_ENABLED: 'yes',
    SFS_MAX_FRAME_BYTES: '999999999',
    SFS_WS_PATH: 'not-a-path',
  })
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.maxFrameBytes, 1024 * 1024, '帧上限必须钳住')
  assert.equal(parsed.heartbeatIntervalMs, 30_000)
  assert.equal(parsed.wsPath, '/sfs/sas3', '非法路径应回到安全默认值')

  const main = await fetch(`${origin}/main-project-still-works`).then((res) => res.json())
  assert.deepEqual(main, { ok: true }, '挂桥不能抢走普通 HTTP 路由')

  const configResponse = await fetch(`${origin}/api/sfs/config`)
  assert.match(configResponse.headers.get('cache-control') || '', /no-store/, '运行时开关不能被浏览器或 CDN 缓存')
  assert.equal(configResponse.headers.get('cdn-cache-control'), 'no-store')
  const config = await configResponse.json()
  assert.equal(config.enabled, true)
  assert.equal(config.ruffle.socketProxy[0].host, 'sas3server.ninjakiwi.com')
  assert.equal(config.ruffle.socketProxy[0].port, 444)
  assert.equal(config.ruffle.socketProxy[0].proxyUrl, `${origin.replace('http:', 'ws:')}/sfs/sas3`)

  const cloudflareConfig = await fetch(`${origin}/api/sfs/config`, {
    headers: { 'CF-Visitor': '{"scheme":"https"}' },
  }).then((res) => res.json())
  assert.equal(
    cloudflareConfig.ruffle.socketProxy[0].proxyUrl,
    `${origin.replace('http:', 'wss:')}/sfs/sas3`,
    'Cloudflare 回源走 HTTP 时仍必须给玩家下发 wss://',
  )

  const off = await fetch(`${origin}/api/sfs-disabled/config`).then((res) => res.json())
  assert.equal(off.enabled, false)
  assert.deepEqual(off.ruffle, {}, '默认关闭时不能向 Ruffle 注入代理')
  assert.equal(
    await rejectedStatus(`${origin.replace('http:', 'ws:')}/sfs/disabled`, origin),
    503,
    '关闭状态应明确拒绝 WebSocket，不能悬挂连接或影响主路由',
  )

  const statusResponse = await fetch(`${origin}/api/sfs/status`)
  assert.match(statusResponse.headers.get('cache-control') || '', /no-store/, '探活结果不能被缓存成旧状态')
  const statusBefore = await statusResponse.json()
  assert.equal(statusBefore.ready, true, '状态接口应真实探测 Java TCP 上游')

  const wsUrl = `${origin.replace('http:', 'ws:')}/sfs/sas3`
  const ws = await openWs(wsUrl, origin)
  const reply = receiveOne(ws)
  ws.send(Buffer.from([0x00, 0xff, 0x53, 0x46, 0x53]))
  assert.deepEqual(await reply, Buffer.from([0x45, 0x00, 0xff, 0x53, 0x46, 0x53]), '桥必须逐字节透明')
  ws.close()
  await new Promise((resolve) => ws.once('close', resolve))

  assert.equal(await rejectedStatus(wsUrl, 'https://evil.invalid'), 403, '跨站网页不能借用 SFS 桥')

  const statusAfter = await fetch(`${origin}/api/sfs/status`).then((res) => res.json())
  assert.equal(statusAfter.connections.active, 0)
  assert.equal(statusAfter.connections.accepted, 1)
  assert.equal(statusAfter.connections.rejected, 1)
  assert.equal(statusAfter.traffic.fromClient, 5)
  assert.equal(statusAfter.traffic.fromUpstream, 6)

  // 模拟浏览器睡眠 / NAT 丢状态：握手还在，但故意不自动回 pong。两轮心跳内必须释放名额。
  const ghost = new WebSocket(wsUrl, { origin, autoPong: false })
  await new Promise((resolve, reject) => {
    ghost.once('open', resolve)
    ghost.once('error', reject)
  })
  await waitClosed(ghost)
  const afterHeartbeat = await fetch(`${origin}/api/sfs/status`).then((res) => res.json())
  assert.equal(afterHeartbeat.connections.active, 0, '幽灵连接不能占用名额直到 4 小时 TCP 超时')

  console.log('SFS 自测通过：配置、状态、同源限制、透明桥、心跳回收、主站隔离')
} finally {
  service.close()
  disabled.close()
  await close(http)
  await close(upstream)
}
