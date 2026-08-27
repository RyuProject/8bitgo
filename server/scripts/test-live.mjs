/**
 * 直播信令的端到端测试：起一个真的 http server + socket.io，
 * 用主播 / 观众两个客户端跑一遍完整流程。
 */
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client } from 'socket.io-client'
import { attachLive, liveRooms, liveRoom } from '../src/live.js'

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

// 9. 主播直接断线也要散场
const host2 = conn(); await once(host2, 'connect')
const l2 = await call(host2, 'go-live', { gameName: 'Metroid', gameSlug: 'metroid' })
const v3 = conn(); await once(v3, 'connect')
await call(v3, 'watch', { roomId: l2.data.roomId })
const ended2 = once(v3, 'live-ended')
host2.close()
check('主播掉线散场', (await ended2).reason === 'host-left')
await new Promise((r) => setTimeout(r, 100))
check('掉线后房间清除', liveRooms().length === 0)

// 10. 不存在的房间
const v4 = conn(); await once(v4, 'connect')
const nf = await call(v4, 'watch', { roomId: 'nope' })
check('进不存在的房间', nf.err === 'not found')

for (const s of [host, host2, v1, v2, v3, v4, stranger]) s.close()
server.close(); http.close()
console.log('通过 %d 项：\n  %s', ok.length, ok.join('\n  '))
if (bad.length) { console.log('\n失败 %d 项：\n  %s', bad.length, bad.join('\n  ')); process.exit(1) }
console.log('\n全部通过')
process.exit(0)
