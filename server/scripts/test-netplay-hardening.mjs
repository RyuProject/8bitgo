/**
 * 联机加固部分的测试：房间令牌、控制消息过滤、开房限流、SSE 推送、ICE 下发。
 * 用法： node server/scripts/test-netplay-hardening.mjs
 */
import { createServer } from 'node:http'
import express from 'express'
import { io as ioc } from 'socket.io-client'
import { attachNetplay } from '../src/netplay.js'
import { iceRouter } from '../src/routes/ice.js'

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = express()
app.use('/api/netplay/ice', iceRouter)
const httpServer = createServer(app)
attachNetplay(httpServer, app, ['*'])
await new Promise((r) => httpServer.listen(0, r))
const port = httpServer.address().port
const base = `http://127.0.0.1:${port}`

const connect = () => {
  const s = ioc(`${base}/netplay`, { transports: ['websocket'], forceNew: true })
  return new Promise((res) => s.on('connect', () => res(s)))
}
const extra = (sessionid, userid, gameId = 1) => ({
  sessionid, userid, game_id: gameId, domain: 'test', room_name: 'R', player_name: userid,
})

console.log('── 房间令牌 ──')
const host = await connect()
let hostToken = null
host.on('room-token', (d) => (hostToken = d.token))
await new Promise((r) => host.emit('open-room', { extra: extra('r1', 'u-host'), maxPlayers: 4, password: '' }, r))
await sleep(80)
ok(typeof hostToken === 'string' && hostToken.length > 20, '开房后收到房间令牌')

const guest = await connect()
let guestToken = null
let guestUsers = null
guest.on('room-token', (d) => (guestToken = d.token))
await new Promise((r) => guest.emit('join-room', { extra: extra('r1', 'u-guest'), password: '' }, (e, u) => { guestUsers = u; r() }))
await sleep(80)
ok(typeof guestToken === 'string' && guestToken !== hostToken, '访客拿到不同的令牌')
ok(guestUsers && !JSON.stringify(guestUsers).includes(hostToken), 'users 广播里不含任何人的令牌')

console.log('\n── 存档鉴权 ──')
const put = (token, userHeader) =>
  fetch(`${base}/api/netplay/rooms/r1/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...(token ? { 'x-netplay-token': token } : {}), ...(userHeader ? { 'x-netplay-user': userHeader } : {}) },
    body: Buffer.from('SAVEDATA'),
  })
ok((await put(hostToken)).ok, '房主用令牌能上传存档')
ok((await put(guestToken)).status === 403, '访客用自己的令牌上传被拒')
ok((await put(null, 'u-host')).ok, '旧前端（只带 userid）仍然兼容')
// 关键：访客知道房主的 userid（users-updated 会广播），以前靠这个就能覆盖存档
ok(JSON.stringify(guestUsers).includes('u-host'), '房主的 userid 确实对访客可见')

console.log('\n── 控制消息过滤 ──')
let hijack = null
host.on('data-message', (d) => { if (d && d['host-migrated']) hijack = d })
guest.emit('data-message', { 'host-migrated': { roomId: 'evil' } })
await sleep(150)
ok(hijack === null, '访客伪造的 host-migrated 被拦掉')
let chat = null
host.on('data-message', (d) => { if (d && d.chat) chat = d })
guest.emit('data-message', { chat: 'hi' })
await sleep(150)
ok(chat?.chat === 'hi', '正常的聊天消息照常转发')

console.log('\n── 开房限流 ──')
const dup = await new Promise((r) => guest.emit('open-room', { extra: extra('r2', 'u-guest'), maxPlayers: 2 }, r))
ok(dup === 'already in a room', '同一个连接不能再开第二个房间')

console.log('\n── SSE 推送 ──')
const events = []
const es = await fetch(`${base}/api/netplay/events?watch=r1`)
const reader = es.body.getReader()
const dec = new TextDecoder()
let buf = ''
const pump = (async () => {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      const ev = /event: (\S+)/.exec(chunk)?.[1]
      if (ev) events.push(ev)
    }
  }
})()
await sleep(200)
ok(events.includes('rooms'), '连上就收到房间列表快照')
ok(events.includes('room'), '订阅的房间也推了一份')
const before = events.length
const third = await connect()
await new Promise((r) => third.emit('join-room', { extra: extra('r1', 'u3'), password: '' }, r))
await sleep(400)
ok(events.length > before, '有人加入后立刻推送（不用等轮询）')

console.log('\n── ICE 下发 ──')
const ice1 = await (await fetch(`${base}/api/netplay/ice`)).json()
ok(Array.isArray(ice1.iceServers) && ice1.iceServers.length >= 1, '没配 TURN 时返回 STUN')
ok(ice1.hasTurn === false, '如实报告没有 TURN')
process.env.TURN_URLS = 'turn:turn.example.com:3478'
process.env.TURN_SECRET = 'test-secret'
const ice2 = await (await fetch(`${base}/api/netplay/ice`)).json()
const turn = ice2.iceServers.find((x) => String(x.urls).includes('turn:'))
ok(Boolean(turn?.username && turn?.credential), '配了 TURN 后带上凭证')
ok(/^\d+:/.test(turn.username), '用户名是 <过期时间>:<标签> 格式')
const ice3 = await (await fetch(`${base}/api/netplay/ice`)).json()
const turn3 = ice3.iceServers.find((x) => String(x.urls).includes('turn:'))
ok(turn3.credential === turn.credential || turn3.username !== turn.username, '凭证按时间戳生成（同秒内一致）')
ok(ice2.expiry > Math.floor(Date.now() / 1000), '过期时间在将来')

console.log(`\n${fail ? '❌' : '全部通过 ✅'}  通过 ${pass}，失败 ${fail}`)
host.close(); guest.close(); third.close()
reader.cancel().catch(() => {})
httpServer.close()
process.exit(fail ? 1 : 0)
