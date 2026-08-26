/**
 * P2P 联机信令服务器的回归测试（不需要浏览器、不需要数据库）。
 *
 *   cd server && npm install
 *   node scripts/test-netplay.mjs                          # 跳过「超时解散」那组
 *   NETPLAY_HOST_GRACE_MS=400 node scripts/test-netplay.mjs # 全跑
 *
 * 覆盖 EmulatorJS netplay 客户端真正会用到的那套协议，以及我们自己加的房主迁移：
 * 开房 / 加入 / 房间列表 / 信令定向转发 / 满员 / 密码 / 离开 /
 * 存档托管 / 房主掉线选新房主 / 迁移后老邀请链接仍有效 / 超时解散 / 跨房间信令隔离。
 *
 * 注意：房间表是模块级的，同一个进程里所有 attachNetplay 共用一份 —— 所以断言要针对
 * 具体房间，不要断言「整个列表为空」。生产环境只 attach 一次，不受影响。
 */
import express from 'express'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'
import { attachNetplay } from '../src/netplay.js'

let failed = 0
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (name, cond) => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
const section = (title) => console.log(`\n── ${title} ──`)

const app = express()
const http = createServer(app)
attachNetplay(http, app, ['*'])
await new Promise((r) => http.listen(9921, r))
const WS = 'http://127.0.0.1:9921/netplay'
const API = 'http://127.0.0.1:9921'

const connect = async () => {
  const s = client(WS)
  await new Promise((r) => s.on('connect', r))
  return s
}
/** netplay.js 里 extra 的结构，字段名必须和它一致 */
const extra = (userid, sessionid, name, gameId = 42) => ({
  domain: 'localhost',
  game_id: gameId,
  room_name: '双截龙',
  player_name: name,
  userid,
  sessionid,
})
const open = (sock, ex, max = 2, pw = '') => new Promise((r) => sock.emit('open-room', { extra: ex, maxPlayers: max, password: pw }, r))
const join = (sock, ex, pw = '') => new Promise((r) => sock.emit('join-room', { extra: ex, password: pw }, (e, u) => r([e, u])))
const getJson = async (path) => (await fetch(API + path)).json()

/* ==================== 一、基础协议 ==================== */
section('基础协议')
{
  const host = await connect()
  let hostUsers = null
  host.on('users-updated', (u) => (hostUsers = u))
  ok('开房成功', (await open(host, extra('u-host', 'R1', '房主'))) == null)

  let list = await getJson('/netplay/list?domain=localhost&game_id=42')
  ok('/netplay/list 能查到房间', list.R1?.room_name === '双截龙' && list.R1.current === 1 && list.R1.max === 2)
  list = await getJson('/netplay/list?domain=localhost&game_id=999')
  ok('按 game_id 过滤生效', !list.R1)

  const guest = await connect()
  const [joinErr, users] = await join(guest, extra('u-guest', 'R1', '小明'))
  ok('加入成功', joinErr == null && Object.keys(users).length === 2)
  ok('users 带 socketId（房主靠它建连接）', Boolean(users['u-guest']?.socketId) && Boolean(users['u-host']?.socketId))
  await wait(60)
  ok('房主收到 users-updated', hostUsers && Object.keys(hostUsers).length === 2)

  let relayed = null
  host.on('webrtc-signal', (d) => (relayed = d))
  guest.emit('webrtc-signal', { target: users['u-host'].socketId, offer: { sdp: 'fake' } })
  await wait(80)
  ok('信令转发到指定 socket', relayed?.offer?.sdp === 'fake')
  ok('转发时带上 sender', relayed?.sender === guest.id)

  const third = await connect()
  const [fullErr] = await join(third, extra('u3', 'R1', '路人'))
  ok('满员被拒', fullErr === 'room is full')

  const hostB = await connect()
  await open(hostB, extra('u-b', 'R-pw', '房主B'), 2, 'secret')
  const [pwErr] = await join(third, extra('u4', 'R-pw', '路人'), 'wrong')
  ok('密码错误被拒', pwErr === 'wrong password')

  const mine = await getJson('/api/netplay/rooms')
  const r1 = mine.find((r) => r.roomId === 'R1')
  ok('/api/netplay/rooms 结构正确', r1?.players === 2 && r1.host?.nickname === '房主' && r1.kind === 'p2p' && r1.gameId === 42)

  // 跨房间发信令必须被拒（hostB 在另一个房间）
  let leaked = null
  hostB.on('webrtc-signal', (d) => (leaked = d))
  guest.emit('webrtc-signal', { target: hostB.id, offer: { sdp: 'leak' } })
  await wait(80)
  ok('跨房间信令被拒绝', leaked === null)

  // 只剩房主一个人时离开 = 房间直接消失（没人可迁移）
  const solo = await connect()
  await open(solo, extra('u-solo', 'R-solo', '独狼'))
  solo.close()
  await wait(150)
  ok('房间只有房主时，离开即解散', (await fetch(`${API}/api/netplay/rooms/R-solo`)).status === 404)

  host.close()
  guest.close()
  third.close()
  hostB.close()
  await wait(150)
}

/* ==================== 二、房主迁移 ==================== */
section('房主迁移')
{
  const host = await connect()
  const g1 = await connect()
  const g2 = await connect()
  await open(host, extra('u-host2', 'R2', '房主'), 4)
  await join(g1, extra('u-g1', 'R2', '小明'))
  await join(g2, extra('u-g2', 'R2', '小红'))

  const state = Buffer.from('SAVESTATE-'.repeat(1000))
  let r = await fetch(`${API}/api/netplay/rooms/R2/state`, {
    method: 'POST',
    headers: { 'x-netplay-user': 'u-host2', 'content-type': 'application/octet-stream' },
    body: state,
  })
  ok('房主能上传存档', r.ok && (await r.json()).bytes === state.length)

  r = await fetch(`${API}/api/netplay/rooms/R2/state`, {
    method: 'POST',
    headers: { 'x-netplay-user': 'u-g1', 'content-type': 'application/octet-stream' },
    body: state,
  })
  ok('非房主上传被拒', r.status === 403)
  ok('房间标记 hasState', (await getJson('/api/netplay/rooms/R2')).hasState === true)

  let migrating = null
  g1.on('data-message', (m) => {
    if (m['host-migrating']) migrating = m['host-migrating']
  })
  host.close()
  await wait(250)
  ok('房主掉线广播 host-migrating', migrating?.nextHost === 'u-g1')

  let d = await getJson('/api/netplay/rooms/R2')
  ok('房间没被解散，转为 awaitingHost', d.awaitingHost === true && d.nextHostUserId === 'u-g1' && d.players === 2)
  ok('换房主期间不出现在可加入列表', !(await getJson('/netplay/list?domain=localhost&game_id=42')).R2)

  r = await fetch(`${API}/api/netplay/rooms/R2/state`)
  ok('新房主能取到存档', r.ok && Buffer.from(await r.arrayBuffer()).equals(state))

  // 新房主开一个新房间，再把新旧接上
  const newHost = await connect()
  await open(newHost, extra('u-g1', 'R2b', '小明'), 4)
  r = await fetch(`${API}/api/netplay/rooms/R2/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newRoomId: 'R2b', userId: 'u-g1' }),
  })
  ok('迁移成功', r.ok && (await r.json()).roomId === 'R2b')

  d = await getJson('/api/netplay/rooms/R2')
  ok('旧 roomId 仍能查到，并给出 migratedTo', d.roomId === 'R2b' && d.migratedTo === 'R2b')
  r = await fetch(`${API}/api/netplay/rooms/R2/state`)
  ok('存档跟着转移到新房间', r.ok && Buffer.from(await r.arrayBuffer()).equals(state))

  const g3 = await connect()
  const [joinErr] = await join(g3, extra('u-g3', 'R2', '小刚'))
  ok('用旧邀请链接能加入新房间', joinErr == null && (await getJson('/api/netplay/rooms/R2b')).players === 2)

  const faker = await connect()
  await open(faker, extra('u-fake', 'R-fake', '坏人'))
  r = await fetch(`${API}/api/netplay/rooms/R2b/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newRoomId: 'R-fake', userId: 'u-fake' }),
  })
  ok('非选定房主接手被拒', r.status === 409 || r.status === 403)

  g1.close()
  g2.close()
  g3.close()
  newHost.close()
  faker.close()
  await wait(200)
}

/* ==================== 三、没人接手 → 超时解散 ==================== */
if (process.env.NETPLAY_HOST_GRACE_MS) {
  section(`没人接手就解散（宽限期 ${process.env.NETPLAY_HOST_GRACE_MS}ms）`)
  const host = await connect()
  const guest = await connect()
  await open(host, extra('u-h3', 'R3', '房主'))
  await join(guest, extra('u-g4', 'R3', '访客'))

  let hostLeft = false
  guest.on('data-message', (m) => {
    if (m['host-left']) hostLeft = true
  })
  host.close()
  await wait(Number(process.env.NETPLAY_HOST_GRACE_MS) + 400)
  ok('超时没人接手 → 广播 host-left', hostLeft)
  ok('超时后房间被解散', (await fetch(`${API}/api/netplay/rooms/R3`)).status === 404)
  guest.close()
} else {
  console.log('\n⏭  跳过「超时解散」：用 NETPLAY_HOST_GRACE_MS=400 node scripts/test-netplay.mjs 跑这一组')
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
