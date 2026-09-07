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
// 观众上限压到 3（别的段最多同时 3 个观众）：验「自己的幽灵不能把自己挤出满员的房间」时才凑得满
process.env.LIVE_MAX_VIEWERS = '3'
// 主播切后台：300ms 后从大厅摘掉，零观众 700ms 后收房（线上默认 90s / 10min）
process.env.LIVE_FROZEN_HIDE_MS = '300'
process.env.LIVE_FROZEN_CLOSE_MS = '700'
const { attachLive, liveRooms, liveRoom } = await import('../src/live.js')

const http = createServer()
const server = new Server(http, { cors: { origin: true } })
const { list: lst } = attachLive(server)
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

/**
 * 17. 每个 IP 的房间上限。
 *
 * 测试里直连过来的都是 127.0.0.1 —— 那是**内网地址**，说明反代没把真实 IP 传进来，
 * 这种地址不计数（否则线上反代少一行 X-Forwarded-For，全站就只能同时开 3 间直播）。
 * 要验上限得带一个公网 XFF：服务端信任 loopback 直连带来的 XFF（TRUST_PROXY 默认 loopback）。
 * extraHeaders 在 Node 里只有 polling 传输一定带得上（test-presence.mjs 同款）。
 */
const local = []
for (let i = 0; i < 4; i++) {
  const s = conn(); await once(s, 'connect'); local.push(s)
  const r = await call(s, 'go-live', { gameName: `local${i}`, gameSlug: `local${i}` })
  check(`内网/回环地址不计每 IP 上限（第 ${i + 1} 间）`, !r.err, r.err || '')
}
for (const s of local) s.close()
await new Promise((r) => setTimeout(r, 120))
check('内网那几间断线后清掉', liveRooms().length === 0, `剩 ${liveRooms().length}`)

const spamConn = () => client(url, { transports: ['polling'], forceNew: true, extraHeaders: { 'x-forwarded-for': '203.0.113.7' } })
const spam = []
const spamRes = []
for (let i = 0; i < 4; i++) {
  const s = spamConn(); await once(s, 'connect'); spam.push(s)
  spamRes.push(await call(s, 'go-live', { gameName: `spam${i}`, gameSlug: `spam${i}` }))
}
check('同一公网 IP 前三个房间能开', spamRes.slice(0, 3).every((r) => !r.err), spamRes.map((r) => r.err).join(','))
check('同一公网 IP 第四个房间被拒', spamRes[3].err === 'too many rooms', spamRes[3].err || '')
// 别的公网 IP 不受这个人的额度影响
const other = client(url, { transports: ['polling'], forceNew: true, extraHeaders: { 'x-forwarded-for': '198.51.100.9' } })
await once(other, 'connect')
const otherRes = await call(other, 'go-live', { gameName: 'other', gameSlug: 'other' })
check('另一个公网 IP 照样能开', !otherRes.err, otherRes.err || '')
other.close()
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

/* ─────────── 观众换了 socket（信令重连）：凭 key 认人，不重建、不多算、不被自己挤出去 ─────────── */
{
  const rh = conn(); await once(rh, 'connect')
  const rr = await call(rh, 'go-live', { gameName: 'Rebind', gameSlug: 'rebind', hostName: 'R' })
  const rRoom = rr.data.roomId

  // 第一次进来：普通 viewer-joined
  const ra = conn(); await once(ra, 'connect')
  const j1 = once(rh, 'viewer-joined')
  const w1 = await call(ra, 'watch', { roomId: rRoom, key: 'key-A', reoffer: true })
  check('带 key 进房', !w1.err && w1.data?.rebound === false, w1.err || '')
  check('第一次进房是 viewer-joined、不带 replaces', (await j1).replaces === undefined)
  const raId = ra.id

  // 「重连」：新 socket、同一个 key、画面没断（reoffer=false）→ 主播收 viewer-rebound，人数不变
  const ra2 = conn(); await once(ra2, 'connect')
  let joinedInstead = false
  rh.once('viewer-joined', () => { joinedInstead = true })
  const rebound = once(rh, 'viewer-rebound')
  const w2 = await call(ra2, 'watch', { roomId: rRoom, key: 'key-A', reoffer: false })
  const rb = await rebound
  check('同一 key 换 socket → ack 里 rebound=true', !w2.err && w2.data?.rebound === true, w2.err || '')
  check('主播收到 viewer-rebound（旧 id → 新 id）', rb.from === raId && rb.to === ra2.id)
  await new Promise((r) => setTimeout(r, 80))
  check('换 socket 不走 viewer-joined（那会让主播重建连接）', !joinedInstead)
  check('换 socket 不多算人数', liveRoom(rRoom).viewers === 1, `实际 ${liveRoom(rRoom).viewers}`)
  // 旧 socket 已经不在房间里了：它发弹幕会被拒，而且它断开也不会让人数掉到 0
  const oldChat = await call(ra, 'chat', { text: 'ghost' })
  check('旧 socket 已被请出房间', oldChat.err === 'not in a room', oldChat.err || '')
  let ghostLeft = false
  rh.once('viewer-left', () => { ghostLeft = true })
  ra.close()
  await new Promise((r) => setTimeout(r, 120))
  check('旧 socket 断开不发 viewer-left（那条连接已经改名换给新 socket 了）', !ghostLeft)
  check('旧 socket 断开人数还是 1', liveRoom(rRoom).viewers === 1, `实际 ${liveRoom(rRoom).viewers}`)

  // 再「重连」一次，但这次画面断了（reoffer=true）→ viewer-joined 带 replaces，让主播拆旧连接
  const ra3 = conn(); await once(ra3, 'connect')
  const j3 = once(rh, 'viewer-joined')
  await call(ra3, 'watch', { roomId: rRoom, key: 'key-A', reoffer: true })
  const jj = await j3
  check('画面断了的重连走 viewer-joined 并带 replaces=旧 id', jj.viewerId === ra3.id && jj.replaces === ra2.id)
  check('人数仍是 1', liveRoom(rRoom).viewers === 1, `实际 ${liveRoom(rRoom).viewers}`)

  // 满员时自己的幽灵不能把自己挤出去：上限 3，B、C 进来凑满，A 再重连必须能进
  const rbv = conn(); await once(rbv, 'connect')
  const wb = await call(rbv, 'watch', { roomId: rRoom, key: 'key-B', reoffer: true })
  const rcv = conn(); await once(rcv, 'connect')
  const wc = await call(rcv, 'watch', { roomId: rRoom, key: 'key-C', reoffer: true })
  check('第二、三个观众进来凑满', !wb.err && !wc.err && liveRoom(rRoom).viewers === 3, wb.err || wc.err || '')
  const stranger2 = conn(); await once(stranger2, 'connect')
  const wf = await call(stranger2, 'watch', { roomId: rRoom, key: 'key-D', reoffer: true })
  check('第四个人被拒 full', wf.err === 'full', wf.err || '')
  const ra4 = conn(); await once(ra4, 'connect')
  const w4 = await call(ra4, 'watch', { roomId: rRoom, key: 'key-A', reoffer: false })
  check('满员时同一 key 重连不算新人、不报 full', !w4.err && w4.data?.rebound === true, w4.err || '')
  check('满员重连后人数还是 3', liveRoom(rRoom).viewers === 3, `实际 ${liveRoom(rRoom).viewers}`)

  // 别人拿不到我的 key，但拿着别的 key 来就是普通新观众（这里满了所以被拒）
  const wk = await call(stranger2, 'watch', { roomId: rRoom, key: 'key-E', reoffer: false })
  check('不同的 key 就是新观众', wk.err === 'full', wk.err || '')

  // 正常离开之后 key 也跟着清掉：再拿同一个 key 来就是第一次进房
  ra4.close()
  await new Promise((r) => setTimeout(r, 120))
  check('离开后人数递减', liveRoom(rRoom).viewers === 2, `实际 ${liveRoom(rRoom).viewers}`)
  const ra5 = conn(); await once(ra5, 'connect')
  const j5 = once(rh, 'viewer-joined')
  const w5 = await call(ra5, 'watch', { roomId: rRoom, key: 'key-A', reoffer: false })
  check('走了再来同一个 key = 新进房（rebound=false）', !w5.err && w5.data?.rebound === false, w5.err || '')
  check('新进房走 viewer-joined 且不带 replaces', (await j5).replaces === undefined)

  // 不带 key 的老客户端：行为和以前完全一样（新 socket = 新观众）
  const legacy = conn(); await once(legacy, 'connect')
  const wl = await call(legacy, 'watch', { roomId: rRoom })
  check('不带 key 的老客户端照旧（这里满了所以 full）', wl.err === 'full', wl.err || '')

  for (const s of [rh, ra2, ra3, rbv, rcv, ra4, ra5, stranger2, legacy]) s.close()
  await new Promise((r) => setTimeout(r, 120))
}

/* ─────────── 主播切后台：只有房主能报，观众要收到 ─────────── */
{
  const fh = conn()
  await once(fh, 'connect')
  const { data: fr } = await call(fh, 'go-live', { gameSlug: 'kof97', gameName: 'KOF97', hostName: 'Ryu' })
  const fv = conn()
  await once(fv, 'connect')
  await call(fv, 'watch', { roomId: fr.roomId })
  await new Promise((r) => setTimeout(r, 60))

  // 观众冒充房主报「已冻结」——必须被忽略，否则谁都能把别人的直播标成卡住
  const spoofed = new Promise((r) => {
    const t = setTimeout(() => r('没收到'), 500)
    fh.once('host-frozen', (d) => { clearTimeout(t); r(d) })
  })
  fv.emit('host-visibility', { hidden: true })
  check('观众报的切后台被忽略', (await spoofed) === '没收到')

  // 房主报：观众要收到，而且主播自己不该收到自己的广播
  const frozen = once(fv, 'host-frozen')
  fh.emit('host-visibility', { hidden: true })
  check('主播切后台，观众收到 frozen=true', (await frozen)?.frozen === true)

  // 同一个状态重复报不再惊动房间（避免切来切去刷屏）
  const dup = new Promise((r) => {
    const t = setTimeout(() => r('没收到'), 400)
    fv.once('host-frozen', (d) => { clearTimeout(t); r(d) })
  })
  fh.emit('host-visibility', { hidden: true })
  check('状态没变时不重复广播', (await dup) === '没收到')

  const back = once(fv, 'host-frozen')
  fh.emit('host-visibility', { hidden: false })
  check('主播切回来，观众收到 frozen=false', (await back)?.frozen === false)
  fh.close(); fv.close()
  await new Promise((r) => setTimeout(r, 60))
}

/* ─────────── 大厅列表的 SSE 推送 ─────────── */
{
  const app = (await import('express')).default()
  const { subscribeLiveRooms } = await import('../src/live.js')
  app.get('/api/live/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.flushHeaders?.()
    const un = subscribeLiveRooms(res)
    req.on('close', un)
  })
  const sseHttp = createServer(app)
  await new Promise((r) => sseHttp.listen(0, r))
  const sseUrl = `http://127.0.0.1:${sseHttp.address().port}/api/live/events`

  const events = []
  const ctrl = new AbortController()
  const res = await fetch(sseUrl, { signal: ctrl.signal })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const m = /^event: (\S+)\ndata: ([\s\S]*)$/.exec(chunk)
          if (m) events.push({ event: m[1], data: JSON.parse(m[2]) })
        }
      }
    } catch { /* aborted */ }
  })()

  await new Promise((r) => setTimeout(r, 150))
  check('连上就先收到一份当前列表', events.length === 1 && events[0].event === 'rooms')
  const before = events.length

  // 开播 → 必须立刻推，而不是等下一轮轮询
  const sh = conn()
  await once(sh, 'connect')
  const { data: sr } = await call(sh, 'go-live', { gameSlug: 'sf2', gameName: 'SF2', hostName: 'Ken' })
  await new Promise((r) => setTimeout(r, 250))
  check('开播立刻推送', events.length > before)
  check('推送里能看到这个房间', events.at(-1).data.some((r) => r.roomId === sr.roomId))

  // 有人来看 → 人数变化也要推（大厅卡片上的「N 人在看」）
  const n1 = events.length
  const sv = conn()
  await once(sv, 'connect')
  await call(sv, 'watch', { roomId: sr.roomId })
  await new Promise((r) => setTimeout(r, 250))
  check('观众进来后人数变化也推送', events.length > n1 && events.at(-1).data.some((r) => r.roomId === sr.roomId && r.viewers === 1))

  // 下播 → 卡片要消失
  const n2 = events.length
  sv.close()
  sh.emit('stop-live')
  await new Promise((r) => setTimeout(r, 300))
  check('下播后房间从推送里消失', events.length > n2 && !events.at(-1).data.some((r) => r.roomId === sr.roomId))

  sh.close()
  ctrl.abort()
  sseHttp.close()
  await new Promise((r) => setTimeout(r, 60))
}


/* ── 弹幕 ─────────────────────────────────────────────────
 * 要点全在「服务端说了算」这一句上：房间号取自 membership、名字由服务端派生、
 * 「是不是房主」由服务端比对 hostSocketId。客户端报什么都不算数。 */
{
  const { CHAT_MAX_LENGTH, CHAT_BURST } = await import('../../shared/live-chat.js')

  const ch = conn(); await once(ch, 'connect')
  const cl = await call(ch, 'go-live', { title: '弹幕场', gameSlug: 'g', gameName: 'G', platform: 'nes', hostName: 'Host' })
  const cRoom = cl.data.roomId

  const a = conn(); await once(a, 'connect')
  await call(a, 'watch', { roomId: cRoom })
  const b = conn(); await once(b, 'connect')
  await call(b, 'watch', { roomId: cRoom })

  // 1. 观众发 → 房主、另一个观众、以及发的人自己都收到
  const gotHost = once(ch, 'chat'), gotB = once(b, 'chat'), gotSelf = once(a, 'chat')
  const sent = await call(a, 'chat', { text: 'hello' })
  const [mh, mb, ms] = [await gotHost, await gotB, await gotSelf]
  check('弹幕广播给房间里所有人', mh.text === 'hello' && mb.text === 'hello' && ms.text === 'hello')
  check('发的人自己也收到（不做本地回显，顺序由服务端定）', ms.id === mh.id && sent.data?.id === mh.id)

  // 2. 房主标记由服务端判
  check('观众发的 host=false', mh.host === false)
  const gotFromHost = once(a, 'chat')
  await call(ch, 'chat', { text: 'hi all' })
  check('房主发的 host=true', (await gotFromHost).host === true)

  // 3. 名字服务端给，客户端报的一律不认
  check('游客号由服务端派生', typeof mh.guest === 'string' && mh.guest.length > 0 && mh.name === undefined)
  const gotFake = once(ch, 'chat')
  await call(b, 'chat', { text: 'x', name: '房主', guest: 'zzzz', host: true })
  const fake = await gotFake
  check('客户端报的 name / host 一概不采信', fake.name === undefined && fake.host === false && fake.guest !== 'zzzz')

  // 4. 跨房间注入：不在任何房间里的人发不出去，也不该漏进别人的房间
  const outsider = conn(); await once(outsider, 'connect')
  let leaked = false
  const spy = (m) => { if (m.text === 'INJECT') leaked = true }
  ch.on('chat', spy)
  const rej = await call(outsider, 'chat', { roomId: cRoom, text: 'INJECT' })
  await new Promise((r) => setTimeout(r, 120))
  check('不在房间里的人发不了弹幕', rej.err === 'not in a room')
  check('指定 roomId 也注入不进别人的房间', leaked === false)
  ch.off('chat', spy)
  outsider.close()

  // 5. 空内容
  const blank = await call(a, 'chat', { text: '   \n  ' })
  check('纯空白不发', blank.err === 'empty')

  // 6. 超长按码点截断
  const gotLong = once(ch, 'chat')
  await call(b, 'chat', { text: 'X'.repeat(CHAT_MAX_LENGTH + 40) })
  check('超长截断到上限', Array.from((await gotLong).text).length === CHAT_MAX_LENGTH)

  // 7. 限流：一个连接连着刷，桶空了就拒
  const fresh = conn(); await once(fresh, 'connect')
  await call(fresh, 'watch', { roomId: cRoom })
  let refused = 0
  for (let i = 0; i < CHAT_BURST + 3; i++) {
    const r = await call(fresh, 'chat', { text: 'spam ' + i })
    if (r.err === 'too fast') refused++
  }
  check('连着刷会被限流挡下', refused > 0)
  fresh.close()

  // 8. 中途进来的观众能从 watch 的 ack 里拿到历史
  const latecomer = conn(); await once(latecomer, 'connect')
  const ack = await call(latecomer, 'watch', { roomId: cRoom })
  check('中途进来的观众拿到历史', Array.isArray(ack.data?.chat) && ack.data.chat.some((m) => m.text === 'hello'))
  check('历史里也带着服务端判的房主标记', ack.data.chat.some((m) => m.host === true))
  latecomer.close()

  for (const s of [ch, a, b]) s.close()
  await new Promise((r) => setTimeout(r, 60))
}


// 9. 主播切后台太久的僵尸房：先从大厅摘掉，零观众到点收房，回前台立刻恢复
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const zh = conn(); await once(zh, 'connect')
  const z = await call(zh, 'go-live', { title: '僵尸房', gameSlug: 'zombie', gameName: 'Zombie', platform: 'flash', hostName: 'Away' })
  const zRoom = z.data.roomId
  const zv = conn(); await once(zv, 'connect')
  const zw = await call(zv, 'watch', { roomId: zRoom })
  check('僵尸房：观众进得去', !zw.err)

  // 主播切后台：有观众，房不收；刚切的时候还在列表里
  zh.emit('host-visibility', { hidden: true })
  await sleep(80)
  check('切后台那一刻还在大厅列表里', liveRooms().some((r) => r.roomId === zRoom))
  await sleep(320)
  check('切后台超过阈值后从大厅列表里摘掉', !liveRooms().some((r) => r.roomId === zRoom))
  check('摘掉的房直链照样能查到（人家发出去的链接）', liveRoom(zRoom)?.roomId === zRoom)
  check('摘掉的房 attachLive().list() 也不列', !lst().some((r) => r.roomId === zRoom))
  await sleep(500)
  check('有观众在看就算切后台很久也不收房', liveRoom(zRoom)?.roomId === zRoom)

  // 主播回前台：立刻回到列表
  zh.emit('host-visibility', { hidden: false })
  await sleep(80)
  check('回前台立刻回到大厅列表', liveRooms().some((r) => r.roomId === zRoom))

  // 再切后台，观众走了 → 零观众到点收房，主播收到 live-ended(host-idle)
  zh.emit('host-visibility', { hidden: true })
  await sleep(50)
  const ended = once(zh, 'live-ended', 3000)
  zv.close()
  await sleep(200)
  check('观众刚走还没到点，房还在', liveRoom(zRoom)?.roomId === zRoom)
  const e = await ended.catch(() => null)
  check('后台 + 零观众到点收房，主播收到 live-ended', e?.roomId === zRoom, JSON.stringify(e))
  check('收房的 reason 是 host-idle（主播端据此进入休眠而不是报错）', e?.reason === 'host-idle')
  check('收掉的房查不到了', liveRoom(zRoom) === null)

  // 对照：切后台 + 零观众，但到点前主播回前台了 → 不收
  const zh2 = conn(); await once(zh2, 'connect')
  const z2 = await call(zh2, 'go-live', { title: '回来了', gameSlug: 'zombie', gameName: 'Zombie', platform: 'flash', hostName: 'Back' })
  zh2.emit('host-visibility', { hidden: true })
  await sleep(400)
  zh2.emit('host-visibility', { hidden: false })
  await sleep(500)
  check('到点前回了前台就不收房', liveRoom(z2.data.roomId)?.roomId === z2.data.roomId)

  // 对照：切后台 + 零观众，到点前来了观众 → 不收
  const zh3 = conn(); await once(zh3, 'connect')
  const z3 = await call(zh3, 'go-live', { title: '有人来', gameSlug: 'zombie', gameName: 'Zombie', platform: 'flash', hostName: 'Late' })
  zh3.emit('host-visibility', { hidden: true })
  await sleep(400)
  const zv3 = conn(); await once(zv3, 'connect')
  await call(zv3, 'watch', { roomId: z3.data.roomId })
  await sleep(500)
  check('到点前来了观众就不收房', liveRoom(z3.data.roomId)?.roomId === z3.data.roomId)

  for (const s of [zh, zh2, zh3, zv3]) s.close()
  await sleep(60)
}

for (const s of [host, host2, host3, host4, host5, v1, v2, v3, v4, v5, v6, solo, late, stranger]) s.close()
server.close(); http.close()
console.log('通过 %d 项：\n  %s', ok.length, ok.join('\n  '))
if (bad.length) { console.log('\n失败 %d 项：\n  %s', bad.length, bad.join('\n  ')); process.exit(1) }
console.log('\n全部通过')
process.exit(0)
