/**
 * jsnes 双人联机的协议回归：加入房、握手竞态、ICE 排队、ROM/状态对账。
 * 这里用假的 WebSocket / WebRTC，不开端口，也不依赖浏览器。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: "export * from './src/emulator/jsnesNetplay.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'jsnes-netplay-test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'netplay-stub',
    setup(api) {
      api.onResolve({ filter: /^@\/services\/netplay$/ }, () => ({ path: 'netplay', namespace: 'test' }))
      api.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: `
          export const NETPLAY_URL = 'http://unit.test/netplay'
          export const fetchIceConfig = () => globalThis.__fetchIceConfig()
        `,
        loader: 'js',
      }))
      api.onResolve({ filter: /^@\// }, (args) => ({ path: path.join(process.cwd(), 'src', `${args.path.slice(2)}.ts`) }))
    },
  }],
})

globalThis.window = globalThis
globalThis.location = { protocol: 'http:' }
globalThis.__fetchIceConfig = async () => ({ iceServers: [{ urls: 'stun:test' }], hasTurn: false, expiry: 0 })

class FakeWebSocket {
  static OPEN = 1
  static all = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeWebSocket.all.push(this)
  }
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  receive(value) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
  send(value) {
    this.sent.push(JSON.parse(value))
  }
  close() {
    if (this.readyState > FakeWebSocket.OPEN) return
    this.readyState = 3
    this.onclose?.()
  }
}
globalThis.WebSocket = FakeWebSocket

class FakePeerConnection {
  static all = []
  constructor(config) {
    this.config = config
    this.connectionState = 'new'
    this.remoteDescription = null
    this.localDescription = null
    this.added = []
    FakePeerConnection.all.push(this)
  }
  createDataChannel() {
    return new FakeDataChannel()
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' }
  }
  async setLocalDescription(value) {
    this.localDescription = { ...value, toJSON() { return value } }
  }
  async setRemoteDescription(value) {
    await Promise.resolve()
    this.remoteDescription = value
  }
  async addIceCandidate(value) {
    if (!this.remoteDescription) throw new Error('InvalidStateError')
    this.added.push(value)
  }
  close() {
    this.connectionState = 'closed'
  }
}
globalThis.RTCPeerConnection = FakePeerConnection

class FakeDataChannel extends EventTarget {
  constructor() {
    super()
    this.readyState = 'connecting'
    this.bufferedAmount = 0
    this.bufferedAmountLowThreshold = 0
    this.peer = null
  }
  send(value) {
    if (this.readyState !== 'open') throw new Error('channel closed')
    queueMicrotask(() => this.peer?.onmessage?.({ data: value }))
  }
  open() {
    this.readyState = 'open'
    this.onopen?.()
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
}

const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`)
const { JsnesNetplay, jsnesRomFingerprint } = mod
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const baseOptions = (overrides = {}) => ({
  seat: 0,
  gameId: 'rom-a',
  captureInitialState: () => ({ cpu: [1, 2, 3], ram: 'state' }),
  applyInitialState: () => {},
  ...overrides,
})

// 输入延迟既来自房间设置，也可能在握手时由对端传入；两种入口都必须夹在安全范围内。
for (const [input, expected] of [[-3, 0], [2.9, 2], [99, 8], [Number.NaN, 2]]) {
  const peer = new JsnesNetplay(baseOptions({ bufferFrames: input }))
  assert.equal(peer.bufferFrames, expected)
  peer.close()
}
{
  const peer = new JsnesNetplay(baseOptions())
  peer.setBuffer(-1)
  assert.equal(peer.bufferFrames, 0)
  peer.setBuffer(100)
  assert.equal(peer.bufferFrames, 8)
  peer.setBuffer(Number.NaN)
  assert.equal(peer.bufferFrames, 2)
  peer.close()
}

// 旧版构造函数没把 opts.roomId 写进实例，访客点“加入”实际发的是 host。
{
  const guest = new JsnesNetplay(baseOptions({ seat: 1, roomId: 'ABC123' }))
  const connected = guest.connect()
  const ws = FakeWebSocket.all.at(-1)
  ws.open()
  assert.deepEqual(ws.sent[0], { type: 'join', roomId: 'abc123' })
  ws.receive({ type: 'joined', roomId: 'abc123', host: 'host-1', seat: 1 })
  await connected
  guest.close()
}

// 房主收到 peer-joined 时 ICE 还没取回：offer 必须等待 PC，而不是静默丢掉。
{
  let releaseIce
  globalThis.__fetchIceConfig = () => new Promise((resolve) => { releaseIce = resolve })
  const host = new JsnesNetplay(baseOptions())
  const connected = host.connect()
  const ws = FakeWebSocket.all.at(-1)
  ws.open()
  ws.receive({ type: 'room', roomId: 'room-1', seat: 0 })
  await connected
  ws.receive({ type: 'peer-joined', guest: 'guest-1' })
  await tick()
  assert.equal(ws.sent.some((m) => m.type === 'signal'), false)
  releaseIce({ iceServers: [{ urls: 'stun:fresh' }], hasTurn: false, expiry: 0 })
  await tick()
  await tick()
  assert.equal(ws.sent.some((m) => m.type === 'signal' && m.data?.sdp?.type === 'offer'), true)
  host.close()
}

// 候选先于 SDP 到达时必须排队；WebRTC 不会替应用层重发丢掉的 ICE。
{
  globalThis.__fetchIceConfig = async () => ({ iceServers: [], hasTurn: false, expiry: 0 })
  const guest = new JsnesNetplay(baseOptions({ seat: 1, roomId: 'room-2' }))
  const connected = guest.connect()
  const ws = FakeWebSocket.all.at(-1)
  ws.open()
  ws.receive({ type: 'joined', roomId: 'room-2', host: 'host-2', seat: 1 })
  await connected
  ws.receive({ type: 'signal', from: 'host-2', data: { candidate: { candidate: 'ice-1' } } })
  ws.receive({ type: 'signal', from: 'host-2', data: { sdp: { type: 'offer', sdp: 'offer' } } })
  await tick()
  await tick()
  assert.deepEqual(FakePeerConnection.all.at(-1).added, [{ candidate: 'ice-1' }])
  guest.close()
}

// 数据通道先校验 ROM，再由房主分块同步当前状态；双方都确认后才允许发输入。
{
  let hostReady = 0
  let guestReady = 0
  let applied = null
  const host = new JsnesNetplay(baseOptions({ onReady: () => hostReady++ }))
  const guest = new JsnesNetplay(baseOptions({
    seat: 1,
    applyInitialState: (state) => { applied = state },
    onReady: () => guestReady++,
  }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  await tick()
  await tick()
  assert.deepEqual(applied, { cpu: [1, 2, 3], ram: 'state' })
  assert.equal(hostReady, 1)
  assert.equal(guestReady, 1)
  assert.equal(host.sendLocal(0, 3), true)
  await tick()
  assert.equal(guest.remoteBitsFor(0), 3)
  host.close()
  guest.close()
}

// 内容不同必须明确失败，不能让两个已经分叉的模拟器继续显示“已连接”。
{
  let error = ''
  const host = new JsnesNetplay(baseOptions({ onError: (message) => { error = message } }))
  const guest = new JsnesNetplay(baseOptions({ seat: 1, gameId: 'rom-b' }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  await tick()
  assert.match(error, /ROM 内容不同/)
  guest.close()
}

// RTCDataChannel 在弱网切换 / 发送缓冲区满时可以同步抛错；帧循环不能因此漏掉下一拍 rAF。
{
  let error = ''
  const host = new JsnesNetplay(baseOptions({ onError: (message) => { error = message } }))
  const guest = new JsnesNetplay(baseOptions({ seat: 1 }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  await tick()
  await tick()
  a.send = () => { throw new Error('buffer full') }
  assert.equal(host.sendLocal(0, 1), false)
  assert.match(error, /输入通道发送失败.*buffer full/)
  assert.equal(a.readyState, 'closed')
  host.close()
  guest.close()
}

// 合法锁步输入允许领先 120 帧的抖动余量；更远的帧要快速结束会卡死当前帧的异常会话。
{
  let error = ''
  const host = new JsnesNetplay(baseOptions())
  const guest = new JsnesNetplay(baseOptions({ seat: 1, onError: (message) => { error = message } }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  await tick()
  await tick()
  assert.equal(guest.sendLocal(10, 1), true)
  guest.onData({ kind: 'input', frame: 130, bits: 2 })
  assert.equal(guest.remoteBitsFor(130), 2)
  guest.onData({ kind: 'input', frame: 131, bits: 2 })
  assert.match(error, /输入帧超前过多/)
  host.close()
  guest.close()
}

// SDP 前的 ICE 候选只暂存有限数量，阻止异常对端在手机上无限堆积对象。
{
  let error = ''
  const guest = new JsnesNetplay(baseOptions({ seat: 1, onError: (message) => { error = message } }))
  await guest.ensurePc(false)
  for (let i = 0; i < 257; i++) {
    await guest.onSignal({ candidate: { candidate: `candidate:${i}` } })
  }
  assert.match(error, /ICE 候选过多/)
  guest.close()
}

// 输入缓存达到上限后拒绝继续增长；清理旧帧后应能复用已释放的容量。
{
  let error = ''
  const host = new JsnesNetplay(baseOptions())
  const guest = new JsnesNetplay(baseOptions({ seat: 1, onError: (message) => { error = message } }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  await tick()
  await tick()
  assert.equal(guest.sendLocal(480, 0), true)
  for (let frame = 0; frame < 600; frame++) guest.onData({ kind: 'input', frame, bits: 1 })
  guest.pruneRemote(300)
  assert.equal(guest.remoteBitsFor(100), undefined)
  assert.equal(guest.remoteBitsFor(599), 1)
  assert.equal(guest.sendLocal(780, 0), true)
  for (let frame = 600; frame < 900; frame++) guest.onData({ kind: 'input', frame, bits: 1 })
  guest.onData({ kind: 'input', frame: 900, bits: 1 })
  assert.match(error, /输入缓存超限/)
  host.close()
  guest.close()
}

// jsnes 3.0 的状态 ABI 与 2.x 不兼容；旧页面必须在传状态前被协议版本挡住。
{
  let error = ''
  const host = new JsnesNetplay(baseOptions({ onError: (message) => { error = message } }))
  const guest = new JsnesNetplay(baseOptions({ seat: 1 }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  const sendFromOldClient = a.send.bind(a)
  a.send = (value) => {
    const message = JSON.parse(value)
    if (message.kind === 'hello') message.version = 2
    sendFromOldClient(JSON.stringify(message))
  }
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  await tick()
  assert.match(error, /联机协议版本不同/)
  host.close()
  guest.close()
}

assert.equal(jsnesRomFingerprint(new Uint8Array([1, 2, 3])), jsnesRomFingerprint(new Uint8Array([1, 2, 3])))
assert.notEqual(jsnesRomFingerprint(new Uint8Array([1, 2, 3])), jsnesRomFingerprint(new Uint8Array([1, 2, 4])))

const playerSource = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('../src/emulator/JsnesNetplayPanel.tsx', import.meta.url), 'utf8')
assert.match(playerSource, /initialRoomId=\{jsnesInviteCode\}/, '邀请房号必须交给可见面板')
assert.match(playerSource, /targetPlatform === 'nes' && jsnesNetplay && runtime\.id !== 'jsnes'[\s\S]*jsnesInviteNotJoined/, '邀请 ROM 落到单人备用运行时后，必须明确告知玩家未加入联机房')
assert.match(panelSource, /joinRoom\(initialRoomId\)/, '可见面板必须自动加入邀请房')
assert.match(playerSource, /autoHost=\{jsnesNetplayAutoHost\}/, '通用开房请求必须把自动开房意图交给 jsnes 面板')
assert.match(panelSource, /if \(!autoHost \|\| initialRoomId \|\| autoHostStarted\.current\) return/, 'jsnes 面板必须自动创建通用按钮请求的房间')
const matchRequestSource = playerSource.slice(playerSource.indexOf('const wantMatchRef'), playerSource.indexOf('/** 结束联机'))
assert.match(matchRequestSource, /openMatchForCurrentRuntime\(\)/, '通用开房必须按当前运行时能力分派，不能只认 EmulatorJS')
assert.doesNotMatch(
  playerSource.slice(playerSource.indexOf('const jsnesInviteCode'), playerSource.indexOf('/** netplay 给我们分配的身份 id')),
  /handle\.openJsnesNetplay\(/,
  '父组件不能在面板外偷偷先占用联机会话',
)

console.log('jsnes 联机通过：邀请进房、ICE/Offer 竞态、初始状态、ROM 对账与逐帧输入')
