/**
 * SRS 房「事件流观众」的服务端回归（见 src/live.js「不走 socket.io 的 SRS 观众」）。
 *
 * 用真的 HTTP + 真的 socket.io 主播跑一遍：进房拿票、播放票能兑换、人数 / 弹幕 / 状态事件推得到、
 * 换票与催主播、同一把 key 重连不多算人数、升级成 socket 时 SRS 拉流记账跟着走、离开 / 散场的清理、
 * 成人房年龄门和点对点老房的退路。不联网、不用数据库。
 *
 * 跑：cd server && npm run test:live-stream
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { Server } from 'socket.io'
import { io as client } from 'socket.io-client'

const fakeSrsRequests = []
const kicked = []
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
    for await (const _chunk of req) { /* 读掉正文 */ }
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
process.env.LIVE_SRS_TOKEN_SECRET = 'srs-token-secret-for-stream-tests-2026'
process.env.LIVE_SRS_HOOK_SECRET = 'srs-hook-secret-for-stream-tests-2026'
process.env.LIVE_SRS_MAX_VIEWERS = '3'
process.env.LIVE_SRS_MAX_TOTAL_VIEWERS = '6'
process.env.LIVE_SRS_ORPHAN_GRACE_MS = '300'
process.env.SSE_HEARTBEAT_MS = '200'

const { attachLive, liveRoom } = await import('../src/live.js')
const { signToken } = await import('../src/auth.js')
/** 两个账号：成年人（主播 + 合规观众）和未成年人（应被拒） */
const users = {
  '1001': { id: 1001, nickname: 'Grown', status: 'active', birth_date: '1990-01-01', token_version: 0 },
  '1002': { id: 1002, nickname: 'Kid', status: 'active', birth_date: `${new Date().getFullYear() - 10}-01-01`, token_version: 0 },
}

const adultSlugs = new Set(['adult-game'])
const app = express()
app.use(express.json({ limit: '16kb' }))
const http = createServer(app)
const io = new Server(http, { cors: { origin: true } })
const live = attachLive(io, {
  findGame: async (slug) => ({ slug, adult: adultSlugs.has(slug) ? 1 : 0, hidden: 0 }),
  findUser: async (_sql, params) => users[String(params?.[0])] ?? null,
})
app.post('/api/live/rooms/:roomId/watch', live.streamWatch)
app.post('/api/live/rooms/:roomId/grant', live.streamGrant)
app.post('/api/live/rooms/:roomId/nudge', live.streamNudge)
app.post('/api/live/rooms/:roomId/chat', live.streamChat)
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${http.address().port}`

let pass = 0
const ok = (name) => {
  pass++
  console.log(`  ok  ${name}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sockets = []
const connect = async (token = '') => {
  const socket = client(`${base}/live`, { transports: ['websocket'], forceNew: true, ...(token ? { auth: { token } } : {}) })
  sockets.push(socket)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket 连不上')), 2_000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
  })
  return socket
}
const call = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, (err, data) => resolve({ err, data })))
const once = (socket, event, ms = 2_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`超时: ${event}`)), ms)
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload) })
})
/** 记下某个 socket 收到的全部某类事件，用来断言「没收到」 */
const record = (socket, event) => {
  const got = []
  socket.on(event, (payload) => got.push(payload))
  return got
}
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
const exchange = async (mode, roomId, grant) => {
  const out = response()
  await live.srsExchange({ params: { mode }, body: { roomId, grant, sdp: 'v=0\r\n' } }, out.res)
  return out.promise
}
const hook = (body) => {
  const out = response()
  live.srsHook({ query: { key: process.env.LIVE_SRS_HOOK_SECRET }, body: { app: 'live', ...body }, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, out.res)
  return out.promise
}
const post = async (roomId, path, body, token = '') => {
  const res = await fetch(`${base}/api/live/rooms/${encodeURIComponent(roomId)}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/**
 * 开一条观众事件流。返回 { status, body }（被拒时）或 { welcome, events, next(event), close(), closed }。
 * 解析和浏览器端同一种 SSE 帧（event: / data:）。
 */
const openStream = async (roomId, key, token = '') => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/live/rooms/${encodeURIComponent(roomId)}/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ key }),
    signal: controller.signal,
  })
  if (!res.ok) return { status: res.status, body: await res.json() }
  const events = []
  const waiters = []
  let closed = false
  let resolveClosed
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve })
  const deliver = (frame) => {
    events.push(frame)
    const waiter = waiters.find((item) => item.event === frame.event)
    if (!waiter) return
    waiters.splice(waiters.indexOf(waiter), 1)
    frame.taken = true
    waiter.resolve(frame.data)
  }
  void (async () => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          let event = 'message'
          let data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          deliver({ event, data: data ? JSON.parse(data) : null })
        }
      }
    } catch {
      /* 主动 abort */
    } finally {
      closed = true
      resolveClosed()
    }
  })()
  const next = (event, ms = 2_000) => {
    const seen = events.find((frame) => frame.event === event && !frame.taken)
    if (seen) {
      seen.taken = true
      return Promise.resolve(seen.data)
    }
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve: (data) => { clearTimeout(timer); resolve(data) } }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error(`事件流超时: ${event}`))
      }, ms)
      waiters.push(waiter)
    })
  }
  const welcome = await next('welcome')
  return {
    welcome,
    events,
    next,
    close: () => controller.abort(),
    get closed() { return closed },
    whenClosed: closedPromise,
  }
}

try {
  console.log('① 进房：一个 POST 拿到快照、播放票和会话令牌，主播只看到人数')
  const host = await connect()
  const joinedEvents = record(host, 'viewer-joined')
  const started = await call(host, 'go-live', { gameSlug: 'game-a', gameName: 'A' })
  assert.equal(started.err, null)
  assert.equal(started.data.transport, 'srs')
  const roomId = started.data.roomId
  assert.equal((await exchange('publish', roomId, started.data.srsGrant)).status, 200)
  const publishCall = fakeSrsRequests.at(-1)
  assert.equal((await hook({ action: 'on_publish', stream: publishCall.stream, client_id: 'pub-1', param: `?token=${encodeURIComponent(publishCall.token)}` })).status, 200)
  assert.equal(liveRoom(roomId).srsReady, true)

  const hostViewers = once(host, 'viewers')
  const a = await openStream(roomId, 'key-a')
  assert.equal(a.welcome.roomId, roomId)
  assert.equal(a.welcome.transport, 'srs')
  assert.equal(a.welcome.srsReady, true)
  assert.match(a.welcome.session, /^[A-Za-z0-9_-]{32}$/, '会话令牌要有足够熵')
  assert.ok(a.welcome.srsGrant, '欢迎帧必须带播放票')
  assert.ok(Array.isArray(a.welcome.chat) && Array.isArray(a.welcome.list))
  assert.equal(a.welcome.rebound, false)
  ok('欢迎帧带房间快照、播放票、会话令牌、弹幕和名单')
  assert.equal((await hostViewers).count, 1, '主播要收到人数（据此开推 SRS 上行）')
  await sleep(150)
  assert.equal(joinedEvents.length, 0, '事件流观众没有 socket，不能给主播发 viewer-joined（那会让主播去建点不通的协作连接）')
  ok('主播收到人数 1，没有收到 viewer-joined')

  console.log('② 播放票能兑换，SRS hook 认这个成员')
  const play = await exchange('play', roomId, a.welcome.srsGrant)
  assert.equal(play.status, 200, '事件流观众的票必须能走 WHEP 代理')
  const playCall = fakeSrsRequests.at(-1)
  assert.equal(playCall.path, '/rtc/v1/whep/')
  assert.equal((await hook({ action: 'on_play', stream: playCall.stream, client_id: 'play-a1', param: `?token=${encodeURIComponent(playCall.token)}` })).status, 200)
  ok('WHEP 代理与 on_play hook 都放行事件流观众')

  console.log('③ 弹幕 / 换票 / 催主播')
  const hostChat = once(host, 'chat')
  const sent = await post(roomId, 'chat', { session: a.welcome.session, text: '  你好  ' })
  assert.equal(sent.status, 200)
  assert.ok(sent.body.id, '发成功回消息 id')
  const chatOnStream = await a.next('chat')
  assert.equal(chatOnStream.text, '你好')
  assert.equal(chatOnStream.host, false)
  assert.ok(chatOnStream.guest, '游客有服务端派生的号')
  assert.equal((await hostChat).id, sent.body.id)
  ok('弹幕广播到事件流和主播，署名由服务端派生')
  assert.equal((await post(roomId, 'chat', { session: 'wrong-session', text: 'x' })).body.error !== undefined, true, '会话令牌不对就不让发')
  assert.equal((await post(roomId, 'chat', { session: a.welcome.session, text: '   ' })).body.error !== undefined, true)
  ok('错误会话 / 空弹幕被拒')

  const grant = await post(roomId, 'grant', { session: a.welcome.session })
  assert.equal(grant.status, 200)
  assert.ok(grant.body.srsGrant)
  assert.equal(grant.body.srsReady, true)
  assert.equal((await exchange('play', roomId, grant.body.srsGrant)).status, 200, '新票同样能兑换')
  assert.equal((await post(roomId, 'grant', { session: 'nope' })).status, 404)
  ok('换票：新票可用，陌生会话 404')

  const nudged = once(host, 'viewers')
  assert.equal((await post(roomId, 'nudge', { session: a.welcome.session })).status, 204)
  assert.equal((await nudged).count, 1, '催主播 = 把人数再发给主播一次')
  assert.equal((await post(roomId, 'nudge', { session: a.welcome.session })).status, 429, '催主播要限频')
  ok('催主播：主播收到人数；连催被限频')

  console.log('④ 房间事件推到事件流')
  host.emit('host-visibility', { hidden: true })
  assert.deepEqual(await a.next('host-frozen'), { roomId, frozen: true })
  host.emit('host-visibility', { hidden: false })
  assert.deepEqual(await a.next('host-frozen'), { roomId, frozen: false })
  host.emit('coop-state', { open: true, taken: false })
  assert.deepEqual(await a.next('coop'), { open: true }, '2P 位出现要告诉事件流观众（他们好改连 socket）')
  host.emit('source-missing')
  assert.deepEqual(await a.next('no-source'), {})
  const unpublish = hook({ action: 'on_unpublish', stream: publishCall.stream, client_id: 'pub-1' })
  assert.deepEqual(await a.next('srs-state'), { ready: false })
  await unpublish
  assert.equal((await hook({ action: 'on_publish', stream: publishCall.stream, client_id: 'pub-2', param: `?token=${encodeURIComponent(publishCall.token)}` })).status, 200)
  assert.deepEqual(await a.next('srs-state'), { ready: true })
  await a.next('ping', 1_000)
  ok('host-frozen / coop / no-source / srs-state / ping 都推得到')

  console.log('⑤ 同一把 key 重连：不多算人数，旧流被收掉，SRS 拉流记到新 id')
  let viewersCountEvents = record(host, 'viewers')
  const a2 = await openStream(roomId, 'key-a')
  assert.equal(a2.welcome.rebound, true)
  assert.equal(a2.welcome.viewers, 1, '换连接不算新观众')
  assert.deepEqual(await a.next('replaced'), {})
  await a.whenClosed
  ok('旧流收到 replaced 并被关掉')
  await sleep(500)
  assert.ok(!kicked.includes('play-a1'), '换连接不能被当成离房去踢 SRS 拉流')
  assert.ok(viewersCountEvents.every((event) => event.count === 1), '人数始终是 1')
  ok('SRS 拉流没被踢、人数没有跳')

  console.log('⑥ 升级成 socket（上场当 2P）：事件流被取代，主播收到 viewer-rebound')
  const rebound = once(host, 'viewer-rebound')
  const viewerSocket = await connect()
  const watched = await call(viewerSocket, 'watch', { roomId, key: 'key-a', reoffer: false })
  assert.equal(watched.err, null)
  assert.equal(watched.data.rebound, true)
  const reb = await rebound
  assert.ok(reb.from.startsWith('sv_'), 'from 是事件流观众的 id')
  assert.equal(reb.to, viewerSocket.id)
  assert.deepEqual(await a2.next('replaced'), {})
  await a2.whenClosed
  await sleep(500)
  assert.ok(!kicked.includes('play-a1'), '升级成 socket 不能踢掉正在看的拉流')
  assert.equal(liveRoom(roomId).viewers, 1)
  ok('升级：拉流记账跟着走、人数不变、主播据 rebound 给 socket 建协作连接')
  viewerSocket.disconnect()
  await sleep(100)

  console.log('⑦ 离开：主播收到 viewer-left，拉流宽限后被踢')
  const b = await openStream(roomId, 'key-b')
  assert.equal((await exchange('play', roomId, b.welcome.srsGrant)).status, 200)
  const bCall = fakeSrsRequests.at(-1)
  assert.equal((await hook({ action: 'on_play', stream: bCall.stream, client_id: 'play-b1', param: `?token=${encodeURIComponent(bCall.token)}` })).status, 200)
  const left = once(host, 'viewer-left')
  b.close()
  assert.ok((await left).viewerId.startsWith('sv_'))
  await sleep(500)
  assert.ok(kicked.includes('play-b1'), '离开的观众在 SRS 里的拉流宽限后必须踢掉')
  assert.equal((await post(roomId, 'grant', { session: b.welcome.session })).status, 404, '离开后会话作废')
  ok('离开：通知主播、踢拉流、会话作废')

  console.log('⑧ 续播的确认把事件流观众单列出来')
  const c = await openStream(roomId, 'key-c')
  const resumed = await call(host, 'resume-live', { roomId, token: started.data.token })
  assert.equal(resumed.err, null)
  assert.ok(resumed.data.viewers.length >= 1, 'viewers 仍是全部成员（老版本主播拿它当人数）')
  assert.ok(resumed.data.streamViewers.includes(resumed.data.viewers.find((id) => id.startsWith('sv_'))), 'streamViewers 列出事件流观众')
  ok('resume-live 带 streamViewers')

  console.log('⑨ 满员 / 不存在 / 散场')
  const d = await openStream(roomId, 'key-d')
  const e = await openStream(roomId, 'key-e')
  const full = await openStream(roomId, 'key-f')
  assert.equal(full.status, 409)
  assert.equal(full.body.code, 'full')
  ok('满员回 409 full（同一把 key 重连不受此限，见 ⑤）')
  const missing = await openStream('no-such-room', 'key-x')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'room-not-found', '房间不存在要带 code，客户端据此区分「路由不存在」')
  ok('不存在的房间回 404 room-not-found')
  host.emit('stop-live')
  for (const stream of [c, d, e]) {
    assert.equal((await stream.next('live-ended')).reason, 'stopped')
    await stream.whenClosed
  }
  assert.equal(liveRoom(roomId), null)
  ok('散场：每条事件流收到 live-ended 并被关掉')

  console.log('⑩ 成人房：事件流同样过年龄门')
  const adultHost = await connect(signToken('1001'))
  const adultStarted = await call(adultHost, 'go-live', { gameSlug: 'adult-game', gameName: 'Adult' })
  assert.equal(adultStarted.err, null, '成年主播能开成人房')
  const adultRoom = adultStarted.data.roomId
  const anonymous = await openStream(adultRoom, 'key-anon')
  assert.equal(anonymous.status, 403)
  assert.equal(anonymous.body.code, 'adult')
  assert.equal(anonymous.body.error, 'adult login required')
  const kid = await openStream(adultRoom, 'key-kid', signToken('1002'))
  assert.equal(kid.status, 403)
  assert.equal(kid.body.error, 'adult age restricted')
  ok('游客、未成年人进不了成人房的事件流')
  const grown = await openStream(adultRoom, 'key-grown', signToken('1001'))
  assert.equal(grown.welcome.roomId, adultRoom)
  const named = await post(adultRoom, 'chat', { session: grown.welcome.session, text: 'hi' }, signToken('1001'))
  assert.ok(named.body.id)
  assert.equal((await grown.next('chat')).name, 'Grown', '带令牌进房的弹幕署名是账号昵称')
  ok('成年观众能进，弹幕署名来自服务端查到的昵称')
  const unsigned = await post(adultRoom, 'chat', { session: grown.welcome.session, text: 'bye' })
  assert.ok(unsigned.body.id)
  assert.equal((await grown.next('chat')).name, undefined, '这一次没带令牌（中途退出登录）就按游客署名，不沿用旧身份')
  ok('署名跟着每一次请求的令牌走')
  grown.close()

  console.log(`\n${pass} 项通过`)
} finally {
  for (const socket of sockets) socket.disconnect()
  io.close()
  http.close()
  fakeSrs.close()
}
process.exit(0)
