#!/usr/bin/env node
/**
 * SRS 房观众「不开 socket.io」那条路的客户端回归（src/services/liveStream.ts + adapters/liveview.ts 的接线）。
 *
 * 三部分：
 *   ① SSE 解析器、拒绝原因归类、几个小请求 —— 用假 fetch 真跑；
 *   ② 端到端：起真的 server/src/live.js（HTTP + socket.io 主播 + 假 SRS），用**浏览器同一份**
 *      openLiveStream / liveStreamChat / liveStreamGrant 去进房、收事件、发弹幕、被顶替、散场；
 *   ③ liveview 的接线（源码形状）：先走事件流、该退回 socket 的才退、2P 位改连 socket、弹幕走对路。
 *
 * 跑：npm run test:live-stream-client
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io as client } from 'socket.io-client'
import { CHAT_ACK_NO_ROOM, CHAT_ACK_TOO_FAST } from '../shared/live-chat.js'
import {
  LiveStreamCallError,
  LiveStreamRefused,
  SSE_MAX_PENDING_CHARS,
  classifyStreamRefusal,
  createSseParser,
  liveStreamChat,
  liveStreamGrant,
  liveStreamNudge,
  openLiveStream,
} from '../src/services/liveStream.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e?.stack || e}`)
  }
}

/* ---------------- ① 纯逻辑 ---------------- */

const enc = new TextEncoder()
/** 一个可控的流式响应：push 文本、end、error */
const streamResponse = ({ status = 200, type = 'text/event-stream; charset=utf-8' } = {}) => {
  let controller
  const body = new ReadableStream({ start(c) { controller = c } })
  const response = new Response(body, { status, headers: { 'content-type': type } })
  return {
    response,
    push: (text) => controller.enqueue(enc.encode(text)),
    end: () => controller.close(),
    error: (e) => controller.error(e),
  }
}
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const WELCOME = { roomId: 'r1', title: 'T', hostName: 'H', gameName: 'G', viewers: 1, transport: 'srs', srsReady: true, srsGrant: 'g', session: 's'.repeat(32), chat: [], list: [] }

console.log('① 解析器 / 归类 / 小请求')

await check('SSE 解析器：任意切分、CRLF、多行 data、注释行都认', () => {
  const got = []
  const parser = createSseParser((event, data) => got.push([event, data]))
  const text = ': comment\r\nevent: a\r\ndata: 1\r\n\r\nevent: b\ndata: x\ndata: y\n\ndata: plain\n\nevent: ping\ndata: 1\n\n'
  for (let i = 0; i < text.length; i += 3) parser.push(text.slice(i, i + 3))
  assert.deepEqual(got, [['a', '1'], ['b', 'x\ny'], ['message', 'plain'], ['ping', '1']])
})

await check('SSE 解析器：一个事件攒得过大就抛错（坏对端不能把标签页内存撑爆）', () => {
  const parser = createSseParser(() => {})
  assert.throws(() => parser.push('data: ' + 'x'.repeat(SSE_MAX_PENDING_CHARS + 10)), /too large/)
  const parser2 = createSseParser(() => {})
  assert.throws(() => parser2.push('x'.repeat(SSE_MAX_PENDING_CHARS + 10)), /too large/, '没有换行的一大段也要拦')
})

await check('拒绝原因归类：哪些退回 socket、哪些直接报错', () => {
  assert.equal(classifyStreamRefusal(404, { code: 'room-not-found' }), 'room-not-found')
  assert.equal(classifyStreamRefusal(409, { code: 'full' }), 'full')
  assert.equal(classifyStreamRefusal(403, { code: 'adult' }), 'adult')
  assert.equal(classifyStreamRefusal(409, { code: 'p2p-room' }), 'p2p-room')
  assert.equal(classifyStreamRefusal(503, { error: 'too many event streams' }), 'busy')
  assert.equal(classifyStreamRefusal(404, null), 'unsupported', '没有 code 的 404 是老服务端没有这个接口')
  assert.equal(new LiveStreamRefused('room-not-found', '').fallback, false)
  assert.equal(new LiveStreamRefused('full', '').fallback, false)
  assert.equal(new LiveStreamRefused('adult', '').fallback, false)
  for (const c of ['p2p-room', 'unsupported', 'busy', 'network', 'timeout']) assert.equal(new LiveStreamRefused(c, '').fallback, true, c)
})

await check('进房请求：POST、key 在请求体、登录令牌只走 Authorization 头（不进 URL）', async () => {
  const calls = []
  const s = streamResponse()
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return s.response }
  globalThis.localStorage = { getItem: (k) => (k === '8bitgo.token' ? 'jwt-abc' : null) }
  try {
    const p = openLiveStream('room/1', 'key-1', { onEvent() {}, onEnd() {} }, { fetchImpl })
    s.push(frame('welcome', WELCOME))
    const conn = await p
    conn.close()
  } finally {
    delete globalThis.localStorage
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/live/rooms/room%2F1/watch')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: 'key-1' })
  assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt-abc')
  assert.ok(!calls[0].url.includes('jwt'), 'JWT 不能进 URL')
})

await check('welcome 同步应用，早于同一个数据块里紧跟着的事件', async () => {
  const order = []
  const s = streamResponse()
  const p = openLiveStream('r1', 'k', {
    onWelcome: (w) => order.push(['welcome', w.session]),
    onEvent: (event, data) => order.push([event, data?.text ?? null]),
    onEnd: () => order.push(['end']),
  }, { fetchImpl: async () => s.response })
  s.push(frame('welcome', WELCOME) + frame('chat', { text: 'hi' }) + 'event: ping\ndata: 1\n\n')
  const conn = await p
  await sleep(10)
  assert.deepEqual(order.slice(0, 2), [['welcome', WELCOME.session], ['chat', 'hi']])
  assert.equal(conn.welcome.session, WELCOME.session)
  conn.close()
  s.end()
  await sleep(10)
  assert.ok(!order.some(([e]) => e === 'end'), '主动 close() 之后不能再回调 onEnd（否则会被当成断线去重连）')
})

await check('流被服务端收尾：onEnd(closed)；最后一帧是 replaced 时带上 replaced=true', async () => {
  for (const replacedFrame of [false, true]) {
    const ends = []
    const s = streamResponse()
    const p = openLiveStream('r1', 'k', { onEvent() {}, onEnd: (reason, replaced) => ends.push([reason, replaced]) }, { fetchImpl: async () => s.response })
    s.push(frame('welcome', WELCOME))
    await p
    if (replacedFrame) s.push(frame('replaced', {}))
    s.end()
    await sleep(10)
    assert.deepEqual(ends, [['closed', replacedFrame]])
  }
})

await check('被拒：按状态码 / code 抛 LiveStreamRefused；200 却不是事件流也算走不通', async () => {
  const cases = [
    [new Response(JSON.stringify({ error: 'p2p room', code: 'p2p-room' }), { status: 409, headers: { 'content-type': 'application/json' } }), 'p2p-room'],
    [new Response(JSON.stringify({ error: 'not found', code: 'room-not-found' }), { status: 404, headers: { 'content-type': 'application/json' } }), 'room-not-found'],
    [new Response(JSON.stringify({ error: 'too many event streams' }), { status: 503, headers: { 'content-type': 'application/json' } }), 'busy'],
    [new Response('<html>', { status: 404, headers: { 'content-type': 'text/html' } }), 'unsupported'],
    [new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), 'unsupported'],
    [new Response(null, { status: 204 }), 'unsupported'],
  ]
  for (const [response, expected] of cases) {
    await assert.rejects(
      openLiveStream('r1', 'k', { onEvent() {}, onEnd() {} }, { fetchImpl: async () => response }),
      (e) => e instanceof LiveStreamRefused && e.code === expected,
      expected,
    )
  }
  await assert.rejects(
    openLiveStream('r1', 'k', { onEvent() {}, onEnd() {} }, { fetchImpl: async () => { throw new TypeError('Failed to fetch') } }),
    (e) => e instanceof LiveStreamRefused && e.code === 'network' && e.fallback,
  )
})

await check('等不到 welcome：超时拒绝并真的掐掉请求（服务端随之把这位观众登记撤掉）', async () => {
  let signal
  const s = streamResponse()
  await assert.rejects(
    openLiveStream('r1', 'k', { onEvent() {}, onEnd() {} }, { fetchImpl: async (_u, init) => { signal = init.signal; return s.response }, welcomeTimeoutMs: 50 }),
    (e) => e instanceof LiveStreamRefused && e.code === 'timeout',
  )
  assert.equal(signal.aborted, true)
})

await check('第一帧不是 welcome：当成这条路走不通', async () => {
  const s = streamResponse()
  const p = openLiveStream('r1', 'k', { onEvent() {}, onEnd() {} }, { fetchImpl: async () => s.response })
  s.push(frame('chat', { text: 'x' }))
  await assert.rejects(p, (e) => e instanceof LiveStreamRefused && e.code === 'unsupported')
})

await check('静默看门狗：太久一个字节都没有就判死（中间设备静默丢连接）', async () => {
  const ends = []
  let signal
  const s = streamResponse()
  const p = openLiveStream('r1', 'k', { onEvent() {}, onEnd: (reason) => ends.push(reason) }, { fetchImpl: async (_u, init) => { signal = init.signal; return s.response }, silenceMs: 1_000 })
  s.push(frame('welcome', WELCOME))
  await p
  await sleep(1_400)
  assert.deepEqual(ends, ['silent'])
  assert.equal(signal.aborted, true, '判死之后要真的掐掉，不然连接和服务端名额都留着')
})

await check('一个事件处理抛错不会把整条流判死', async () => {
  const ends = []
  const seen = []
  const s = streamResponse()
  const p = openLiveStream('r1', 'k', {
    onEvent: (event) => { seen.push(event); if (event === 'chat') throw new Error('boom') },
    onEnd: (reason) => ends.push(reason),
  }, { fetchImpl: async () => s.response })
  s.push(frame('welcome', WELCOME))
  const conn = await p
  const warn = console.warn
  console.warn = () => {}
  try {
    s.push(frame('chat', { text: 'x' }) + frame('viewers', { count: 2 }))
    await sleep(10)
  } finally {
    console.warn = warn
  }
  assert.deepEqual(seen, ['chat', 'viewers'])
  assert.deepEqual(ends, [])
  conn.close()
})

await check('弹幕：结果和 socket 的 ack 一套（null / too-fast / dropped），永不抛', async () => {
  const reply = (status, body) => async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  assert.equal(await liveStreamChat('r1', 'sess', 'hi', reply(200, { id: 'm1' })), null)
  assert.equal(await liveStreamChat('r1', 'sess', 'hi', reply(200, { error: CHAT_ACK_TOO_FAST })), 'too-fast')
  assert.equal(await liveStreamChat('r1', 'sess', 'hi', reply(200, { error: CHAT_ACK_NO_ROOM })), 'dropped')
  assert.equal(await liveStreamChat('r1', 'sess', 'hi', reply(500, { error: 'x' })), 'dropped')
  assert.equal(await liveStreamChat('r1', 'sess', 'hi', async () => { throw new TypeError('offline') }), 'dropped')
  let called = false
  assert.equal(await liveStreamChat('r1', '', 'hi', async () => { called = true }), 'dropped', '流正在重连（没有会话）时照实说没发出去')
  assert.equal(await liveStreamChat('r1', 'sess', '   ', async () => { called = true }), 'dropped')
  assert.equal(called, false)
  let body
  await liveStreamChat('r1', 'sess', '  hello  ', async (_u, init) => { body = JSON.parse(init.body); return new Response('{"id":"x"}', { status: 200 }) })
  assert.deepEqual(body, { session: 'sess', text: 'hello' })
})

await check('换票 / 催主播：404 抛出状态码（调用方据此重新进房）', async () => {
  const ok = await liveStreamGrant('r1', 'sess', async () => new Response(JSON.stringify({ srsGrant: 'g2', srsReady: false }), { status: 200 }))
  assert.deepEqual(ok, { srsGrant: 'g2', srsReady: false })
  await assert.rejects(
    liveStreamGrant('r1', 'sess', async () => new Response(JSON.stringify({ error: 'not a viewer', code: 'session' }), { status: 404 })),
    (e) => e instanceof LiveStreamCallError && e.status === 404,
  )
  await assert.rejects(liveStreamGrant('r1', 'sess', async () => { throw new TypeError('offline') }), (e) => e instanceof LiveStreamCallError && e.status === 0)
  assert.equal(await liveStreamNudge('r1', 'sess', async () => new Response(null, { status: 204 })), 204)
  assert.equal(await liveStreamNudge('r1', 'sess', async () => new Response('{}', { status: 404 })), 404)
})

/* ---------------- ② 端到端：真服务端 + 浏览器同一份客户端代码 ---------------- */

console.log('② 端到端（真 server/src/live.js）')

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url))
const express = serverRequire('express')
const { Server } = serverRequire('socket.io')

const fakeSrsRequests = []
const fakeSrs = createServer(async (req, res) => {
  if (req.method === 'DELETE' && req.url?.startsWith('/api/v1/clients/')) {
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
process.env.LIVE_MAX_ROOMS_PER_IP = '0'
process.env.LIVE_SRS_ENABLED = 'true'
process.env.LIVE_SRS_REQUIRED = 'true'
process.env.LIVE_SRS_INTERNAL_API_ORIGIN = `http://127.0.0.1:${fakeSrs.address().port}`
process.env.LIVE_SRS_TOKEN_SECRET = 'srs-token-secret-for-client-tests-2026'
process.env.LIVE_SRS_HOOK_SECRET = 'srs-hook-secret-for-client-tests-2026'
process.env.LIVE_SRS_ORPHAN_GRACE_MS = '300'
process.env.SSE_HEARTBEAT_MS = '200'

const { attachLive, liveRoom } = await import('../server/src/live.js')
const app = express()
app.use(express.json({ limit: '16kb' }))
const http = createServer(app)
const ioServer = new Server(http, { cors: { origin: true } })
const live = attachLive(ioServer, {
  findGame: async (slug) => ({ slug, adult: 0, hidden: 0 }),
  findUser: async () => null,
})
app.post('/api/live/rooms/:roomId/watch', live.streamWatch)
app.post('/api/live/rooms/:roomId/grant', live.streamGrant)
app.post('/api/live/rooms/:roomId/nudge', live.streamNudge)
app.post('/api/live/rooms/:roomId/chat', live.streamChat)
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${http.address().port}`
/** 浏览器里 apiBase() 是同源空串；这里补上测试服务器的地址，其余原样交给 node 的 fetch */
const fetchImpl = (url, init) => fetch(base + url, init)

const sockets = []
const connect = async () => {
  const socket = client(`${base}/live`, { transports: ['websocket'], forceNew: true })
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
const response = () => {
  let status = 200
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, res: { status(c) { status = c; return this }, json(body) { resolve({ status, body }); return this }, send(body) { resolve({ status, body }); return this } } }
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
/** 用浏览器那份 openLiveStream 进房，事件攒起来供断言 */
const viewer = async (roomId, key) => {
  const events = []
  const ends = []
  const waiters = []
  const conn = await openLiveStream(roomId, key, {
    onEvent: (event, data) => {
      events.push({ event, data })
      const w = waiters.find((item) => item.event === event)
      if (w) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(data)
      }
    },
    onEnd: (reason, replaced) => ends.push({ reason, replaced }),
  }, { fetchImpl })
  const next = (event, ms = 2_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`事件流超时: ${event}`)), ms)
    waiters.push({ event, resolve: (data) => { clearTimeout(timer); resolve(data) } })
  })
  return { conn, events, ends, next }
}

try {
  const host = await connect()
  const started = await call(host, 'go-live', { gameSlug: 'game-a', gameName: 'A' })
  assert.equal(started.err, null)
  const roomId = started.data.roomId
  assert.equal((await exchange('publish', roomId, started.data.srsGrant)).status, 200)
  const publishCall = fakeSrsRequests.at(-1)
  assert.equal((await hook({ action: 'on_publish', stream: publishCall.stream, client_id: 'pub-1', param: `?token=${encodeURIComponent(publishCall.token)}` })).status, 200)

  let a
  await check('进房：一个 POST 拿到快照与播放票，播放票能直接走 WHEP', async () => {
    const hostViewers = once(host, 'viewers')
    a = await viewer(roomId, 'key-a')
    assert.equal(a.conn.welcome.transport, 'srs')
    assert.equal(a.conn.welcome.srsReady, true)
    assert.ok(a.conn.welcome.srsGrant)
    assert.equal((await hostViewers).count, 1)
    assert.equal((await exchange('play', roomId, a.conn.welcome.srsGrant)).status, 200)
  })

  await check('心跳 ping 真的到（静默看门狗靠它）', async () => {
    await a.next('ping', 1_000)
  })

  await check('弹幕：浏览器的 liveStreamChat 发出，主播与事件流都收到', async () => {
    const hostChat = once(host, 'chat')
    const back = a.next('chat')
    assert.equal(await liveStreamChat(roomId, a.conn.welcome.session, '你好', fetchImpl), null)
    assert.equal((await hostChat).text, '你好')
    assert.equal((await back).text, '你好', '自己发的那条也要从服务端回来（客户端不做本地回显）')
  })

  await check('主播事件推得到：host-frozen / srs-state', async () => {
    const frozen = a.next('host-frozen')
    host.emit('host-visibility', { hidden: true })
    assert.equal((await frozen).frozen, true)
    const back = a.next('host-frozen')
    host.emit('host-visibility', { hidden: false })
    assert.equal((await back).frozen, false)
    const state = a.next('srs-state')
    assert.equal((await hook({ action: 'on_unpublish', stream: publishCall.stream, client_id: 'pub-1' })).status, 200)
    assert.equal((await state).ready, false)
  })

  await check('换票：浏览器的 liveStreamGrant 拿到新票', async () => {
    const grant = await liveStreamGrant(roomId, a.conn.welcome.session, fetchImpl)
    assert.ok(grant.srsGrant)
    assert.equal(grant.srsReady, false)
  })

  await check('同一把 key 再进房（断流重连）：旧流收到 replaced 后结束，人数不变', async () => {
    const a2 = await viewer(roomId, 'key-a')
    assert.equal(a2.conn.welcome.rebound, true)
    await sleep(100)
    assert.deepEqual(a.ends, [{ reason: 'closed', replaced: true }])
    assert.equal(liveRoom(roomId).viewers, 1)
    a = a2
  })

  await check('改连 socket（上场当 2P）：同一把 key watch，事件流被顶替而不是当成离房', async () => {
    const socketViewer = await connect()
    const joined = once(host, 'viewer-joined')
    const watched = await call(socketViewer, 'watch', { roomId, key: 'key-a', reoffer: true })
    assert.equal(watched.err, null)
    assert.equal(watched.data.rebound, true)
    const j = await joined
    assert.equal(j.viewerId, socketViewer.id, 'reoffer 必须让主播为新 id 建协作连接')
    await sleep(100)
    assert.deepEqual(a.ends, [{ reason: 'closed', replaced: true }])
    assert.equal(liveRoom(roomId).viewers, 1)
    socketViewer.close()
    await sleep(100)
  })

  await check('散场：事件流先收到 live-ended，随后服务端关流', async () => {
    const b = await viewer(roomId, 'key-b')
    const ended = b.next('live-ended')
    host.emit('stop-live')
    await ended
    await sleep(100)
    assert.equal(b.ends.length, 1)
    assert.equal(b.ends[0].reason, 'closed')
  })

  await check('房间没了：浏览器拿到 room-not-found（不退回 socket，直接报）', async () => {
    await assert.rejects(viewer(roomId, 'key-c'), (e) => e instanceof LiveStreamRefused && e.code === 'room-not-found' && !e.fallback)
  })
} finally {
  for (const s of sockets) s.close()
  ioServer.close()
  http.close()
  fakeSrs.close()
}

/* ---------------- ③ liveview 接线 ---------------- */

console.log('③ liveview 接线')
const view = code('src/emulator/adapters/liveview.ts')
const lib = code('src/services/liveStream.ts')

await check('进房先走事件流；只有 fallback 的失败才退回 socket，其余直接报错', () => {
  const boot = view.slice(view.lastIndexOf('void (async () => {'))
  assert.ok(boot.indexOf('await connectStream()') >= 0 && boot.indexOf('await connectStream()') < boot.indexOf('await startSocketViewer()'))
  assert.match(boot, /if \(err && !err\.fallback\)[\s\S]{0,200}fail\(/)
})

await check('事件流把服务端推的每一种房间事件都接上', () => {
  for (const event of ['viewers', 'chat', 'srs-state', 'netplay-linked', 'host-frozen', 'host-away', 'host-back', 'live-ended', 'no-source', 'coop']) {
    assert.match(view, new RegExp(`case '${event}':`), `事件流没接 ${event}`)
  }
  // 服务端文档里列的事件名，和这里接的必须是同一份
  const server = read('server/src/live.js')
  const doc = server.slice(server.indexOf('进房，响应体是这位观众的事件流'), server.indexOf('const streamWatch'))
  for (const event of ['viewers', 'chat', 'srs-state', 'host-frozen', 'host-away', 'host-back', 'netplay-linked', 'coop', 'no-source', 'live-ended']) {
    assert.ok(doc.includes(event), `服务端文档里没写 ${event}`)
  }
})

await check('2P 位：welcome.coopOpen 或 coop 事件都改连 socket，且带 reoffer', () => {
  assert.match(view, /if \(welcome\.coopOpen\) void switchToSocket\('coop'\)/)
  assert.match(view, /case 'coop':[\s\S]{0,120}switchToSocket\('coop'\)/)
  assert.match(view, /await watch\(reason === 'coop'\)/)
})

await check('弹幕在事件流模式走 POST，不碰 socket', () => {
  assert.match(view, /if \(streamMode\) return liveStreamChat\(live\.roomId, streamSession, text\)/)
})

await check('散场 / 报错 / 销毁都先收掉事件流（不然 onEnd 会去重连，把「已结束」盖成「不存在」）', () => {
  const ended = view.slice(view.indexOf('const onLiveEnded'), view.indexOf('const onLiveEnded') + 400)
  assert.ok(ended.indexOf('stopStream()') >= 0 && ended.indexOf('stopStream()') < ended.indexOf('options.onError'))
  const failFn = view.slice(view.indexOf('const fail = '), view.indexOf('const fail = ') + 400)
  assert.match(failFn, /stopStream\(\)/)
  const destroy = view.slice(view.indexOf('destroy() {'))
  assert.match(destroy, /stopStream\(\)/)
})

await check('SRS 房的协作连接换一轮不能清掉画面状态（不然好好的拉流 20 秒后被拆掉重拉）', () => {
  const fresh = view.slice(view.indexOf('const freshPc'), view.indexOf('const next = new RTCPeerConnection({ iceServers })'))
  assert.match(fresh, /if \(transport !== 'srs'\) \{[\s\S]*gotFrame = false[\s\S]*\}/)
})

await check('换票 / 催主播回 404 就重新进房（welcome 里带新票）', () => {
  assert.match(view, /e instanceof LiveStreamCallError && e\.status === 404[^\n]*restartStream\(\)/)
  assert.match(view, /status === 404[^\n]*restartStream\(\)/)
})

await check('liveStream.ts：令牌只走请求头 / 请求体，不用 EventSource', () => {
  assert.ok(!/new EventSource/.test(lib), 'EventSource 带不了请求头，令牌只能进 URL')
  assert.match(lib, /Authorization: `Bearer \$\{token\}`/)
  assert.ok(!/\?(session|token)=/.test(lib), '会话 / 登录令牌不能进 URL')
})

console.log(failed ? `\n${failed} 项失败（${passed} 项通过）` : `\n全部通过 ✅（${passed} 项）`)
process.exit(failed ? 1 : 0)
