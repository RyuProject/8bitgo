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
globalThis.location = { protocol: 'http:', href: 'http://app.test/games/demo' }
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
const { JsnesNetplay, jsnesNetplaySocketUrl, jsnesRomFingerprint } = mod
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const baseOptions = (overrides = {}) => ({
  seat: 0,
  gameId: 'rom-a',
  captureInitialState: () => ({ cpu: [1, 2, 3], ram: 'state' }),
  applyInitialState: () => {},
  ...overrides,
})

// 生产配置是同源相对路径；不能把 `/netplay` 当成 URL 的 origin 传给 URL 构造器。
assert.equal(
  jsnesNetplaySocketUrl('/netplay', 'https://8bitgo.com/games/demo'),
  'wss://8bitgo.com/jsnes-netplay',
)
assert.equal(
  jsnesNetplaySocketUrl('https://relay.example.net/netplay', 'https://8bitgo.com/games/demo'),
  'wss://relay.example.net/jsnes-netplay',
)

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
  assert.equal(ws.url, 'ws://unit.test/jsnes-netplay')
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

// GBA 电缆联机必须双向交换座位存档；双方确认互收后才由房主发出同步开始信号。
{
  let hostReady = 0
  let guestReady = 0
  let hostPeerState = null
  let guestPeerState = null
  const host = new JsnesNetplay(baseOptions({
    onReady: () => hostReady++,
    captureOwnState: () => ({ tag: 'gba-save', seat: 0, data: 'host-save' }),
    applyPeerState: (state) => { hostPeerState = state },
  }))
  const guest = new JsnesNetplay(baseOptions({
    seat: 1,
    onReady: () => guestReady++,
    captureOwnState: () => ({ tag: 'gba-save', seat: 1, data: 'guest-save' }),
    applyPeerState: (state) => { guestPeerState = state },
  }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  for (let i = 0; i < 8; i++) await tick()
  assert.deepEqual(hostPeerState, { tag: 'gba-save', seat: 1, data: 'guest-save' })
  assert.deepEqual(guestPeerState, { tag: 'gba-save', seat: 0, data: 'host-save' })
  assert.equal(hostReady, 1)
  assert.equal(guestReady, 1)
  assert.equal(host.sendLocal(0, 0x201), true)
  assert.equal(guest.sendLocal(0, 0x102), true)
  await tick()
  assert.equal(guest.remoteBitsFor(0), 0x201)
  assert.equal(host.remoteBitsFor(0), 0x102)
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

// 数据通道只传很小的输入或 12 KiB 存档块；拒绝超大消息，避免坏包占满移动端主线程。
{
  let error = ''
  const peer = new JsnesNetplay(baseOptions({ onError: (message) => { error = message } }))
  const channel = new FakeDataChannel()
  peer.bindDc(channel)
  channel.open()
  channel.onmessage?.({ data: ' '.repeat(20_000) })
  assert.match(error, /消息格式错误或超过大小限制/)
  assert.equal(channel.readyState, 'closed')
  peer.close()
}

// 大卡带存档仍按 12 KiB 分片通过大小门禁，不能为了限流误拒绝合法同步。
{
  const payload = 'save-byte'.repeat(6_000)
  let hostReady = 0
  let guestReady = 0
  let guestState = null
  const host = new JsnesNetplay(baseOptions({
    onReady: () => hostReady++,
    captureOwnState: () => ({ data: payload }),
    applyPeerState: () => {},
  }))
  const guest = new JsnesNetplay(baseOptions({
    seat: 1,
    onReady: () => guestReady++,
    captureOwnState: () => ({ data: payload }),
    applyPeerState: (state) => { guestState = state },
  }))
  const a = new FakeDataChannel()
  const b = new FakeDataChannel()
  a.peer = b
  b.peer = a
  host.bindDc(a)
  guest.bindDc(b)
  a.open()
  b.open()
  for (let i = 0; i < 32 && (!hostReady || !guestReady); i++) await tick()
  assert.equal(hostReady, 1)
  assert.equal(guestReady, 1)
  assert.equal(guestState.data.length, payload.length)
  host.close()
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
const gbaPanelSource = readFileSync(new URL('../src/emulator/GbaLinkNetplayPanel.tsx', import.meta.url), 'utf8')
const gbaAdapterSource = readFileSync(new URL('../src/emulator/adapters/iodinegba.ts', import.meta.url), 'utf8')
const runtimeRegistrySource = readFileSync(new URL('../src/emulator/registry.ts', import.meta.url), 'utf8')
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
assert.match(playerSource, /get\('gbap2p'\)/, 'GBA 邀请链接必须识别独立的 gbap2p 参数')
assert.match(runtimeRegistrySource, /ctx\.gbaLinkNetplay[\s\S]*getRuntime\('iodinegba'\)/, 'GBA 邀请必须强制选择支持串口桥的 IodineGBA')
assert.match(playerSource, /openGbaLinkNetplay/, '播放器必须把 GBA 电缆联机入口挂到当前会话')
assert.match(
  playerSource,
  /if \(platform\.id === 'gba'\) \{[\s\S]*setGbaLinkNetplayAutoHost\(true\)[\s\S]*setGbaLinkNetplayOpen\(true\)[\s\S]*return true\s*\}\s*if \(handle\?\.openNetplay\)/,
  '详情页通用开房在 GBA 上必须优先走电缆联机，不能落到 EmulatorJS 通用房间',
)
assert.match(gbaAdapterSource, /captureOwnState:[\s\S]*applyPeerState:/, 'GBA 两端必须互相交换独立卡带存档')
assert.match(gbaAdapterSource, /attachGbaCable/, '运行时必须把两份核心接到同一条本地 GBA 电缆')
assert.match(gbaPanelSource, /onHostLeft: \(\) => \{\s*setLinkState\('closed'\)/, '对端离开后面板不能继续显示已连接')
assert.match(
  gbaPanelSource,
  /if \(!handle\?\.openGbaLinkNetplay\) \{[\s\S]*autoHostSwitchStarted\.current = true[\s\S]*start\('host'\)[\s\S]*return[\s\S]*autoHostStarted\.current = true[\s\S]*start\('host'\)/,
  '通用 GBA 开房必须在运行时切换到 IodineGBA 后自动继续建立房间',
)
assert.match(gbaPanelSource, /playerStatus !== 'running'[\s\S]*autoJoinStarted/, '自动加入必须等 GBA 核心真正进入运行状态')
assert.match(gbaPanelSource, /playerStatus !== 'running'[\s\S]*autoHostStarted/, '自动开房必须等切换后的 GBA 核心真正进入运行状态')
assert.match(
  gbaPanelSource,
  /const reset = \(\) => \{[\s\S]*autoHostStarted\.current = true[\s\S]*autoHostSwitchStarted\.current = true/,
  '玩家在运行时切换期间断开后，切换完成不能又自动开房',
)
const gbaResumeSource = gbaAdapterSource.slice(
  gbaAdapterSource.indexOf('const resumeSoloAfterLink'),
  gbaAdapterSource.indexOf('const startLinkLoop'),
)
assert.ok(
  gbaResumeSource.indexOf('applyLinkInput(netplaySeat, gbaInputBits(localKeys))') < gbaResumeSource.indexOf('netplayActive = false'),
  '切回单机前必须先把联机延迟输入对齐到当前实体按键状态',
)
const gbaMakeLinkSource = gbaAdapterSource.slice(
  gbaAdapterSource.indexOf('const makeLinkCores'),
  gbaAdapterSource.indexOf('const startGbaNetplay'),
)
assert.doesNotMatch(gbaMakeLinkSource, /localKeys\.clear\(\)/, '建联机双核心不能清除仍由输入源路由持有的按键')
assert.match(gbaPanelSource, /支持 GBA 普通 8\/32 位串口和 Multi-Pak；UART、GPIO、JoyBus 与 RFU/, '面板必须准确说明支持的标准串口和不支持的协议')
assert.match(gbaAdapterSource, /GBA_LINK_PROTOCOL_VERSION\}:\$\{IODINEGBA_SHA256\}/, '双方核心或电缆协议代次不同时必须拒绝锁步')
assert.match(gbaAdapterSource, /gbaLinkRemoteWaitExpired/, '对端输入停止但信令仍连通时必须有界退出锁步')
assert.match(gbaAdapterSource, /inputSources\.releaseSource\('gamepad'\)[\s\S]*inputSources\.releaseSource\('touchpad'\)/,
  '移动端后台后应释放遗留的手柄和触屏按键')
assert.match(gbaPanelSource, /有效的 16 KiB GBA BIOS/, '切换到 IodineGBA 联机前必须提醒用户需要平台 BIOS')

console.log('联机回归通过：jsnes 握手/帧输入、GBA 双向存档同步、邀请路由与运行时接线')
