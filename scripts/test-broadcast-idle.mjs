/**
 * 「没人看就别抓屏」的回归测试。
 *
 * 为什么这条值得钉住：这个站是**玩就是播** —— 每一个玩家都在开播。
 * 以前 `buildStream()` 是在 startBroadcast 里无条件调的，于是每一局单机游戏
 * 都在白付 `canvas.captureStream(30)`（EmulatorJS 的画布是 WebGL 的，
 * 这是每秒 30 次 GPU 读回）外加一个挂在音频图上的 MediaStreamAudioDestinationNode，
 * 而这些帧一个字节都没发出去 —— 没有观众就没有 RTCRtpSender，编码器根本没启动。
 *
 * 这个测试用假的 canvas / AudioContext / socket 把 broadcast.ts 跑起来，
 * 数 captureStream 被调了几次、轨有没有被停掉。
 *
 * 跑：npm run test:broadcast-idle
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

let captureCalls = 0
const liveTracks = new Set()

class FakeTrack {
  constructor(kind) {
    this.kind = kind
    this.readyState = 'live'
    liveTracks.add(this)
  }
  stop() {
    this.readyState = 'ended'
    liveTracks.delete(this)
  }
  getSettings() {
    return { width: 304, height: 224 }
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
  width: 304,
  height: 224,
  captureStream(fps) {
    captureCalls++
    lastCaptureFps = fps
    return new FakeMediaStream([new FakeTrack('video')])
  },
}
let lastCaptureFps = 0

const senders = []
class FakeRTCPeerConnection {
  constructor() {
    this.connectionState = 'new'
    this._senders = []
  }
  addTrack(track) {
    const sender = {
      track,
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
    }
    this._senders.push(sender)
    senders.push(sender)
    return sender
  }
  getSenders() {
    return this._senders
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0' }
  }
  async setLocalDescription(d) {
    this.localDescription = d
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  async getStats() {
    return new Map()
  }
  close() {
    this.connectionState = 'closed'
  }
}

/** 假信令：记下监听，测试自己触发 */
const handlers = new Map()
const fakeSocket = {
  connected: true,
  on(event, fn) {
    handlers.set(event, fn)
  },
  off() {},
  emit(event, payload, ack) {
    if (typeof ack === 'function') {
      if (event === 'go-live') ack(null, { roomId: 'r1', token: 't1' })
      else ack(null, {})
    }
  },
  close() {},
}
const fire = (event, payload) => handlers.get(event)?.(payload)

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
// node 22 自带只读的 navigator，不用也不能改

globalThis.__fakeLiveSocket = fakeSocket

const { startBroadcast } = await import(fileURLToPath(new URL('../src/emulator/broadcast.ts', import.meta.url)))

/* ---------------- 跑 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const live = await startBroadcast({
  sources: { canvas },
  meta: { gameSlug: 'kof98', gameName: 'KOF 98', platform: 'arcade', title: 'x', hostName: 'y' },
})

console.log('── 开播那一刻 ──')
{
  // 探一次是为了「这个源到底抓不抓得出画面」，探完必须立刻放掉
  ok(captureCalls === 1, '开播只探了一次抓屏（验证源可用）')
  ok(liveTracks.size === 0, '⭐ 没有观众时，一条抓屏轨都不留着（探完就停）')
  ok(senders.length === 0, '没有观众就没有 RTCRtpSender —— 编码器根本没启动')
}

console.log('\n── 第一个观众进来 ──')
{
  fire('viewer-joined', { viewerId: 'v1' })
  await sleep(30)
  ok(captureCalls === 2, '⭐ 这时候才真的开始抓屏')
  ok(liveTracks.size === 1, '抓屏轨活着')
  ok(lastCaptureFps === 30, '按 30 帧采（源头就 30，编码那边写 60 只是骗自己）')
  ok(senders.length === 1, '轨挂上了这条连接')
}

console.log('\n── 第二个观众：复用同一条抓屏 ──')
{
  const before = captureCalls
  fire('viewer-joined', { viewerId: 'v2' })
  await sleep(30)
  ok(captureCalls === before, '不会为第二个观众再抓一路（一条流喂 N 个编码器）')
  ok(liveTracks.size === 1, '仍然只有一条抓屏轨')
}

console.log('\n── 观众走光 ──')
{
  fire('viewer-left', { viewerId: 'v1' })
  fire('viewer-left', { viewerId: 'v2' })
  await sleep(30)
  ok(liveTracks.size === 1, '刚走光时先留着（给「只是抖了一下重连」留窗口）')
  await sleep(3200)
  ok(liveTracks.size === 0, '⭐ 3 秒还没人回来 → 抓屏停掉，单机游玩不再白付')
}

console.log('\n── 又有人来看：重新抓得起来 ──')
{
  const before = captureCalls
  fire('viewer-joined', { viewerId: 'v3' })
  await sleep(30)
  ok(captureCalls === before + 1, '重新建了一路抓屏')
  ok(liveTracks.size === 1, '轨又活了')
}

console.log('\n── 停播 ──')
{
  live.stop()
  await sleep(30)
  ok(liveTracks.size === 0, '停播把抓屏轨全放掉')
}

console.log(`\n✅ 直播抓屏测试通过（${n} 项）`)
process.exit(0)
