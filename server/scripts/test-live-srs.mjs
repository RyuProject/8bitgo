/** SRS 直播的服务端回归：用轻量假 API 覆盖准入、授权、容量和协商边界。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client } from 'socket.io-client'

const fakeSrsRequests = []
/** 被踢掉的 SRS client_id（DELETE /api/v1/clients/:id） */
const kicked = []
const srsUnit = await readFile(new URL('../../deploy/live/srs/8bitgo-live-srs.service', import.meta.url), 'utf8')
const srsConfigTemplate = await readFile(new URL('../../deploy/live/srs/srs.conf.template', import.meta.url), 'utf8')
assert.match(srsUnit, /^RestrictAddressFamilies=.*\bAF_NETLINK\b/m, 'SRS 沙箱必须允许通过 rtnetlink 枚举接口地址')
assert.match(srsConfigTemplate, /^daemon\s+off;/m, 'systemd 必须以前台方式托管 SRS，禁止二次 daemonize')
assert.match(srsConfigTemplate, /^pid\s+\/run\/8bitgo-live-srs\/srs\.pid;/m, 'SRS PID 文件必须放在 systemd 创建的可写运行目录')
assert.match(srsConfigTemplate, /^listen\s+127\.0\.0\.1:1935;/m, 'RTMP 只能监听回环，直播不对公网开放 1935')
const fakeSrs = createServer(async (req, res) => {
  if (req.method === 'DELETE' && req.url?.startsWith('/api/v1/clients/')) {
    kicked.push(decodeURIComponent(req.url.slice('/api/v1/clients/'.length)))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"code":0}')
    return
  }
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
process.env.LIVE_SRS_ORPHAN_GRACE_MS = '300'

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
const hook = (body, key = process.env.LIVE_SRS_HOOK_SECRET, { headers = {}, remoteAddress = '127.0.0.1' } = {}) => {
  const out = response()
  live.srsHook({ query: { key }, body: { app: 'live', ...body }, headers, socket: { remoteAddress } }, out.res)
  return out.promise
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const proxiedHook = await hook({ action: 'on_publish', stream: 'unknown', client_id: 'x' }, undefined, { headers: { 'x-forwarded-for': '203.0.113.9' } })
  assert.equal(proxiedHook.status, 403, '经反代进来的 hook 即使密钥正确也必须拒绝')
  const cfHook = await hook({ action: 'on_publish', stream: 'unknown', client_id: 'x' }, undefined, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
  assert.equal(cfHook.status, 403, '经 Cloudflare 进来的 hook 必须拒绝')
  const publicHook = await hook({ action: 'on_publish', stream: 'unknown', client_id: 'x' }, undefined, { remoteAddress: '203.0.113.9' })
  assert.equal(publicHook.status, 403, '公网地址直连源站端口的 hook 必须拒绝')
  const dockerHook = await hook({ action: 'on_publish', stream: 'unknown', client_id: 'x' }, undefined, { remoteAddress: '::ffff:172.17.0.2' })
  assert.equal(dockerHook.status, 404, 'Docker 网桥来的 hook 可以进到房间校验（未知流 404）')
  assert.equal((await exchange('publish', startedA.data.roomId, startedA.data.srsGrant, 'not an sdp')).status, 400, '不是 SDP 的正文不转给 SRS')

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

  const kicksBeforeRepublish = kicked.length
  assert.equal((await exchange('publish', roomA, startedA.data.srsGrant)).status, 200, '主播重新推流照常转发')
  assert.deepEqual(kicked.slice(kicksBeforeRepublish), ['publisher-a'], '⭐ 重新推流前先踢掉旧上行，免得新 WHIP 撞上 stream busy')
  const readyAgain = once(hostA, 'srs-state')
  assert.equal((await hook({
    action: 'on_publish', stream: publishCall.stream, client_id: 'publisher-a2',
    param: `?token=${encodeURIComponent(publishCall.token)}`,
  })).status, 200)
  assert.deepEqual(await readyAgain, { ready: true }, '换了一路上行要再广播 ready，让断流的观众立刻重拉')
  await sleep(50) // 兜底踢旧上行是异步的，等它落地，别混进后面的断言
  assert.equal((await hook({ action: 'on_publish', stream: publishCall.stream, client_id: '../../x' , param: `?token=${encodeURIComponent(publishCall.token)}` })).status, 403, '畸形 client_id 不能进账（会拼进踢人 API 路径）')

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
  const kicksBeforeSecondPlay = kicked.length
  assert.equal((await hook({
    action: 'on_play', stream: publishCall.stream, client_id: 'viewer-current',
    param: `?token=${encodeURIComponent(watchedA.data.srsGrant)}`,
  })).status, 200)
  await sleep(50)
  assert.deepEqual(kicked.slice(kicksBeforeSecondPlay), ['viewer-stale'], '⭐ 同一观众新开一路拉流就踢掉旧的，一张票换不来无限路 SRS 会话')

  const freshGrant = await call(viewerA, 'srs-play-grant', {})
  assert.equal(freshGrant.err, null, '名单里的观众能换播放票')
  assert.ok(freshGrant.data.srsGrant && freshGrant.data.srsReady === true)
  assert.equal((await exchange('play', roomA, freshGrant.data.srsGrant)).status, 200, '新换的票可以兑换')
  const outsiderGrant = await call(hostA, 'srs-play-grant', {})
  assert.equal(outsiderGrant.err, 'not a viewer', '主播 / 房外的人不能领播放票')
  for (let i = 2; i < 8; i++) assert.equal((await exchange('play', roomA, watchedA.data.srsGrant)).status, 200)
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

  const kicksBeforeLeave = kicked.length
  viewerA.close()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(!kicked.slice(kicksBeforeLeave).includes('viewer-current'), '离房宽限期内不踢（信令抖一下的观众还能认领回来）')
  await sleep(400)
  assert.ok(kicked.slice(kicksBeforeLeave).includes('viewer-current'), '⭐ 离房观众的拉流宽限期满后被踢掉，不能断开信令后继续白拉 SRS')
  assert.equal((await exchange('play', roomA, watchedA.data.srsGrant)).status, 403, '离房后旧播放票不能再次兑换')
  assert.equal((await hook({
    action: 'on_play', stream: publishCall.stream, client_id: 'viewer-old',
    param: `?token=${encodeURIComponent(watchedA.data.srsGrant)}`,
  })).status, 403, '离房后的旧观众不能通过 SRS 播放回调')

  // 同一个观众（同 key）换了 socket 回来：宽限期里的拉流交还给他，不踢
  {
    const viewerKeyed = await connect()
    const watchedKeyed = await call(viewerKeyed, 'watch', { roomId: roomA, key: 'viewer-key-1' })
    assert.equal(watchedKeyed.err, null)
    assert.equal((await hook({
      action: 'on_play', stream: publishCall.stream, client_id: 'viewer-keyed',
      param: `?token=${encodeURIComponent(watchedKeyed.data.srsGrant)}`,
    })).status, 200)
    const kicksBeforeBlip = kicked.length
    viewerKeyed.close()
    await sleep(80)
    const viewerBack = await connect()
    assert.equal((await call(viewerBack, 'watch', { roomId: roomA, key: 'viewer-key-1' })).err, null)
    await sleep(400)
    assert.ok(!kicked.slice(kicksBeforeBlip).includes('viewer-keyed'), '⭐ 同一观众凭 key 回来，宽限期里的拉流不被踢（画面不断）')

    // 房间结束：上行和所有拉流一起踢掉
    const kicksBeforeClose = kicked.length
    takeover.emit('stop-live')
    await sleep(150)
    const closedKicks = kicked.slice(kicksBeforeClose)
    assert.ok(closedKicks.includes('publisher-a2') && closedKicks.includes('viewer-keyed'), `⭐ 下播时踢掉上行与拉流，实际 ${JSON.stringify(closedKicks)}`)
    assert.equal((await hook({ action: 'on_publish', stream: publishCall.stream, client_id: 'late', param: '' })).status, 404, '已结束房间的流不再被认领')
  }

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
  console.log('✅ SRS 故障 fail-closed、关闭时 P2P、hook 密钥与来源、WHIP/WHEP 代理、成员绑定、会话踢除与容量均通过')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  await new Promise((resolve) => io.close(resolve))
  await new Promise((resolve) => fakeSrs.close(resolve))
}
