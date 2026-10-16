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

assert.equal(jsnesRomFingerprint(new Uint8Array([1, 2, 3])), jsnesRomFingerprint(new Uint8Array([1, 2, 3])))
assert.notEqual(jsnesRomFingerprint(new Uint8Array([1, 2, 3])), jsnesRomFingerprint(new Uint8Array([1, 2, 4])))

const playerSource = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('../src/emulator/JsnesNetplayPanel.tsx', import.meta.url), 'utf8')
assert.match(playerSource, /initialRoomId=\{jsnesInviteCode\}/, '邀请房号必须交给可见面板')
assert.match(panelSource, /joinRoom\(initialRoomId\)/, '可见面板必须自动加入邀请房')
assert.doesNotMatch(
  playerSource.slice(playerSource.indexOf('const jsnesInviteCode'), playerSource.indexOf('/** netplay 给我们分配的身份 id')),
  /handle\.openJsnesNetplay\(/,
  '父组件不能在面板外偷偷先占用联机会话',
)

console.log('jsnes 联机通过：邀请进房、ICE/Offer 竞态、初始状态、ROM 对账与逐帧输入')
