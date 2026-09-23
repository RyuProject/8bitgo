/**
 * 主播侧信令的回归测试：ICE 候选不能丢、观众换 socket 不重建连接。
 *
 * 两个都是 2026-09-07 直播体检查出来的：
 *
 * 1. **观众的 ICE 候选被丢**。观众回 answer 之后紧跟着就发候选，而 setRemoteDescription 是异步的 ——
 *    候选到的时候 `pc.remoteDescription` 多半还是 null。以前这里直接丢，注释写着「对方会重发」。
 *    WebRTC **不重发候选**：host 类候选（局域网直连）几乎必丢，主播主线程忙时 srflx 也丢，
 *    剩下能配对的只有中继 —— 白走 TURN 流量；没配 TURN 的站点上同一路由器下的两个人都连不上。
 *    现在先攒着，远端描述落地后一并加。
 *
 * 2. **观众信令重连 = 换 socket.id**。以前服务端把它当新观众，主播重建整条 PeerConnection：
 *    观众画面黑一下、编码器多跑一路、人数多算一个。现在服务端凭观众自带的 key 认出是同一个人，
 *    发 viewer-rebound，主播只把那条还在流的连接换个名字。
 *
 * 用假的 canvas / socket / RTCPeerConnection 把 broadcast.ts 跑起来（抄 test-broadcast-idle.mjs 那套）。
 *
 * 跑：npm run test:broadcast-signal
 */
import { fileURLToPath } from 'node:url'

let n = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

/* ---------------- 假环境 ---------------- */

class FakeTrack {
  constructor(kind) {
    this.kind = kind
    this.readyState = 'live'
  }
  stop() {
    this.readyState = 'ended'
  }
  getSettings() {
    return { width: 256, height: 240 }
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this._tracks = tracks
  }
  getTracks() {
    return this._tracks
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio')
  }
}

class FakeDataChannel {
  constructor(label) {
    this.label = label
    this.readyState = 'connecting'
    this.sent = []
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: data channel is not open')
    this.sent.push(data)
  }
  open() {
    this.readyState = 'open'
    this.onopen?.()
  }
  receive(data) {
    this.onmessage?.({ data })
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
}

const canvas = {
  width: 256,
  height: 240,
  captureStream() {
    return new FakeMediaStream([new FakeTrack('video')])
  },
}

/** 所有建过的连接，按顺序 */
const pcs = []
class FakeRTCPeerConnection {
  constructor() {
    this.connectionState = 'new'
    this.remoteDescription = null
    this.localDescription = null
    this.candidates = []
    this._senders = []
    this.dataChannels = []
    /** setRemoteDescription 故意不当场落地：由测试调 settleRemote() 才算完成 */
    this._settle = null
    this.closed = false
    pcs.push(this)
  }
  addTrack(track) {
    const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }
    this._senders.push(sender)
    return sender
  }
  getSenders() {
    return this._senders
  }
  createDataChannel(label) {
    const dc = new FakeDataChannel(label)
    this.dataChannels.push(dc)
    return dc
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' }
  }
  async setLocalDescription(d) {
    this.localDescription = d
    this.connectionState = 'connecting'
  }
  setRemoteDescription(d) {
    if (this.closed) return Promise.reject(new Error('InvalidStateError: closed'))
    return new Promise((resolve) => {
      this._settle = () => {
        this.remoteDescription = d
        this.connectionState = 'connected'
        resolve()
      }
    })
  }
  settleRemote() {
    const f = this._settle
    this._settle = null
    f?.()
  }
  async addIceCandidate(c) {
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description')
    this.candidates.push(c)
  }
  async getStats() {
    return new Map()
  }
  close() {
    this.closed = true
    this.connectionState = 'closed'
    for (const dc of this.dataChannels) dc.close()
  }
}
class FakeRTCSessionDescription {
  constructor(init) {
    Object.assign(this, init)
  }
}
class FakeRTCIceCandidate {
  constructor(init) {
    Object.assign(this, init)
  }
}

/** 假信令：记下监听 + 记下发出去的 signal */
const handlers = new Map()
const sent = []
const coopStates = []
const fakeSocket = {
  connected: true,
  on(event, fn) {
    handlers.set(event, fn)
  },
  off() {},
  emit(event, payload, ack) {
    if (event === 'signal') sent.push(payload)
    if (event === 'coop-state') coopStates.push(payload)
    if (typeof ack === 'function') {
      if (event === 'go-live') ack(null, { roomId: 'r1', token: 't1' })
      else ack(null, {})
    }
  },
  close() {},
}
const fire = (event, payload) => handlers.get(event)?.(payload)
const offersTo = (id) => sent.filter((s) => s.target === id && s.data?.sdp)

/* ---------------- 打桩 ---------------- */

globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.MediaStream = FakeMediaStream
globalThis.RTCPeerConnection = FakeRTCPeerConnection
globalThis.RTCSessionDescription = FakeRTCSessionDescription
globalThis.RTCIceCandidate = FakeRTCIceCandidate
globalThis.__fakeLiveSocket = fakeSocket

const { startBroadcast } = await import(fileURLToPath(new URL('../src/emulator/broadcast.ts', import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seatChanges = []
const guestInputs = []

const live = await startBroadcast({
  sources: { canvas },
  meta: { gameSlug: 'contra', gameName: 'Contra', platform: 'nes', title: 'x', hostName: 'y' },
  coopButtons: () => ['left', 'right'],
  onSeatChange: (viewerId) => seatChanges.push(viewerId),
  onGuestInput: (button, down) => guestInputs.push({ button, down }),
})

/* ---------------- 1. 候选在远端描述落地前到达：先攒着，落地后一并加 ---------------- */
console.log('── ICE 候选不能丢 ──')
fire('viewer-joined', { viewerId: 'v1' })
await sleep(30)
const pc1 = pcs.at(-1)
const offer1 = offersTo('v1')
ok(offer1.length === 1 && typeof offer1[0].data.gen === 'number', '观众进来 → 发了一份 offer（带 gen）')
const gen1 = offer1[0].data.gen

// 观众回 answer，紧跟着两颗候选 —— 现实里就是这么紧挨着来的
fire('signal', { from: 'v1', data: { sdp: { type: 'answer', sdp: 'v=0 answer' }, gen: gen1 } })
fire('signal', { from: 'v1', data: { candidate: { candidate: 'candidate:1 1 udp 2113937151 192.168.1.5 5000 typ host', sdpMid: '0' }, gen: gen1 } })
fire('signal', { from: 'v1', data: { candidate: { candidate: 'candidate:2 1 udp 1677729535 203.0.113.9 5000 typ srflx', sdpMid: '0' }, gen: gen1 } })
await sleep(10)
ok(pc1.remoteDescription === null && pc1.candidates.length === 0, '远端描述还没落地：候选先不加（加了会抛）')
pc1.settleRemote()
await sleep(10)
ok(pc1.candidates.length === 2, '⭐ 远端描述落地后，先到的两颗候选一颗都没丢')
ok(pc1.candidates[0].candidate.includes('typ host') && pc1.candidates[1].candidate.includes('typ srflx'), '顺序不乱')

// 落地之后来的直接加
fire('signal', { from: 'v1', data: { candidate: { candidate: 'candidate:3 1 udp 33562623 198.51.100.4 5000 typ relay', sdpMid: '0' }, gen: gen1 } })
await sleep(10)
ok(pc1.candidates.length === 3, '落地之后来的候选直接加')

// 别的轮次的候选不能混进来
fire('signal', { from: 'v1', data: { candidate: { candidate: 'candidate:9 stale', sdpMid: '0' }, gen: gen1 - 1 } })
await sleep(10)
ok(pc1.candidates.length === 3, 'gen 不对的候选（上一轮的）照旧丢掉')

// 观众回的不是 answer（伪造 / 错包）不喂给连接
fire('signal', { from: 'v1', data: { sdp: { type: 'offer', sdp: 'evil' }, gen: gen1 } })
await sleep(10)
ok(pc1.remoteDescription.sdp === 'v=0 answer', '观众发来的 offer 不采信（它只该回 answer）')

/* ---------------- 2. 观众换 socket：换名字，不重建 ---------------- */
console.log('\n── 观众信令重连（viewer-rebound）──')
{
  const before = pcs.length
  const sentBefore = sent.length
  fire('viewer-rebound', { from: 'v1', to: 'v1b' })
  await sleep(20)
  ok(pcs.length === before, '⭐ 没有新建 PeerConnection')
  ok(!pc1.closed, '原来那条连接没被关掉（观众画面一帧不掉）')
  ok(offersTo('v1b').length === 0 && sent.length === sentBefore, '没有给新 id 发 offer')

  // 新 id 发来的包路由到同一条连接上
  fire('signal', { from: 'v1b', data: { candidate: { candidate: 'candidate:4 1 udp late 10.0.0.2 5000 typ host', sdpMid: '0' }, gen: gen1 } })
  await sleep(10)
  ok(pc1.candidates.length === 4, '新 socket.id 发来的候选落到原来那条连接上')

  // 旧 id 已经不认了
  fire('signal', { from: 'v1', data: { candidate: { candidate: 'candidate:5 ghost', sdpMid: '0' }, gen: gen1 } })
  await sleep(10)
  ok(pc1.candidates.length === 4, '旧 socket.id 发来的包不再认')

  // 服务端迟到的 viewer-left（旧 id）不能把改了名的连接拆掉
  fire('viewer-left', { viewerId: 'v1' })
  await sleep(10)
  ok(!pc1.closed, '旧 id 的 viewer-left 不会拆掉已经改名的连接')

  // 换名字之后连接要是断了，还能按新名字收掉
  pc1.connectionState = 'failed'
  pc1.onconnectionstatechange?.()
  await sleep(10)
  ok(pc1.closed, '改名之后连接 failed 照样能按新 id 收掉（回调用的是 entry.id 不是闭包里的旧 id）')
}

/* ---------------- 3. rebound 但那条连接已经没了：按新观众处理 ---------------- */
console.log('\n── rebound 找不到旧连接 → 当新观众 ──')
{
  const before = pcs.length
  fire('viewer-rebound', { from: 'nobody', to: 'v2' })
  await sleep(30)
  ok(pcs.length === before + 1 && offersTo('v2').length === 1, '旧连接不存在时给新 id 发一轮 offer')
}

/* ---------------- 4. viewer-joined 带 replaces：旧连接直接拆 ---------------- */
console.log('\n── viewer-joined + replaces ──')
{
  const pc2 = pcs.at(-1)
  const before = pcs.length
  fire('viewer-joined', { viewerId: 'v2b', replaces: 'v2' })
  await sleep(30)
  ok(pc2.closed, 'replaces 指到的旧连接被拆掉（观众明说画面断了）')
  ok(pcs.length === before + 1 && offersTo('v2b').length === 1, '给新 id 发了新 offer')
}

/* ---------------- 5. 顶掉的那一轮：候选不能灌进新连接 ---------------- */
console.log('\n── 观众又 watch 了一轮，旧 answer 迟到 ──')
{
  const pcOld = pcs.at(-1)
  const genOld = offersTo('v2b')[0].data.gen
  fire('viewer-joined', { viewerId: 'v2b' })
  await sleep(30)
  const pcNew = pcs.at(-1)
  ok(pcNew !== pcOld && pcOld.closed, '重新 watch → 旧连接关掉、新连接建好')
  fire('signal', { from: 'v2b', data: { sdp: { type: 'answer', sdp: 'old answer' }, gen: genOld } })
  fire('signal', { from: 'v2b', data: { candidate: { candidate: 'candidate:7 old', sdpMid: '0' }, gen: genOld } })
  await sleep(10)
  ok(pcNew._settle === null && pcNew.candidates.length === 0, '上一轮迟到的 answer / 候选一个都没喂给新连接')
}

/* ---------------- 6. ICE 配置迟到：离开和重试不能复活旧连接 ---------------- */
console.log('\n── ICE 配置等待中的建连竞态 ──')
{
  const waiting = []
  globalThis.__fakeLiveIceServers = () => new Promise((resolve) => waiting.push(resolve))

  const beforeLeave = pcs.length
  fire('viewer-joined', { viewerId: 'late-left' })
  fire('viewer-left', { viewerId: 'late-left' })
  waiting.shift()?.([])
  await sleep(10)
  ok(pcs.length === beforeLeave && offersTo('late-left').length === 0, '⭐ ICE 配置回来前观众已离开：不建连接、不发 offer')

  const beforeRetry = pcs.length
  fire('viewer-joined', { viewerId: 'retry' })
  fire('viewer-joined', { viewerId: 'retry' })
  const [old, latest] = waiting.splice(0)
  latest?.([])
  await sleep(10)
  const active = pcs.at(-1)
  old?.([])
  await sleep(10)
  ok(pcs.length === beforeRetry + 1 && !active.closed, '⭐ 新一轮先完成后旧一轮才回来：旧请求不顶掉新连接')
  ok(offersTo('retry').length === 1, '同一观众反复 watch 只收到最新的一份 offer')

  const beforeRebound = pcs.length
  fire('viewer-joined', { viewerId: 'old-id' })
  fire('viewer-joined', { viewerId: 'new-id', replaces: 'old-id' })
  const [oldId, newId] = waiting.splice(0)
  oldId?.([])
  await sleep(10)
  ok(pcs.length === beforeRebound && offersTo('old-id').length === 0, '旧 socket 的 ICE 等待在 replaces 后作废')
  newId?.([])
  await sleep(10)
  ok(offersTo('new-id').length === 1, '新 socket 仍能拿到 offer')
  delete globalThis.__fakeLiveIceServers
}

console.log('\n── SDP 迟到时暂存的候选有上限 ──')
{
  fire('viewer-joined', { viewerId: 'ice-flood' })
  await sleep(20)
  const floodPc = pcs.at(-1)
  const gen = offersTo('ice-flood')[0]?.data.gen
  for (let i = 0; i < 100; i++) {
    fire('signal', { from: 'ice-flood', data: { candidate: { candidate: `candidate:${i}` }, gen } })
  }
  fire('signal', { from: 'ice-flood', data: { sdp: { type: 'answer', sdp: 'v=0 answer' }, gen } })
  await sleep(10)
  floodPc.settleRemote()
  await sleep(10)
  ok(floodPc.candidates.length === 64, `⭐ SDP 迟到时最多积压 64 颗候选（实际 ${floodPc.candidates.length}）`)
}

/* ---------------- 8. 输入通道单独断开：座位清理，并自动重建一次 ---------------- */
console.log('\n── 2P 输入通道断开自愈 ──')
{
  fire('viewer-joined', { viewerId: 'coop' })
  await sleep(30)
  const coopPc = pcs.at(-1)
  const dc = coopPc.dataChannels[0]
  ok(Boolean(dc), '房主在 offer 前创建了输入通道')
  dc.open()
  live.grantSeat('coop')
  dc.receive('{"t":"k","b":"left","d":true}')
  ok(live.seated() === 'coop', '观众拿到 2P 位')
  ok(guestInputs.at(-1)?.button === 'left' && guestInputs.at(-1)?.down === true, '按键已经进入游戏')

  const before = pcs.length
  dc.close()
  await sleep(40)
  ok(live.seated() === null && seatChanges.at(-1) === null, '⭐ 通道断开立即清空房主 UI 的持座状态')
  ok(guestInputs.at(-1)?.button === 'left' && guestInputs.at(-1)?.down === false, '⭐ 断开时补发 keyup，角色不会卡住')
  ok(coopStates.at(-1)?.taken === false, '⭐ 大厅立即恢复为 2P 空位，不等下一轮 5 秒统计')
  ok(pcs.length === before + 1 && coopPc.closed, '⭐ 视频仍活着但输入通道死掉时，自动重建连接重新协商通道')

  // 同一位观众第二次再关通道也不能触发循环；否则恶意脚本能逼主播无限重建、吃满 CPU。
  const retryPc = pcs.at(-1)
  const retryDc = retryPc.dataChannels[0]
  const afterRetry = pcs.length
  retryDc.open()
  retryDc.close()
  await sleep(30)
  ok(pcs.length === afterRetry, '同一观众第二次关通道时停止自动重建，避免无限 offer 循环')
}

/* ---------------- 9. 信令断开期间的座位变化：重连后必须补报 ---------------- */
console.log('\n── 2P 状态跨信令重连补报 ──')
{
  fire('viewer-joined', { viewerId: 'coop-reconnect' })
  await sleep(30)
  pcs.at(-1).dataChannels[0].open()
  live.grantSeat('coop-reconnect')
  ok(coopStates.at(-1)?.taken === true, '前提：持座状态已经报给服务器')

  const before = coopStates.length
  fakeSocket.connected = false
  fire('disconnect')
  live.revokeSeat()
  ok(coopStates.length === before, '信令断着时不把状态塞进 socket.io 离线队列')

  fakeSocket.connected = true
  fire('connect')
  await sleep(30)
  ok(coopStates.at(-1)?.taken === false, '⭐ 重连续播后补报断线期间的空座状态，大厅不会永久显示已占')
}

live.stop()
console.log(`\n✅ 主播侧信令测试通过（${n} 项）`)
process.exit(failedChecks ? 1 : 0)
