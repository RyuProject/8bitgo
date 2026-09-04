/**
 * 联机加固部分的测试：房间令牌、控制消息过滤、开房限流、SSE 推送、ICE 下发。
 * 用法： node server/scripts/test-netplay-hardening.mjs
 */
import { createServer } from 'node:http'
import express from 'express'
import { io as ioc } from 'socket.io-client'
// 每 IP 上限是模块加载时读的，先设好再 import（测试里所有连接都是 127.0.0.1）
process.env.NETPLAY_MAX_ROOMS_PER_IP = '3'
// 每房间每 IP 的成员上限运行中现读 env，默认关掉，下面「第三批」里单独开一下测
process.env.NETPLAY_MAX_MEMBERS_PER_IP = '0'
// 存档总预算压到 64 字节：正常上传的 'SAVEDATA' 8 字节能过，第三批里试一份 100 字节的
process.env.NETPLAY_STATE_BUDGET_BYTES = '64'
const { attachNetplay } = await import('../src/netplay.js')
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
// 关键：访客知道房主的 userid（users-updated 会广播），以前带个 userid 头就能覆盖房主存档
ok(JSON.stringify(guestUsers).includes('u-host'), '房主的 userid 确实对访客可见')
ok((await put(null, 'u-host')).status === 403, '只带 userid（不带令牌）上传被拒 —— 这条路谁都能伪造')
ok((await put('not-a-real-token')).status === 403, '假令牌被拒')

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

// 访客发 restart / pause：EmulatorJS 的 dataMessage 收到就直接重开 / 暂停房主的游戏
const hostGot = []
host.on('data-message', (d) => hostGot.push(d))
guest.emit('data-message', { restart: true })
guest.emit('data-message', { pause: true, chat: 'still here' })
await sleep(150)
ok(!hostGot.some((d) => d.restart), '访客发的 restart 被拦掉')
ok(!hostGot.some((d) => d.pause) && hostGot.some((d) => d.chat === 'still here'), '访客发的 pause 被摘掉，同包里的聊天照常')
hostGot.length = 0
host.emit('data-message', { pause: true })
const guestGot = []
guest.on('data-message', (d) => guestGot.push(d))
await sleep(50)
host.emit('data-message', { restart: true })
await sleep(150)
ok(guestGot.some((d) => d.restart), '房主发的 restart 照常转发')

// 按键同步：访客是 2P（下标 1），只能替自己按；替 1P 按的被丢
guest.emit('data-message', { 'sync-control': [
  { frame: 1, connected_input: [1, 0, 1] },
  { frame: 1, connected_input: [0, 0, 1] },
] })
await sleep(150)
const sync = hostGot.find((d) => d['sync-control'])
ok(sync && sync['sync-control'].length === 1 && sync['sync-control'][0].connected_input[0] === 1, '访客只能发自己手柄位的按键')
hostGot.length = 0
// 观众（手柄位满了之后进来的人）一个键都不许发
const spectators = []
for (let i = 0; i < 3; i++) {
  const sp = await connect()
  await new Promise((r) => sp.emit('join-room', { extra: extra('r1', `u-sp${i}`), password: '' }, r))
  spectators.push(sp)
}
const spec = spectators[spectators.length - 1]
spec.emit('data-message', { 'sync-control': [{ frame: 1, connected_input: [0, 0, 1] }] })
spec.emit('data-message', { 'sync-control': [{ frame: 1, connected_input: [1, 0, 1] }], chat: 'watching' })
await sleep(150)
ok(!hostGot.some((d) => d['sync-control']) && hostGot.some((d) => d.chat === 'watching'), '观众的按键被丢，聊天照常')
for (const sp of spectators) sp.close()
await sleep(100)

console.log('\n── 信令只走星型 ──')
let g2gLeak = null
guest.on('webrtc-signal', (d) => (g2gLeak = d))
const other = await connect()
await new Promise((r) => other.emit('join-room', { extra: extra('r1', 'u-other'), password: '' }, r))
other.emit('webrtc-signal', { target: guest.id, offer: { sdp: 'x' } })
await sleep(150)
ok(g2gLeak === null, '访客之间的信令被拦')
let toHost = null
host.on('webrtc-signal', (d) => (toHost = d))
other.emit('webrtc-signal', { target: host.id, offer: { sdp: 'ok' } })
await sleep(150)
ok(toHost?.offer?.sdp === 'ok' && toHost.sender === other.id, '访客 -> 房主照常')
other.close()
await sleep(100)

console.log('\n── 开房限流 ──')
const dup = await new Promise((r) => guest.emit('open-room', { extra: extra('r2', 'u-guest'), maxPlayers: 2 }, r))
ok(dup === 'already in a room', '同一个连接不能再开第二个房间')
// 同一 IP 最多 3 个房间（r1 已经占了一个）
const spam = []
const spamRes = []
for (let i = 0; i < 3; i++) {
  const sp = await connect(); spam.push(sp)
  spamRes.push(await new Promise((r) => sp.emit('open-room', { extra: extra(`spam${i}`, `u-spam${i}`), maxPlayers: 2 }, r)))
}
ok(spamRes[0] == null && spamRes[1] == null, '同一 IP 前几个房间能开')
ok(spamRes[2] === 'too many rooms', '同一 IP 超过上限被拒')
for (const sp of spam) sp.close()
await sleep(100)

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

console.log('\n── sync-control 不能撑爆房主的内存 ──')
/**
 * 引擎收到 sync-control 会 push 进 inputsData[frame]，而那张表只在「那一帧真的到来」
 * 时才删。帧号是发送方给的 —— 填一个永远不会到的数，记录就永远留在房主浏览器里。
 * 一条消息塞几千条、20 条/秒，几分钟就能把房主的标签页撑爆。
 */
const flood = []
for (let i = 0; i < 500; i++) flood.push({ frame: 2000000 + i, connected_input: [1, 0, 1] })
flood.push({ frame: -5, connected_input: [1, 0, 1] })
flood.push({ frame: 'abc', connected_input: [1, 0, 1] })
let flooded = null
host.on('data-message', (d) => { if (d['sync-control']) flooded = d['sync-control'] })
guest.emit('data-message', { 'sync-control': flood })
await sleep(150)
ok(Array.isArray(flooded) && flooded.length <= 32, `一条消息里的 sync-control 被截断（收到 ${flooded?.length}）`)
ok(Array.isArray(flooded) && flooded.every((e) => Number.isInteger(e.frame) && e.frame >= 0), '非法帧号被丢掉')

console.log('\n── 聊天不能冒名 ──')
let chatGot = null
host.on('data-message', (d) => { if (d['chat-message']) chatGot = d['chat-message'] })
guest.emit('data-message', { 'chat-message': { player_name: '房主', from: 'u-host', to: 'all', message: 'x'.repeat(3000) } })
await sleep(150)
ok(chatGot?.player_name === 'u-guest', `昵称由服务端填（收到 ${chatGot?.player_name}）`)
ok(chatGot?.from === 'u-guest', 'from 换成真实发送者，冒充不了别人')
ok(typeof chatGot?.message === 'string' && chatGot.message.length <= 500, '正文限长')

console.log('\n── 冒名顶替（重复 userid）──')
/**
 * userid 是客户端自填的，而且随 users-updated 广播给屋里每个人。
 * 挡不住重复的话，任何访客都能拿房主的 userid 再 join 一次，
 * room.users.set 会**覆盖**房主那条记录 —— 他拿到一张绑着房主 userid 的令牌，
 * 能覆盖房主存档，真房主的令牌反而作废（自己的进度托管全部 403），
 * 他一断线还会把房主从成员表里带走。整个房间被劫。
 */
const evil = await connect()
let evilToken = null
evil.on('room-token', (d) => (evilToken = d.token))
const evilErr = await new Promise((r) => evil.emit('join-room', { extra: extra('r1', 'u-host'), password: '' }, (e) => r(e)))
await sleep(120)
ok(evilErr === 'userid taken', '拿房主的 userid 进房被拒')
ok(!evilToken, '被拒的连接拿不到房间令牌')
ok((await put(hostToken)).ok, '真房主的令牌仍然有效（没被顶掉）')
const roster = await (await fetch(`${base}/api/netplay/rooms/r1`)).json()
ok(roster.members.some((m) => m.host), '房主还在成员表里')
evil.close()

console.log('\n── 存档不能裸奔 ──')
// 房间 id 在 /api/netplay/rooms 上是公开的，不带令牌放行等于谁都能把别人的进度拖走
const anon = await fetch(`${base}/api/netplay/rooms/r1/state`)
ok(anon.status === 403, '不带令牌取存档被拒')
const wrong = await fetch(`${base}/api/netplay/rooms/r1/state`, { headers: { 'x-netplay-token': 'not-a-real-token' } })
ok(wrong.status === 403, '拿错令牌取存档被拒')
const mine = await fetch(`${base}/api/netplay/rooms/r1/state`, { headers: { 'x-netplay-token': hostToken } })
ok(mine.ok, '成员凭自己的令牌能取')

console.log('\n── 观众上场不能挤走别人的手柄号 ──')
/**
 * usersPayload 里玩家按插入顺序排，EmulatorJS 拿这个顺序当手柄号。
 * 一个**先加入**的观众就地转成玩家会插到现有玩家前面，把别人的下标整体往后挤 ——
 * 正在玩的人按键会跑到另一个手柄位上。
 */
const rHost = await connect()
let rHostTok = null
rHost.on('room-token', (d) => (rHostTok = d.token))
await new Promise((r) => rHost.emit('open-room', { extra: extra('r2', 'p0'), maxPlayers: 2, password: '' }, r))
const rSpec = await connect()
let rSpecTok = null
rSpec.on('room-token', (d) => (rSpecTok = d.token))
await new Promise((r) => rSpec.emit('join-room', { extra: extra('r2', 'p1'), password: '' }, r))
await sleep(80)
// p1 先主动下场当观众，再进来一个玩家 p2，此时插入顺序是 p0, p1(观众), p2(玩家)
const toSpec = await fetch(`${base}/api/netplay/rooms/r2/role`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-netplay-token': rSpecTok }, body: JSON.stringify({ role: 'spectator' }),
})
ok(toSpec.ok, 'p1 先下场当观众')
const rP2 = await connect()
let usersAfter = null
rP2.on('users-updated', (u) => (usersAfter = u))
await new Promise((r) => rP2.emit('join-room', { extra: extra('r2', 'p2'), password: '' }, r))
await sleep(80)
const idxBefore = Object.keys(usersAfter).indexOf('p2')
// p1 再上场：不应该动 p2 的下标
await fetch(`${base}/api/netplay/rooms/r2/role`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-netplay-token': rSpecTok }, body: JSON.stringify({ role: 'player' }),
})
await sleep(120)
const idxAfter = Object.keys(usersAfter).indexOf('p2')
ok(idxBefore === 1 && idxAfter === 1, `观众上场后 p2 的手柄号不变（${idxBefore} -> ${idxAfter}）`)
ok(Object.keys(usersAfter).indexOf('p1') === 2, '新上场的人排在玩家组末尾')
rHost.close(); rSpec.close(); rP2.close()
void rHostTok

console.log('\n── 第三批：跨房间注入 ──')
/**
 * socket.io 里每条连接都自动在一个以自己 socket.id 命名的房间里，nsp.to(socketId) 靠它点对点投递。
 * 房间 id 是客户端给的 —— 把 sessionid 填成别人的 socket.id（users-updated 会把全屋 socketId
 * 广播给每个成员，观众也拿得到），以前就等于加入了那个人的私有房间：他「自己房间」里的
 * users-updated / data-message 全投到受害者身上，实测能远程 restart 别人的游戏、灌 sync-control。
 */
const victimMsgs = []
const victimUsers = []
host.on('data-message', (d) => victimMsgs.push(d))
host.on('users-updated', (u) => victimUsers.push(u))
const squat = await connect()
const squatAck = await new Promise((r) => squat.emit('open-room', { extra: extra(host.id, 'u-squat'), maxPlayers: 2, password: '' }, r))
await sleep(80)
squat.emit('data-message', { restart: true, 'sync-control': [{ frame: 1, connected_input: [0, 8, 1] }] })
await sleep(150)
ok(squatAck == null || typeof squatAck === 'string', '用别人的 socket.id 当房间 id 开房（服务端可以放行也可以拒）')
ok(!victimMsgs.some((d) => d.restart || d['sync-control']), '别的房间的控制消息投不到这条连接上')
ok(!victimUsers.some((u) => u['u-squat']), '别的房间的成员表投不到这条连接上')
squat.close()
await sleep(80)

console.log('\n── 第三批：整数形 userid / 非法 id ──')
/**
 * "7" 这类字串当对象键会被 JS 排到最前面，users-updated 的键序一乱，屋里每个人的
 * getUserIndex() 都错位：房主从 0 变 1，正常访客的按键和服务端 playerIndexOf 对不上被全丢。
 */
const seven = await connect()
ok((await new Promise((r) => seven.emit('join-room', { extra: extra('r1', '7'), password: '' }, (e) => r(e)))) === 'bad userid', '整数形 userid 进房被拒')
ok((await new Promise((r) => seven.emit('open-room', { extra: extra('r-int', '12345'), maxPlayers: 2 }, r))) === 'bad userid', '整数形 userid 开房被拒')
ok((await new Promise((r) => seven.emit('open-room', { extra: extra('bad id/with spaces', 'u-x'), maxPlayers: 2 }, r))) === 'bad request', '房间 id 只许字母数字下划线短横线')
ok((await new Promise((r) => seven.emit('open-room', { extra: 'not-an-object', maxPlayers: 2 }, r))) === 'bad request', 'extra 不是对象直接拒，不抛')
seven.close()
let orderSeen = null
host.on('users-updated', (u) => (orderSeen = Object.keys(u)))
const dash = await connect()
await new Promise((r) => dash.emit('join-room', { extra: extra('r1', 'u-dash-9'), password: '' }, r))
await sleep(100)
ok(orderSeen && orderSeen[0] === 'u-host', `正常 id 进房后房主仍排第一（${orderSeen?.join(',')}）`)
dash.close()
await sleep(80)

console.log('\n── 第三批：畸形 payload 不转发 ──')
// 引擎的 dataMessage(t) 直接读 t.pause、t["sync-control"].forEach —— null / 字串 / 数组 / 非数组的 sync-control 都会让屋里每个人抛 TypeError
hostGot.length = 0
guest.emit('data-message', null)
guest.emit('data-message', 'hello')
guest.emit('data-message', [1, 2])
guest.emit('data-message', { 'sync-control': { frame: 1 } })
guest.emit('data-message', { 'sync-control': 'x', chat: 'keep me' })
await sleep(150)
ok(!hostGot.some((d) => d === null || typeof d !== 'object' || Array.isArray(d)), '非对象 payload 一律丢掉')
ok(!hostGot.some((d) => d && 'sync-control' in d), '非数组的 sync-control 被摘掉')
ok(hostGot.some((d) => d && d.chat === 'keep me'), '同包里的其它字段照常')
guestGot.length = 0
host.emit('data-message', { 'sync-control': { frame: 1 }, chat: 'host says' })
await sleep(150)
ok(guestGot.some((d) => d.chat === 'host says') && !guestGot.some((d) => 'sync-control' in d), '房主发的畸形 sync-control 同样被摘掉')
guest.emit('webrtc-signal', 'not-an-object')
guest.emit('webrtc-signal', null)
await sleep(80)
ok(true, '畸形 webrtc-signal 不抛（服务器还活着）')

console.log('\n── 第三批：公开列表不放大 ──')
const bloat = await connect()
await new Promise((r) => bloat.emit('open-room', { extra: { ...extra('r-bloat', 'u-bloat'), game_id: { junk: 'x'.repeat(5000) }, player_name: 'N'.repeat(5000), custom: 'y'.repeat(5000) }, maxPlayers: 2 }, r))
await sleep(80)
const bloatRoom = await (await fetch(`${base}/api/netplay/rooms/r-bloat`)).json()
ok(bloatRoom.gameId === null, 'game_id 不是数字 / 短字串就丢掉（对象不进列表）')
ok(bloatRoom.host.nickname.length <= 32 && bloatRoom.members[0].nickname.length <= 32, '昵称截到 32')
let bloatUsers = null
const bloatPeer = await connect()
await new Promise((r) => bloatPeer.emit('join-room', { extra: extra('r-bloat', 'u-bloat-2'), password: '' }, (e, u) => { bloatUsers = u; r() }))
ok(bloatUsers && !('custom' in bloatUsers['u-bloat']) && bloatUsers['u-bloat'].player_name.length <= 32, 'users-updated 只带引擎会读的字段、昵称截断')
ok(bloatUsers && !('ip' in bloatUsers['u-bloat']) && !('token' in bloatUsers['u-bloat']), 'users-updated 不泄露 ip / 令牌')
bloat.close(); bloatPeer.close()
await sleep(80)

console.log('\n── 第三批：信令限流 ──')
let sigGot = 0
host.on('webrtc-signal', (d) => { if (d.candidate === 'flood') sigGot++ })
for (let i = 0; i < 80; i++) guest.emit('webrtc-signal', { target: host.id, candidate: 'flood' })
await sleep(250)
ok(sigGot > 0 && sigGot <= 40, `访客每秒最多 40 条信令（收到 ${sigGot}）`)
await sleep(1100)
let renegGot = 0
host.on('webrtc-signal', (d) => { if (d.requestRenegotiate) renegGot++ })
for (let i = 0; i < 12; i++) guest.emit('webrtc-signal', { target: host.id, requestRenegotiate: true })
await sleep(250)
ok(renegGot > 0 && renegGot <= 5, `requestRenegotiate 每 10 秒最多 5 条（收到 ${renegGot}）`)

console.log('\n── 第三批：同一 IP 占不满一屋 ──')
process.env.NETPLAY_MAX_MEMBERS_PER_IP = '2'
const capHost = await connect()
await new Promise((r) => capHost.emit('open-room', { extra: extra('r-cap', 'u-cap-h'), maxPlayers: 4 }, r))
const capG1 = await connect()
const capE1 = await new Promise((r) => capG1.emit('join-room', { extra: extra('r-cap', 'u-cap-1'), password: '' }, (e) => r(e)))
const capG2 = await connect()
const capE2 = await new Promise((r) => capG2.emit('join-room', { extra: extra('r-cap', 'u-cap-2'), password: '' }, (e) => r(e)))
ok(capE1 == null, '同一 IP 第 2 个成员能进（房主算第 1 个）')
ok(capE2 === 'too many players from your network', '同一 IP 超过上限被拒')
process.env.NETPLAY_MAX_MEMBERS_PER_IP = '0'
capHost.close(); capG1.close(); capG2.close()
await sleep(80)

console.log('\n── 第三批：存档预算 ──')
const big = await fetch(`${base}/api/netplay/rooms/r1/state`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-netplay-token': hostToken }, body: Buffer.alloc(100, 1) })
ok(big.status === 507, `超出总预算的存档被拒（${big.status}）`)
ok((await put(hostToken)).ok, '预算内的照常')

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
