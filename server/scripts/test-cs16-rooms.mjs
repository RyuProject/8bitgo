import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { createCs16RoomService, readCs16RoomConfig } from '../src/cs16-rooms.js'

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address()))
})
const close = (server) => new Promise((resolve) => server.close(resolve))

const nextJson = (ws, type) => new Promise((resolve, reject) => {
  const queuedIndex = ws.cs16Controls.findIndex((value) => value.type === type)
  if (queuedIndex >= 0) return resolve(ws.cs16Controls.splice(queuedIndex, 1)[0])
  const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), 1500)
  timer.unref()
  const onMessage = (data, isBinary) => {
    if (isBinary) return
    const value = JSON.parse(data.toString())
    if (value.type !== type) return
    clearTimeout(timer)
    ws.off('message', onMessage)
    resolve(value)
  }
  ws.on('message', onMessage)
})

const openWs = (url, origin = 'http://allowed.test', protocols = '') => new Promise((resolve, reject) => {
  const ws = protocols ? new WebSocket(url, protocols, { origin }) : new WebSocket(url, { origin })
  ws.cs16Controls = []
  // 服务端可能在 open 与调用方挂 message 监听之间立即发 ready，先排队避免测试自己制造竞态。
  ws.on('message', (data, isBinary) => {
    if (!isBinary) ws.cs16Controls.push(JSON.parse(data.toString()))
  })
  ws.once('open', () => resolve(ws))
  ws.once('error', reject)
})

const rejectedStatus = (url, origin = 'http://allowed.test', protocols = '') => new Promise((resolve, reject) => {
  const ws = protocols ? new WebSocket(url, protocols, { origin }) : new WebSocket(url, { origin })
  ws.once('unexpected-response', (_request, response) => {
    response.resume()
    resolve(response.statusCode)
  })
  ws.once('error', () => {})
  setTimeout(() => reject(new Error('等待 WebSocket 拒绝响应超时')), 1500).unref()
})

const config = readCs16RoomConfig({ CS16_ALLOWED_ORIGINS: 'http://allowed.test' })
assert.equal(config.enabled, true)
assert.equal(config.hostNetId, 0xcafe)
assert.equal(config.hostReconnectMs, 90_000)
assert.equal(config.guestReconnectMs, 60_000)

const silent = { log() {}, warn() {} }
const service = createCs16RoomService({
  env: {
    CS16_ALLOWED_ORIGINS: 'http://allowed.test',
    CS16_RELAY_HEARTBEAT_INTERVAL_MS: '5000',
  },
  logger: silent,
})
const app = express()
app.use(express.json())
app.use('/api/cs16', service.router)
const http = createServer(app)
service.attach(http)
const address = await listen(http)
const origin = `http://127.0.0.1:${address.port}`
const wsOrigin = origin.replace('http:', 'ws:')

try {
  const proxiedLoopbackCreate = await fetch(`${origin}/api/cs16/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({ map: 'de_dust2', botCount: 7, difficulty: 3 }),
  })
  assert.equal(proxiedLoopbackCreate.status, 201, 'Vite changeOrigin 后 localhost 与 127.0.0.1 应视为同一本机来源')

  const crossSiteCreate = await fetch(`${origin}/api/cs16/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
    body: JSON.stringify({ map: 'de_dust2', botCount: 7, difficulty: 3 }),
  })
  assert.equal(crossSiteCreate.status, 403, '第三方网页不能借访客浏览器批量占房')

  const invalid = await fetch(`${origin}/api/cs16/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: '../../etc', botCount: 7, difficulty: 3 }),
  })
  assert.equal(invalid.status, 400)

  const createdResponse = await fetch(`${origin}/api/cs16/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: 'de_dust2', botCount: 7, difficulty: 3 }),
  })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/)
  assert.match(created.hostToken, /^[A-Za-z0-9_-]{24,}$/)
  assert.deepEqual(created.server, { netId: 0xcafe, port: 27015 })

  const legacyCreated = await fetch(`${origin}/api/cs16/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: 'de_dust2', botCount: 1, difficulty: 1 }),
  }).then((response) => response.json())
  const legacyHost = await openWs(
    `${wsOrigin}/api/cs16/room?room=${legacyCreated.code}&role=host&token=${encodeURIComponent(legacyCreated.hostToken)}`,
  )
  assert.equal((await nextJson(legacyHost, 'room-ready')).role, 'host', '先发后端时必须承接尚未刷新的旧 Pages 客户端')
  legacyHost.close(1000, 'page closed')

  const publicRoom = await fetch(`${origin}/api/cs16/rooms/${created.code}`).then((response) => response.json())
  assert.equal(publicRoom.hostReady, false)
  assert.ok(publicRoom.hostWaitMsRemaining > 14 * 60_000, '客户端必须知道真实的房主等待窗口')
  assert.equal('hostToken' in publicRoom, false, '查询房间不能泄露房主凭证')

  const guest = await openWs(`${wsOrigin}/api/cs16/room?room=${created.code}&role=guest`)
  const waiting = await nextJson(guest, 'room-waiting')
  assert.equal(waiting.code, created.code, '好友可以在房主加载期间先进入等待')
  assert.match(waiting.resumeToken, /^[A-Za-z0-9_-]{24,}$/)

  assert.equal(
    await rejectedStatus(`${wsOrigin}/api/cs16/room?room=${created.code}&role=host`, 'http://allowed.test', '8bitgo.cs16.host.wrong'),
    403,
    '没有一次性房主凭证不能接管监听服',
  )
  assert.equal(
    await rejectedStatus(`${wsOrigin}/api/cs16/room?room=${created.code}&role=guest`, 'https://evil.invalid'),
    403,
    '跨站页面不能借房间网关发包',
  )

  const guestReadyPromise = nextJson(guest, 'room-ready')
  const hostUrl = `${wsOrigin}/api/cs16/room?room=${created.code}&role=host`
  assert.equal(hostUrl.includes(created.hostToken), false, '房主凭证不能进入 WebSocket 请求 URL')
  const host = await openWs(hostUrl, 'http://allowed.test', `8bitgo.cs16.host.${created.hostToken}`)
  const hostReadyPromise = nextJson(host, 'room-ready')
  const [guestReady, hostReady] = await Promise.all([guestReadyPromise, hostReadyPromise])
  assert.equal(guestReady.peerId, 1)
  assert.equal(hostReady.role, 'host')

  const fromGuest = new Promise((resolve) => host.once('message', (data, binary) => {
    if (binary) resolve(Buffer.from(data))
  }))
  guest.send(Buffer.from([1, 2, 3]))
  assert.deepEqual(await fromGuest, Buffer.from([0, 1, 1, 2, 3]), '访客包必须带服务端分配的 peerId 到房主')

  const fromHost = new Promise((resolve) => guest.once('message', (data, binary) => {
    if (binary) resolve(Buffer.from(data))
  }))
  host.send(Buffer.from([0, 1, 9, 8, 7]))
  assert.deepEqual(await fromHost, Buffer.from([9, 8, 7]), '房主回复只送到指定访客')

  const guestDropped = new Promise((resolve) => guest.once('close', resolve))
  guest.terminate()
  await guestDropped
  const resumedGuest = await openWs(
    `${wsOrigin}/api/cs16/room?room=${created.code}&role=guest`,
    'http://allowed.test',
    `8bitgo.cs16.guest.${waiting.resumeToken}`,
  )
  const resumedGuestReady = await nextJson(resumedGuest, 'room-ready')
  assert.equal(resumedGuestReady.peerId, 1, '访客瞬断重连必须复用原 peerId')
  const resumedPacket = new Promise((resolve) => host.once('message', (data, binary) => {
    if (binary) resolve(Buffer.from(data))
  }))
  resumedGuest.send(Buffer.from([6, 6]))
  assert.deepEqual(await resumedPacket, Buffer.from([0, 1, 6, 6]), '恢复后的数据报必须继续使用原 peerId')

  const hostWaitingPromise = nextJson(resumedGuest, 'room-waiting')
  host.terminate()
  const hostWaiting = await hostWaitingPromise
  assert.equal(hostWaiting.reconnecting, true, '房主异常断线时访客应原地等待重连')
  const retained = await fetch(`${origin}/api/cs16/rooms/${created.code}`).then((response) => response.json())
  assert.equal(retained.hostReady, false)

  const guestRestoredPromise = nextJson(resumedGuest, 'room-ready')
  const restoredHost = await openWs(hostUrl, 'http://allowed.test', `8bitgo.cs16.host.${created.hostToken}`)
  const [guestRestored, restoredHostReady] = await Promise.all([
    guestRestoredPromise,
    nextJson(restoredHost, 'room-ready'),
  ])
  assert.equal(guestRestored.peerId, 1, '房主重连后访客必须沿用原 peerId')
  assert.equal(restoredHostReady.role, 'host')

  const guestClosed = new Promise((resolve) => resumedGuest.once('close', (code) => resolve(code)))
  restoredHost.close(1000, 'page closed')
  assert.equal(await guestClosed, 1012, '房主离开必须立即结束房间，不能留下僵尸访客')
  const gone = await fetch(`${origin}/api/cs16/rooms/${created.code}`)
  assert.equal(gone.status, 404)

  console.log('CS1.6 临时房间自测通过：房主恢复、访客 peerId 续连、凭证/同源限制、双向数据报与主动离开回收')
} finally {
  service.close()
  await close(http)
}
