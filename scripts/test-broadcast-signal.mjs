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
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

let n = 0
const ok = (cond, msg) => {
  n++
  assert.ok(cond, msg)
  console.log('✅ ' + msg)
}

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
const fakeSocket = {
  connected: true,
  on(event, fn) {
    handlers.set(event, fn)
  },
  off() {},
  emit(event, payload, ack) {
    if (event === 'signal') sent.push(payload)
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

const live = await startBroadcast({
  sources: { canvas },
  meta: { gameSlug: 'contra', gameName: 'Contra', platform: 'nes', title: 'x', hostName: 'y' },
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

live.stop()
console.log(`\n✅ 主播侧信令测试通过（${n} 项）`)
process.exit(0)
