/**
 * 观众席（直播）的回归测试。不需要浏览器、不需要数据库。
 *
 *   cd server && node scripts/test-spectator.mjs
 *
 * 覆盖：手柄位满了自动转观众 / 观众不占 current / 玩家↔观众互切 /
 * 房主不能变观众 / 没令牌改不了别人 / 观众席也有上限 / 换房主优先找玩家。
 *
 * 注意：房间表是模块级的，同一进程共用一份，所以断言都针对具体房间 id。
 */
import express from 'express'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'
import { testGameRoomPolicy } from './helpers/netplay-game-policy.mjs'
// 12 个观众全从 127.0.0.1 进来：每房间每 IP 的成员上限要关掉（那条规则在 test-netplay-hardening.mjs 里测）
process.env.NETPLAY_MAX_MEMBERS_PER_IP = '0'
const { attachNetplay } = await import('../src/netplay.js')

let failed = 0
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (name, cond) => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
const section = (title) => console.log(`\n── ${title} ──`)

const app = express()
const http = createServer(app)
attachNetplay(http, app, ['*'], { resolveGamePolicy: testGameRoomPolicy })
await new Promise((r) => http.listen(9931, r))
const WS = 'http://127.0.0.1:9931/netplay'
const API = 'http://127.0.0.1:9931'

/** 连上并记住服务端下发的房间令牌（切身份要用它证明「我是房里的人」） */
const connect = async () => {
  const s = client(WS)
  await new Promise((r) => s.on('connect', r))
  s.on('room-token', (m) => (s.roomToken = m.token))
  return s
}
const extra = (userid, sessionid, name, gameId = 77) => ({
  domain: 'localhost',
  game_id: gameId,
  room_name: '魂斗罗',
  player_name: name,
  userid,
  sessionid,
})
const open = (sock, ex, max = 2) =>
  new Promise((r) => sock.emit('open-room', { extra: ex, maxPlayers: max, password: '' }, r))
const join = (sock, ex) =>
  new Promise((r) => sock.emit('join-room', { extra: ex, password: '' }, (e, u) => r([e, u])))
const getJson = async (p) => (await fetch(API + p)).json()
const setRole = (roomId, token, role) =>
  fetch(`${API}/api/netplay/rooms/${roomId}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-netplay-token': token } : {}) },
    body: JSON.stringify({ role }),
  })

/* ============ 一、满员自动转观众 ============ */
section('满员自动转观众')
const host = await connect()
const p2 = await connect()
const v1 = await connect()
await open(host, extra('s-host', 'S1', '房主'), 2)
await join(p2, extra('s-p2', 'S1', '二号'))
const seen = {}
host.on('users-updated', (u) => (seen.users = u))
const [err3, users3] = await join(v1, extra('s-v1', 'S1', '路人甲'))
await wait(60)

ok('手柄位满了不再拒绝', err3 == null)
ok('第 3 个人自动成为观众', users3?.['s-v1']?.role === 'spectator')
ok('前两位仍是玩家', users3?.['s-host']?.role === 'player' && users3?.['s-p2']?.role === 'player')

let room = await getJson('/api/netplay/rooms/S1')
ok('players 不含观众', room.players === 2)
ok('spectators 数对得上', room.spectators === 1)
ok('下发了观众席上限', typeof room.maxSpectators === 'number' && room.maxSpectators > 0)
ok('members 每人都带 role', room.members.every((m) => m.role === 'player' || m.role === 'spectator'))

let list = await getJson('/netplay/list?domain=localhost&game_id=77')
ok('手柄位坐满的房间不列在可加入列表里', !list.S1)

// 有观众但手柄位没坐满的房间，必须照常列出来 —— 否则观众一多就没人能进来玩了
const h3 = await connect()
const w3 = await connect()
await open(h3, extra('s-h3', 'S3', '房主3'), 3)
await join(w3, extra('s-w3', 'S3', '看客3'))
await wait(30)
await setRole('S3', w3.roomToken, 'spectator')
await wait(40)
list = await getJson('/netplay/list?domain=localhost&game_id=77')
ok('有观众、手柄位没满的房间照常列出', Boolean(list.S3))
ok('列表里的 current 只数玩家', list.S3?.current === 1)
h3.close()
w3.close()

/* ============ 二、身份互切 ============ */
section('身份互切')
ok('玩家可以主动退到观众席', (await setRole('S1', p2.roomToken, 'spectator')).ok)
await wait(40)
room = await getJson('/api/netplay/rooms/S1')
ok('退下之后手柄位空出来了', room.players === 1 && room.spectators === 2)

// 观众上场要房主点头：先挂申请，房主那边收到 seat-request
const asks = []
const cancels = []
host.on('seat-request', (m) => asks.push(m))
host.on('seat-request-cancel', (m) => cancels.push(m))
const v1Decisions = []
v1.on('seat-decision', (m) => v1Decisions.push(m))
const decide = (roomId, token, userid, approve) =>
  fetch(`${API}/api/netplay/rooms/${roomId}/seat-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-netplay-token': token } : {}) },
    body: JSON.stringify({ userid, approve }),
  })
{
  const r = await setRole('S1', v1.roomToken, 'player')
  const body = await r.json()
  ok('观众申请上场先挂起（202 pending）', r.status === 202 && body.pending === true && body.expiresIn > 0)
  await wait(40)
  room = await getJson('/api/netplay/rooms/S1')
  ok('房主答复之前角色不变', room.players === 1)
  ok('房主收到带名字的上场申请', asks.length === 1 && asks[0].userid === 's-v1' && asks[0].name === '路人甲')
  ok('重复申请不会再弹一次', (await setRole('S1', v1.roomToken, 'player')).status === 202 && (await wait(30), asks.length === 1))
  ok('非房主不能替房主答复', (await decide('S1', p2.roomToken, 's-v1', true)).status === 403)
  // 拒绝 → 观众收到 rejected，冷却期内不能马上再申请
  ok('房主可以拒绝', (await (await decide('S1', host.roomToken, 's-v1', false)).json()).approved === false)
  await wait(40)
  ok('观众收到拒绝结果', v1Decisions.at(-1)?.approved === false && v1Decisions.at(-1)?.reason === 'rejected')
  ok('拒绝后房主那张卡片被收起', cancels.some((m) => m.userid === 's-v1'))
  ok('拒绝后冷却期内不能马上再申请', (await setRole('S1', v1.roomToken, 'player')).status === 429)
  // 等过冷却（测试把冷却调短），再申请、等它超时
  await wait(Number(process.env.NETPLAY_SEAT_REQUEST_COOLDOWN_MS || 5000) + 20)
  ok('冷却过后可以再申请', (await setRole('S1', v1.roomToken, 'player')).status === 202)
  await wait(Number(process.env.NETPLAY_SEAT_REQUEST_MS || 15000) + 60)
  ok('房主不答复，到点按超时作废', v1Decisions.at(-1)?.reason === 'timeout')
  ok('超时后同意已经没有用了', (await decide('S1', host.roomToken, 's-v1', true)).status === 404)
  await wait(Number(process.env.NETPLAY_SEAT_REQUEST_COOLDOWN_MS || 5000) + 20)
  ok('再申请一次', (await setRole('S1', v1.roomToken, 'player')).status === 202)
  ok('房主同意', (await (await decide('S1', host.roomToken, 's-v1', true)).json()).approved === true)
  await wait(40)
  ok('观众收到同意结果', v1Decisions.at(-1)?.approved === true)
}
room = await getJson('/api/netplay/rooms/S1')
ok('上场后计到玩家里', room.players === 2 && room.spectators === 1)

// EmulatorJS 用 Object.keys(users).indexOf(自己) 当手柄号，所以玩家必须排在观众前面，
// 否则后来上场的人会拿到一个游戏里根本不存在的手柄位
{
  const keys = Object.keys(seen.users ?? {})
  const roomNow = await getJson('/api/netplay/rooms/S1')
  const playerIds = roomNow.members.filter((m) => m.role !== 'spectator').map((m) => m.nickname)
  ok('users-updated 把玩家排在观众前面', keys.slice(0, roomNow.players).length === roomNow.players &&
    keys.slice(0, roomNow.players).every((id) => id === 's-host' || id === 's-v1'))
  ok('上场的人拿到的手柄号在范围内', playerIds.length === roomNow.players)
}

ok('房主不能变观众（游戏跑在他机器上）', (await setRole('S1', host.roomToken, 'spectator')).status === 409)
ok('没令牌改不了身份', (await setRole('S1', '', 'spectator')).status === 403)
ok('别人的令牌只能改自己', (await setRole('S1', 'not-a-real-token', 'player')).status === 403)

// 位子满了就上不去
ok('手柄位满了上不了场', (await setRole('S1', p2.roomToken, 'player')).status === 409)

/* ============ 三、观众席也有上限 ============ */
section('观众席上限')
const cap = (await getJson('/api/netplay/rooms/S1')).maxSpectators
const extras = []
for (let i = 0; i < cap + 1; i++) {
  const s = await connect()
  extras.push(s)
  var last = await join(s, extra(`s-x${i}`, 'S1', `观众${i}`))
}
await wait(60)
room = await getJson('/api/netplay/rooms/S1')
ok('观众数不会超过上限', room.spectators <= cap)
ok('坐满之后才真的拒绝', last[0] === 'room is full')

/* ============ 四、换房主优先找玩家 ============ */
section('换房主优先找玩家')
const h2 = await connect()
const spec = await connect()
const player = await connect()
await open(h2, extra('t-host', 'S2', '房主2'), 3)
await join(spec, extra('t-spec', 'S2', '看客'))
await wait(30)
await setRole('S2', spec.roomToken, 'spectator')
await join(player, extra('t-player', 'S2', '玩家'))
await wait(40)

let nextHost = null
const grab = (m) => {
  if (m['host-migrating']) nextHost = m['host-migrating'].nextHostUserId ?? m['host-migrating'].userId
}
spec.on('data-message', grab)
player.on('data-message', grab)
h2.close()
await wait(200)
const s2 = await getJson('/api/netplay/rooms/S2')
ok('房间没有立刻解散', s2.awaitingHost === true)
ok('挑的是玩家而不是观众', (s2.nextHostUserId ?? nextHost) === 't-player')

/* ============ 五、说明只看的人进房就是观众 ============ */
section('以观众身份进房')
const h4 = await connect()
const w4 = await connect()
const h4asks = []
h4.on('seat-request', (m) => h4asks.push(m))
await open(h4, extra('u-host', 'S4', '房主4'), 2)
await join(w4, { ...extra('u-watch', 'S4', '看客4'), role: 'spectator' })
await wait(40)
let s4 = await getJson('/api/netplay/rooms/S4')
ok('带 role=spectator 进房，手柄位没满也只当观众', s4.players === 1 && s4.spectators === 1)
ok('观众想上场同样要申请', (await setRole('S4', w4.roomToken, 'player')).status === 202)
await wait(40)
ok('房主收到申请', h4asks.length === 1)
w4.close()
await wait(60)
ok('申请人走了，申请随之作废', (await decide('S4', h4.roomToken, 'u-watch', true)).status === 404)
h4.close()

for (const s of [host, p2, v1, spec, player, ...extras]) s.close()
console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
