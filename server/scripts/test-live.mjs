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

/**
 * 19. 一个人玩、没人在看 -> 断线**立刻**散场，不占宽限期。
 * 宽限期保护的是观众手里那条链接；席位空着就没有要保护的东西，
 * 再留一分钟只会让大厅挂着一张点进去什么都没有的卡片。
 */
const solo = conn(); await once(solo, 'connect')
const soloLive = await call(solo, 'go-live', { gameName: 'Solo', gameSlug: 'solo' })
check('独自开播', !soloLive.err && liveRoom(soloLive.data.roomId) !== null, soloLive.err || '')
solo.close()
await new Promise((r) => setTimeout(r, 120)) // 远小于 400ms 的宽限期
check('没观众时掉线立刻散场', liveRoom(soloLive.data.roomId) === null)

// 20. 主播不在期间最后一个观众也走了 -> 房间立刻散，不等宽限期到点
const host5 = conn(); await once(host5, 'connect')
const l5 = await call(host5, 'go-live', { gameName: 'Duo', gameSlug: 'duo' })
const room5 = l5.data.roomId
const v6 = conn(); await once(v6, 'connect')
await call(v6, 'watch', { roomId: room5 })
await once(host5, 'viewer-joined')
const away5 = once(v6, 'host-away')
host5.close()
await away5
check('有观众时掉线仍走宽限期', liveRoom(room5) !== null && liveRoom(room5).hostAway === true)
v6.close()
await new Promise((r) => setTimeout(r, 120))
check('主播不在时最后一个观众走了也立刻散场', liveRoom(room5) === null)

/**
 * 21. 直播间挂联机房号：主播点了「联机」之后，直播照推、观众不掉，
 * 大厅靠这个字段把两张卡合成一张（见 src/services/allRooms.ts）。
 */
const lh = conn(); await once(lh, 'connect')
const lr = await call(lh, 'go-live', { gameName: 'Link', gameSlug: 'link' })
const linkRoom = lr.data.roomId
check('挂号前是 null', liveRoom(linkRoom).netplayRoomId === null)
lh.emit('link-netplay', { roomId: 'NP-1' })
await new Promise((r) => setTimeout(r, 80))
check('主播能挂上联机房号', liveRoom(linkRoom).netplayRoomId === 'NP-1')

// 观众冒充主播挂号 —— 不然谁都能把别人的直播间标成「联机中」，把人骗进不存在的房间
const lv = conn(); await once(lv, 'connect')
await call(lv, 'watch', { roomId: linkRoom })
lv.emit('link-netplay', { roomId: 'EVIL' })
await new Promise((r) => setTimeout(r, 80))
check('观众挂不了号', liveRoom(linkRoom).netplayRoomId === 'NP-1')

// 正在看的人必须**立刻**知道 —— 他们不会再去刷大厅，等轮询等不来。
// 「看着看着就能上场」这条路全靠这一下推送
const pushed = await new Promise((r) => {
  const timer = setTimeout(() => r('超时'), 1500)
  lv.once('netplay-linked', (d) => { clearTimeout(timer); r(d?.roomId) })
  lh.emit('link-netplay', { roomId: 'NP-9' })
})
check('挂号会立刻推给正在看的观众', pushed === 'NP-9', `实际 ${pushed}`)

// 中途进来的观众不用等推送：watch 的 ack 里本来就带着
const lateViewer = conn(); await once(lateViewer, 'connect')
const lateAck = await call(lateViewer, 'watch', { roomId: linkRoom })
check('后进来的观众从 ack 里就能拿到房号', lateAck.data?.netplayRoomId === 'NP-9')
lateViewer.close()

lh.emit('link-netplay', { roomId: '' })
await new Promise((r) => setTimeout(r, 80))
check('传空 = 解绑（结束联机回到一个人玩）', liveRoom(linkRoom).netplayRoomId === null)

/**
 * 主播掉线：那个联机房要么散了要么在换房主，房号必须跟着作废 ——
 * **而且要告诉正在看的人**。不然他手里那个「加入联机」按钮还亮着，
 * 点下去是离开还活着的直播、去连一个已经不存在的房间：直播也没了，联机也没进去。
 */
lh.emit('link-netplay', { roomId: 'NP-2' })
await new Promise((r) => setTimeout(r, 80))
const awayLink = once(lv, 'host-away')
const unlinked = new Promise((r) => {
  const timer = setTimeout(() => r('没收到'), 1500)
  lv.once('netplay-linked', (d) => { clearTimeout(timer); r(d?.roomId ?? null) })
})
lh.close()
await awayLink
check('主播掉线后房号作废', liveRoom(linkRoom).netplayRoomId === null)
check('主播掉线要收回观众手里的入口', (await unlinked) === null, `实际 ${await unlinked}`)
lv.close()

for (const s of [host, host2, host3, host4, host5, v1, v2, v3, v4, v5, v6, solo, late, stranger]) s.close()
server.close(); http.close()
console.log('通过 %d 项：\n  %s', ok.length, ok.join('\n  '))
if (bad.length) { console.log('\n失败 %d 项：\n  %s', bad.length, bad.join('\n  ')); process.exit(1) }
console.log('\n全部通过')
process.exit(0)
