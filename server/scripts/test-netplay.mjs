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
// 这个测试从同一个 IP 开一堆房间，把每 IP 上限关掉（那条规则在 test-netplay-hardening.mjs 里测）
process.env.NETPLAY_MAX_ROOMS_PER_IP = '0'
// 同理：所有连接都来自 127.0.0.1，每房间每 IP 的成员上限也要关掉
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
attachNetplay(http, app, ['*'])
await new Promise((r) => http.listen(9921, r))
const WS = 'http://127.0.0.1:9921/netplay'
const API = 'http://127.0.0.1:9921'

const connect = async () => {
  const s = client(WS)
  // 服务端在 ack 之后紧接着发的房间令牌，存档 / 认领 / 迁移都靠它
  s.token = null
  s.on('room-token', (d) => (s.token = d.token))
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

  // 手柄位满了不再拒人，改成让他进来当观众（见 netplay.js 的 join-room）
  const third = await connect()
  const [fullErr, fullUsers] = await join(third, extra('u3', 'R1', '路人'))
  ok('手柄位满了改成当观众进来', fullErr == null && fullUsers?.['u3']?.role === 'spectator')
  ok('原有两位仍是玩家', fullUsers?.['u-host']?.role !== 'spectator' && fullUsers?.['u-guest']?.role !== 'spectator')

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
  await wait(80)

  const state = Buffer.from('SAVESTATE-'.repeat(1000))
  let r = await fetch(`${API}/api/netplay/rooms/R2/state`, {
    method: 'POST',
    headers: { 'x-netplay-token': host.token, 'content-type': 'application/octet-stream' },
    body: state,
  })
  ok('房主能上传存档', r.ok && (await r.json()).bytes === state.length)

  r = await fetch(`${API}/api/netplay/rooms/R2/state`, {
    method: 'POST',
    headers: { 'x-netplay-token': g1.token, 'content-type': 'application/octet-stream' },
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

  // 没被选中的人不能认领
  r = await fetch(`${API}/api/netplay/rooms/R2/claim`, { method: 'POST', headers: { 'x-netplay-token': g2.token } })
  ok('非选定者认领被拒', r.status === 403)
  r = await fetch(`${API}/api/netplay/rooms/R2/claim`, { method: 'POST', headers: { 'x-netplay-token': 'nope' } })
  ok('假令牌认领被拒', r.status === 403)

  // 被选中的人认领
  r = await fetch(`${API}/api/netplay/rooms/R2/claim`, { method: 'POST', headers: { 'x-netplay-token': g1.token } })
  const claim = r.ok ? (await r.json()).claimToken : null
  ok('选定者认领成功', typeof claim === 'string' && claim.length > 20)
  ok('房间标记 claimed', (await getJson('/api/netplay/rooms/R2')).claimed === true)

  // 真实流程：认领之后新房主要重新挂载引擎，旧连接必断 —— 房间不能因此散掉或换人
  g1.close()
  await wait(250)
  d = await getJson('/api/netplay/rooms/R2')
  ok('认领人断线后房间还在、仍等他接手', d && d.awaitingHost === true && d.nextHostUserId === 'u-g1' && d.claimed === true)

  // 存档：凭认领令牌能取（他已经不是成员了），随便一个令牌不能
  r = await fetch(`${API}/api/netplay/rooms/R2/state`, { headers: { 'x-netplay-token': claim } })
  ok('新房主凭认领令牌取到存档', r.ok && Buffer.from(await r.arrayBuffer()).equals(state))
  r = await fetch(`${API}/api/netplay/rooms/R2/state`, { headers: { 'x-netplay-token': 'nope' } })
  ok('假令牌取不到存档', r.status === 403)

  // 新房主开一个新房间，再凭 认领令牌 + 新房间令牌 把新旧接上
  const newHost = await connect()
  await open(newHost, extra('u-g1', 'R2b', '小明'), 4)
  await wait(80)
  const migrate = (body, tokenHeader) =>
    fetch(`${API}/api/netplay/rooms/R2/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tokenHeader ? { 'x-netplay-token': tokenHeader } : {}) },
      body: JSON.stringify(body),
    })
  // 以前的攻击面：只填 userId 就能把整屋人劫走
  r = await migrate({ newRoomId: 'R2b', userId: 'u-g1' })
  ok('只带 userId 的迁移被拒', r.status === 403)
  r = await migrate({ newRoomId: 'R2b', newRoomToken: newHost.token }, g2.token)
  ok('拿成员令牌冒充认领被拒', r.status === 403)
  r = await migrate({ newRoomId: 'R2b', newRoomToken: 'nope' }, claim)
  ok('新房间令牌不对被拒', r.status === 403)

  let migrated = null
  g2.on('data-message', (m) => {
    if (m['host-migrated']) migrated = m['host-migrated']
  })
  r = await migrate({ newRoomId: 'R2b', newRoomToken: newHost.token }, claim)
  ok('迁移成功', r.ok && (await r.json()).roomId === 'R2b')
  await wait(100)
  ok('留在旧房间的人收到 host-migrated', migrated?.roomId === 'R2b')

  d = await getJson('/api/netplay/rooms/R2')
  ok('旧 roomId 仍能查到，并给出 migratedTo', d.roomId === 'R2b' && d.migratedTo === 'R2b')
  r = await fetch(`${API}/api/netplay/rooms/R2/state`, { headers: { 'x-netplay-token': newHost.token } })
  ok('存档跟着转移到新房间', r.ok && Buffer.from(await r.arrayBuffer()).equals(state))

  const g3 = await connect()
  const [joinErr] = await join(g3, extra('u-g3', 'R2', '小刚'))
  ok('用旧邀请链接能加入新房间', joinErr == null && (await getJson('/api/netplay/rooms/R2b')).players === 2)

  // 别名占着的 id 不能再被新房间用（否则谁也进不去那个新房间）
  const squatter = await connect()
  ok('别名占用的 id 不能开新房', (await open(squatter, extra('u-sq', 'R2', '占坑'))) === 'room already exists')

  const faker = await connect()
  await open(faker, extra('u-fake', 'R-fake', '坏人'))
  r = await fetch(`${API}/api/netplay/rooms/R2b/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newRoomId: 'R-fake', userId: 'u-fake' }),
  })
  ok('非选定房主接手被拒', r.status === 409 || r.status === 403)

  g2.close()
  g3.close()
  newHost.close()
  faker.close()
  squatter.close()
  await wait(200)
}

/* ==================== 二·五、双人房：唯一的访客接手 ==================== */
section('双人房接手（认领人断线时屋里没人）')
{
  const host = await connect()
  const g1 = await connect()
  await open(host, extra('u-hostD', 'RD', '房主'), 2)
  await join(g1, extra('u-gD', 'RD', '小明'))
  await wait(80)
  host.close()
  await wait(200)
  let r = await fetch(`${API}/api/netplay/rooms/RD/claim`, { method: 'POST', headers: { 'x-netplay-token': g1.token } })
  const claim = r.ok ? (await r.json()).claimToken : null
  ok('唯一的访客认领成功', Boolean(claim))
  g1.close()
  await wait(250)
  // 以前：屋里 0 人 → 立刻解散 → /migrate 409 → 老邀请链接死掉
  ok('屋里一个人都没有也不散场', (await fetch(`${API}/api/netplay/rooms/RD`)).status === 200)
  const nh = await connect()
  await open(nh, extra('u-gD', 'RDb', '小明'), 2)
  await wait(80)
  r = await fetch(`${API}/api/netplay/rooms/RD/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-netplay-token': claim },
    body: JSON.stringify({ newRoomId: 'RDb', newRoomToken: nh.token }),
  })
  ok('迁移成功，老链接续上', r.ok && (await getJson('/api/netplay/rooms/RD')).migratedTo === 'RDb')
  nh.close()
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
  /**
   * 散场之后访客的连接还在（他的引擎不会自己断）。以前他会一直留在 socket.io 那个房间名下，
   * 谁再用同一个 id（列表 / 邀请链接里公开出现过）开一间新房，广播就原样投给他 ——
   * 实测能把他的成员表换掉、给他发 restart。现在 destroyRoom 会把残留连接一并请出去。
   */
  const staleUsers = []
  const staleMsgs = []
  guest.on('users-updated', (u) => staleUsers.push(u))
  guest.on('data-message', (m) => staleMsgs.push(m))
  const squatter = await connect()
  ok('散场后同一个 id 可以再开（别名已清）', (await open(squatter, extra('u-sq', 'R3', '占位'))) == null)
  squatter.emit('data-message', { restart: true })
  await wait(200)
  ok('老访客收不到新房间的成员表', staleUsers.length === 0)
  ok('老访客收不到新房间的控制消息', staleMsgs.length === 0)
  squatter.close()
  guest.close()

  if (process.env.NETPLAY_CLAIM_WINDOW_MS) {
    section(`认领了却没接完（窗口 ${process.env.NETPLAY_CLAIM_WINDOW_MS}ms）`)
    const h = await connect()
    const g = await connect()
    await open(h, extra('u-h5', 'R5', '房主'))
    await join(g, extra('u-g5', 'R5', '访客'))
    await wait(80)
    h.close()
    await wait(150)
    const r = await fetch(`${API}/api/netplay/rooms/R5/claim`, { method: 'POST', headers: { 'x-netplay-token': g.token } })
    ok('认领成功', r.ok)
    g.close()
    await wait(Number(process.env.NETPLAY_CLAIM_WINDOW_MS) + 300)
    ok('认领窗口过了、屋里没人 → 解散', (await fetch(`${API}/api/netplay/rooms/R5`)).status === 404)
  }

  {
    /**
     * 认领了却没接完，但**屋里还有别人** → 应该轮给下一位，不是把房间解散。
     *
     * 曾经必然解散：CLAIM_WINDOW_MS（线上默认 60s）比 HOST_GRACE_MS（默认 30s）长，
     * 等认领窗口过期，offerNext 开头那句「宽限期到了没」必然成立 ——
     * 于是不管还坐着几个人，房间当场散场，名单上的下一位从来没被问过。
     * 现在认领占用的时间会从宽限期里扣掉。
     */
    section('认领了却没接完、但屋里还有人 → 轮给下一位')
    const h = await connect()
    const g1 = await connect()
    const g2 = await connect()
    await open(h, extra('u-h6', 'R6', '房主'))
    await join(g1, extra('u-g6a', 'R6', '访客一'))
    await join(g2, extra('u-g6b', 'R6', '访客二'))
    await wait(80)
    h.close()
    await wait(150)
    // 记下服务器问过哪些人。断言看的是「有没有问到第二位」，
    // 不看某一刻房间还在不在 —— 宽限期在测试里只有几百毫秒，
    // 轮到第二位之后它照样会正常到点散场，那不是这条要验的东西
    const offered = []
    g2.on('data-message', (d) => {
      if (d && d['host-migrating']) offered.push(d['host-migrating'].nextHost)
    })
    const claimed = await fetch(`${API}/api/netplay/rooms/R6/claim`, { method: 'POST', headers: { 'x-netplay-token': g1.token } })
    ok('第一位认领成功', claimed.ok)
    // 认领之后一直不 migrate，等窗口过期
    await wait(Number(process.env.NETPLAY_CLAIM_WINDOW_MS) + 300)
    ok('认领超时后轮到了下一位候选', offered.includes('u-g6b'))
    g1.close()
    g2.close()
  }
} else {
  console.log('\n⏭  跳过「超时解散」：用 NETPLAY_HOST_GRACE_MS=400 node scripts/test-netplay.mjs 跑这一组')
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
