/** SRS 直播的服务端回归：用轻量假 API 覆盖准入、授权、容量和协商边界。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client } from 'socket.io-client'

const fakeSrsRequests = []
const srsUnit = await readFile(new URL('../../deploy/live/srs/8bitgo-live-srs.service', import.meta.url), 'utf8')
assert.match(srsUnit, /^RestrictAddressFamilies=.*\bAF_NETLINK\b/m, 'SRS 沙箱必须允许通过 rtnetlink 枚举接口地址')
const fakeSrs = createServer(async (req, res) => {
  if (req.url === '/api/v1/versions') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '6.0.195' }))
    return
  }
  if (req.url?.startsWith('/rtc/v1/whip/') || req.url?.startsWith('/rtc/v1/whep/')) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, 'http://srs.test')
    fakeSrsRequests.push({ path: url.pathname, stream: url.searchParams.get('stream'), token: url.searchParams.get('token') })
    res.writeHead(201, { 'content-type': 'application/sdp' })
    res.end('v=0\r\no=srs 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n')
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise((resolve) => fakeSrs.listen(0, '127.0.0.1', resolve))

process.env.LIVE_RESUME_GRACE_MS = '800'
process.env.LIVE_MAX_ROOMS = '10'
process.env.LIVE_MAX_ROOMS_PER_IP = '0'
process.env.LIVE_SRS_ENABLED = 'true'
process.env.LIVE_SRS_REQUIRED = 'true'
process.env.LIVE_SRS_INTERNAL_API_ORIGIN = `http://127.0.0.1:${fakeSrs.address().port}`
process.env.LIVE_SRS_TOKEN_SECRET = 'srs-token-secret-for-tests-2026-11'
process.env.LIVE_SRS_HOOK_SECRET = 'srs-hook-secret-for-tests-2026-11'
process.env.LIVE_SRS_MAX_VIEWERS = '2'
process.env.LIVE_SRS_MAX_TOTAL_VIEWERS = '3'

const { attachLive, liveRoom } = await import('../src/live.js')
const http = createServer()
const io = new Server(http, { cors: { origin: true } })
const live = attachLive(io, { findGame: async (slug) => ({ slug, adult: 0, hidden: 0 }) })
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${http.address().port}/live`
const conn = () => client(url, { transports: ['websocket'], forceNew: true })
const call = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, (err, data) => resolve({ err, data })))
const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`超时: ${event}`)), 2_000)
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload) })
})
const response = () => {
  let status = 200
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return {
    promise,
    res: {
      status(code) { status = code; return this },
      json(body) { resolve({ status, body }); return this },
      send(body) { resolve({ status, body }); return this },
    },
  }
}
const exchange = async (mode, roomId, grant, sdp = 'v=0\r\n') => {
  const out = response()
  await live.srsExchange({ params: { mode }, body: { roomId, grant, sdp } }, out.res)
  return out.promise
}
const hook = (body, key = process.env.LIVE_SRS_HOOK_SECRET) => {
  const out = response()
  live.srsHook({ query: { key }, body }, out.res)
  return out.promise
}

const sockets = []
const connect = async () => {
  const socket = conn()
  sockets.push(socket)
  await once(socket, 'connect')
  return socket
}

try {
  const hostA = await connect()
  const startedA = await call(hostA, 'go-live', { gameSlug: 'game-a', gameName: 'A' })
  assert.equal(startedA.err, null)
  assert.equal(startedA.data.transport, 'srs', '健康 SRS 应接收新房间')
  const roomA = startedA.data.roomId

  const badHook = await hook({ action: 'on_publish', stream: 'unknown', client_id: 'x' }, 'wrong')
  assert.equal(badHook.status, 403, '错误 hook 密钥必须被拒绝')

  const publisherRequest = exchange('publish', roomA, startedA.data.srsGrant)
  const publishResult = await publisherRequest
  assert.equal(publishResult.status, 200, 'SRS WHIP 的 HTTP 201 SDP 应被代理成功')
  const publishCall = fakeSrsRequests.at(-1)
  assert.equal(publishCall.path, '/rtc/v1/whip/')
  assert.equal((await exchange('publish', roomA, startedA.data.srsGrant, `v=0\r\n${'x'.repeat(256_001)}`)).status, 400, '超大 SDP 必須在代理前拒绝')
  const published = await hook({
    action: 'on_publish', stream: publishCall.stream, client_id: 'publisher-a',
    param: `?token=${encodeURIComponent(publishCall.token)}`,
  })
  assert.equal(published.status, 200)
  assert.equal(liveRoom(roomA).srsReady, true)

  const viewerA = await connect()
  const watchedA = await call(viewerA, 'watch', { roomId: roomA })
  assert.equal(watchedA.err, null)
  assert.ok(watchedA.data.srsGrant)
  const playResult = await exchange('play', roomA, watchedA.data.srsGrant)
  assert.equal(playResult.status, 200)
  assert.equal(fakeSrsRequests.at(-1).path, '/rtc/v1/whep/')

  const allowedPlayHook = await hook({
    action: 'on_play', stream: publishCall.stream, client_id: 'viewer-stale',
    param: `?token=${encodeURIComponent(watchedA.data.srsGrant)}`,
  })
  assert.equal(allowedPlayHook.status, 200, '当前房间成员可通过 SRS on_play 回调')
  for (let i = 1; i < 8; i++) assert.equal((await exchange('play', roomA, watchedA.data.srsGrant)).status, 200)
  assert.equal((await exchange('play', roomA, watchedA.data.srsGrant)).status, 429, '重复兑换同一播放票必须限速')

  const viewerA2 = await connect()
  assert.equal((await call(viewerA2, 'watch', { roomId: roomA })).err, null)

  const hostB = await connect()
  const startedB = await call(hostB, 'go-live', { gameSlug: 'game-b', gameName: 'B' })
  assert.equal(startedB.data.transport, 'srs')
  const viewerB = await connect()
  assert.equal((await call(viewerB, 'watch', { roomId: startedB.data.roomId })).err, null)
  const viewerC = await connect()
  const roomFull = await call(viewerC, 'watch', { roomId: roomA })
  assert.equal(roomFull.err, 'full', '单房上限必须生效')
  const globalFull = await call(viewerC, 'watch', { roomId: startedB.data.roomId })
  assert.equal(globalFull.err, 'server full', '跨房间总观众上限必须生效')

  const takeover = await connect()
  const hostAway = once(viewerA, 'host-away')
  hostA.close()
  await hostAway
  const resumed = await call(takeover, 'resume-live', { roomId: roomA, token: startedA.data.token })
  assert.equal(resumed.err, null)
  assert.notEqual(resumed.data.srsGrant, startedA.data.srsGrant, '续播票必须绑定新主播连接')
  const stalePublish = await exchange('publish', roomA, startedA.data.srsGrant)
  assert.equal(stalePublish.status, 403, '旧主播连接不能继续创建新的上行会话')
  const stalePublishHook = await hook({
    action: 'on_publish', stream: publishCall.stream, client_id: 'publisher-old',
    param: `?token=${encodeURIComponent(publishCall.token)}`,
  })
  assert.equal(stalePublishHook.status, 403, '旧主播的迟到发布回调必须拒绝')

  viewerA.close()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal((await exchange('play', roomA, watchedA.data.srsGrant)).status, 403, '离房后旧播放票不能再次兑换')
  assert.equal((await hook({
    action: 'on_play', stream: publishCall.stream, client_id: 'viewer-old',
    param: `?token=${encodeURIComponent(watchedA.data.srsGrant)}`,
  })).status, 403, '离房后的旧观众不能通过 SRS 播放回调')

  process.env.LIVE_SRS_INTERNAL_API_ORIGIN = 'http://127.0.0.1:1'
  const hostFallback = await connect()
  const fallback = await call(hostFallback, 'go-live', { gameSlug: 'game-c', gameName: 'C' })
  assert.equal(fallback.err, 'SRS service unavailable', 'SRS 已启用但健康检查失败时必须拒绝开播')
  assert.equal(fallback.data, undefined, 'SRS 故障时不得创建 P2P 房间绕过 SFU')

  process.env.LIVE_SRS_ENABLED = 'false'
  process.env.LIVE_SRS_REQUIRED = 'false'
  const hostDisabled = await connect()
  const disabled = await call(hostDisabled, 'go-live', { gameSlug: 'game-d', gameName: 'D' })
  assert.equal(disabled.err, null)
  assert.equal(disabled.data.transport, 'p2p', '仅在显式关闭 SRS 的开发 / 回滚配置下允许 P2P')

  process.env.LIVE_SRS_REQUIRED = 'true'
  const hostRequired = await connect()
  const required = await call(hostRequired, 'go-live', { gameSlug: 'game-e', gameName: 'E' })
  assert.equal(required.err, 'SRS service unavailable', '生产锁必须防止误关启用项后退回 P2P')

  for (const socket of sockets) socket.close()
  await new Promise((resolve) => setTimeout(resolve, 80))
  console.log('✅ SRS 故障 fail-closed、关闭时 P2P、hook 密钥、WHIP/WHEP 代理、成员绑定与容量均通过')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  await new Promise((resolve) => io.close(resolve))
  await new Promise((resolve) => fakeSrs.close(resolve))
}
