/**
 * 直播信令的端到端测试：起一个真的 http server + socket.io，
 * 用主播 / 观众两个客户端跑一遍完整流程。
 */
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client } from 'socket.io-client'
// 宽限期和每 IP 上限都是模块加载时读的环境变量，所以要先设好再 import
process.env.LIVE_RESUME_GRACE_MS = '400'
process.env.LIVE_MAX_ROOMS_PER_IP = '3'
const { attachLive, liveRooms, liveRoom } = await import('../src/live.js')

const http = createServer()
const server = new Server(http, { cors: { origin: true } })
attachLive(server)
await new Promise((r) => http.listen(0, r))
const url = `http://127.0.0.1:${http.address().port}/live`
const conn = () => client(url, { transports: ['websocket'], forceNew: true })
const call = (s, ev, arg) => new Promise((res) => s.emit(ev, arg, (err, data) => res({ err, data })))
const once = (s, ev, ms = 2000) =>
  new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`超时: ${ev}`)), ms); s.once(ev, (d) => { clearTimeout(t); res(d) }) })
const ok = []
const bad = []
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' — ' + extra : ''}`)

// 1. 开播
const host = conn()
await once(host, 'connect')
const live = await call(host, 'go-live', { title: '塞尔达传说', gameSlug: 'zelda-gba', gameName: 'Zelda', platform: 'gba', hostName: 'Ryu' })
check('开播', !live.err && live.data?.roomId, live.err || '')
const roomId = live.data.roomId

// 2. 列表 / 详情
check('房间列表', liveRooms().length === 1 && liveRooms()[0].title === '塞尔达传说')
check('按游戏过滤', liveRooms({ gameSlug: 'zelda-gba' }).length === 1 && liveRooms({ gameSlug: 'other' }).length === 0)
check('房间详情不含令牌', liveRoom(roomId) && liveRoom(roomId).token === undefined)

// 3. 观众进来 -> 主播收到 viewer-joined
const v1 = conn(); await once(v1, 'connect')
const joined = once(host, 'viewer-joined')
const watch = await call(v1, 'watch', { roomId })
check('观众进房', !watch.err && watch.data?.hostId, watch.err || '')
const viewerId = (await joined).viewerId
check('主播拿到观众 id', typeof viewerId === 'string' && viewerId.length > 0)
check('人数广播', (await once(host, 'viewers').catch(() => ({ count: -1 }))) !== null)

// 4. 双向转发握手包
const toViewer = once(v1, 'signal')
host.emit('signal', { target: viewerId, data: { sdp: 'OFFER' } })
const got = await toViewer
check('主播 -> 观众', got?.data?.sdp === 'OFFER' && got.from === host.id)

const toHost = once(host, 'signal')
v1.emit('signal', { target: watch.data.hostId, data: { sdp: 'ANSWER' } })
const got2 = await toHost
check('观众 -> 主播', got2?.data?.sdp === 'ANSWER' && got2.from === v1.id)

// 5. 越权：第三方拿着别人的 id 往里塞包，应该收不到
const v2 = conn(); await once(v2, 'connect')
await call(v2, 'watch', { roomId })
await once(host, 'viewer-joined')
let leaked = false
v1.once('signal', () => { leaked = true })
v2.emit('signal', { target: v1.id, data: { sdp: 'EVIL' } })
await new Promise((r) => setTimeout(r, 200))
check('观众之间不能互发', !leaked)

// 6. 房间外的人不能发
const stranger = conn(); await once(stranger, 'connect')
let leaked2 = false
host.once('signal', () => { leaked2 = true })
stranger.emit('signal', { target: host.id, data: { sdp: 'EVIL' } })
await new Promise((r) => setTimeout(r, 200))
check('房间外不能发', !leaked2)

// 7. 观众离开 -> 主播收到 viewer-left，人数减一
// 先记下 id：close() 之后 socket.io-client 会把 v2.id 清成 undefined
const v2Id = v2.id
const left = once(host, 'viewer-left')
v2.close()
check('观众离开通知', (await left).viewerId === v2Id)
await new Promise((r) => setTimeout(r, 100))
check('人数递减', liveRoom(roomId).viewers === 1, `实际 ${liveRoom(roomId).viewers}`)

// 8. 主播下播 -> 观众收到 live-ended，房间消失
const ended = once(v1, 'live-ended')
host.emit('stop-live')
check('下播通知观众', (await ended).reason === 'stopped')
await new Promise((r) => setTimeout(r, 100))
check('房间已清除', liveRooms().length === 0)

// 9. 主播断线：房间**不**立刻散场，观众收到 host-away，房间标成 hostAway
const host2 = conn(); await once(host2, 'connect')
const l2 = await call(host2, 'go-live', { gameName: 'Metroid', gameSlug: 'metroid' })
const room2 = l2.data.roomId
const token2 = l2.data.token
check('开播拿到续播令牌', typeof token2 === 'string' && token2.length > 20)
const v3 = conn(); await once(v3, 'connect')
await call(v3, 'watch', { roomId: room2 })
await once(host2, 'viewer-joined')
const away = once(v3, 'host-away')
host2.close()
check('主播掉线 -> 观众收到 host-away', (await away).roomId === room2)
check('宽限期内房间还在', liveRoom(room2) !== null && liveRoom(room2).hostAway === true)
check('列表里也还在', liveRooms().length === 1)

// 10. 错的令牌接不回去
const host3 = conn(); await once(host3, 'connect')
const bad1 = await call(host3, 'resume-live', { roomId: room2, token: 'nope' })
check('错令牌续播被拒', bad1.err === 'forbidden')
const bad2 = await call(host3, 'resume-live', { roomId: 'nope', token: token2 })
check('续播不存在的房间', bad2.err === 'not found')

// 11. 对的令牌：接回房间，观众收到 host-back（带新的 hostId），主播拿到观众名单
const back = once(v3, 'host-back')
const res = await call(host3, 'resume-live', { roomId: room2, token: token2 })
check('续播成功', !res.err && res.data?.roomId === room2, res.err || '')
check('主播拿到观众名单', Array.isArray(res.data?.viewers) && res.data.viewers.includes(v3.id))
const b = await back
check('观众收到新的主播 id', b.hostId === host3.id)
check('房间不再是 hostAway', liveRoom(room2).hostAway === false)
check('观众人数没丢', liveRoom(room2).viewers === 1)

// 12. 观众手里拿的是旧主播 id 也没关系：观众的 signal 一律路由到当前主播
const toNewHost = once(host3, 'signal')
v3.emit('signal', { target: 'stale-old-host-id', data: { sdp: 'ANSWER2' } })
const g3 = await toNewHost
check('观众 signal 路由到当前主播', g3?.data?.sdp === 'ANSWER2' && g3.from === v3.id)
// 反向：新主播能发给观众
const toV3 = once(v3, 'signal')
host3.emit('signal', { target: v3.id, data: { sdp: 'OFFER2', gen: 2 } })
const g4 = await toV3
check('新主播 -> 观众（带 gen）', g4?.data?.sdp === 'OFFER2' && g4.data.gen === 2 && g4.from === host3.id)

// 13. 接管：旧 socket 还没超时时新 socket 就来了（重连的常态）。令牌对就换人，旧的迟到的 disconnect 不散场
const host4 = conn(); await once(host4, 'connect')
const back2 = once(v3, 'host-back')
const take = await call(host4, 'resume-live', { roomId: room2, token: token2 })
check('接管成功', !take.err, take.err || '')
check('观众得知接管后的主播 id', (await back2).hostId === host4.id)
let endedEarly = false
v3.once('live-ended', () => { endedEarly = true })
let awayAfterTakeover = false
v3.once('host-away', () => { awayAfterTakeover = true })
host3.close()
await new Promise((r) => setTimeout(r, 300))
check('被接管的旧 socket 断开不散场', !endedEarly && liveRoom(room2) !== null)
check('被接管的旧 socket 断开也不算掉线', !awayAfterTakeover && liveRoom(room2).hostAway === false)

// 14. 观众重新 watch 同一个房间 = 请主播再发一轮 offer：人数不变，主播收到 viewer-joined
const rejoin = once(host4, 'viewer-joined')
const again = await call(v3, 'watch', { roomId: room2 })
check('重新 watch 不报 already in a room', !again.err && again.data?.hostId === host4.id, again.err || '')
check('重新 watch 触发 viewer-joined', (await rejoin).viewerId === v3.id)
check('重新 watch 人数不变', liveRoom(room2).viewers === 1, `实际 ${liveRoom(room2).viewers}`)

// 15. 主播不在时观众进来：能进，hostId 为空，等主播回来
host4.close()
await once(v3, 'host-away')
const v5 = conn(); await once(v5, 'connect')
const w5 = await call(v5, 'watch', { roomId: room2 })
check('主播不在也能先进房', !w5.err && w5.data?.hostId === null && w5.data?.hostAway === true, w5.err || '')

// 16. 宽限期过了还没回来 -> host-left 散场
const ended2 = once(v3, 'live-ended', 2000)
check('宽限期到才散场', (await ended2).reason === 'host-left')
await new Promise((r) => setTimeout(r, 100))
check('散场后房间清除', liveRooms().length === 0)
const late = conn(); await once(late, 'connect')
const tooLate = await call(late, 'resume-live', { roomId: room2, token: token2 })
check('散场之后令牌作废', tooLate.err === 'not found')

// 17. 每个 IP 的房间上限（测试里所有连接都是 127.0.0.1）
const spam = []
const spamRes = []
for (let i = 0; i < 4; i++) {
  const s = conn(); await once(s, 'connect'); spam.push(s)
  spamRes.push(await call(s, 'go-live', { gameName: `spam${i}`, gameSlug: `spam${i}` }))
}
check('同一 IP 前三个房间能开', spamRes.slice(0, 3).every((r) => !r.err))
check('同一 IP 第四个房间被拒', spamRes[3].err === 'too many rooms', spamRes[3].err || '')
for (const s of spam) s.close()
await new Promise((r) => setTimeout(r, 600))
check('刷房的断线后按宽限期清掉', liveRooms().length === 0, `剩 ${liveRooms().length}`)

// 18. 不存在的房间
const v4 = conn(); await once(v4, 'connect')
const nf = await call(v4, 'watch', { roomId: 'nope' })
check('进不存在的房间', nf.err === 'not found')

for (const s of [host, host2, host3, host4, v1, v2, v3, v4, v5, late, stranger]) s.close()
server.close(); http.close()
console.log('通过 %d 项：\n  %s', ok.length, ok.join('\n  '))
if (bad.length) { console.log('\n失败 %d 项：\n  %s', bad.length, bad.join('\n  ')); process.exit(1) }
console.log('\n全部通过')
process.exit(0)
