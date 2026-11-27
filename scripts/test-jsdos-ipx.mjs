import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createIpxAlias, jsdosIceEndpoint, parseIpxAddress } from '../src/emulator/ipxAddress.ts'
import { IpxOperationTimeout, withIpxTimeout } from '../src/emulator/ipxRuntime.ts'

assert.deepEqual(parseIpxAddress('123456'), { kind: 'peer', peerId: 123456 })
assert.deepEqual(parseIpxAddress('4294967295'), { kind: 'peer', peerId: 0xffff_ffff })
assert.equal(parseIpxAddress('4294967296'), null)
assert.equal(parseIpxAddress('0'), null)
assert.deepEqual(parseIpxAddress('IPX=8bg-ab12cd34ef56'), { kind: 'alias', alias: '8bg-ab12cd34ef56' })
assert.equal(parseIpxAddress('https://evil.example/ipx/room'), null)
assert.equal(parseIpxAddress('peer id'), null)
assert.equal(createIpxAlias(Uint8Array.from([0, 1, 2, 3, 4, 5, 254, 255])), '8bg-000102030405feff')
assert.equal(jsdosIceEndpoint('same-origin'), '/api/netplay/ice')
assert.equal(jsdosIceEndpoint(undefined), '/api/netplay/ice')
assert.equal(jsdosIceEndpoint('https://api.example/'), 'https://api.example/api/netplay/ice')

const adapter = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
assert.match(adapter, /hand_ipx_startserver/, '房主必须触发 js-dos 的 IPX 主机事件')
assert.match(adapter, /net\.registerAlias\(alias\.alias\)/, '房主必须注册可分享的 P2P 别名')
assert.match(adapter, /networkConnect\(0, String\(peerId\)\)/, '加入时必须把 peer id 交给 js-dos IPX 网络接口')
assert.match(adapter, /jsdosIceEndpoint\(import\.meta\.env\.VITE_API_URL\)/, 'ICE 请求必须正确支持 same-origin')
assert.match(adapter, /await ensureIpxNetwork\(current\)/, '单机 DOS 必须能在玩家点击后原地初始化 IPX')
assert.match(adapter, /withIpxTimeout\(current\.networkConnect/, '弱网下加入对端必须有界结束')
assert.match(adapter, /current\.cancelNetworkConnect\?\.\(\)/, 'IPX 握手超时必须释放 js-dos 的连接锁')

globalThis.window = globalThis
assert.equal(await withIpxTimeout(Promise.resolve('ready'), 'timeout', 20), 'ready')
await assert.rejects(
  withIpxTimeout(new Promise(() => {}), 'IPX request timed out', 5),
  IpxOperationTimeout,
  '挂起的 IPX 信令请求必须超时结束',
)

const paths = readFileSync(new URL('../src/emulator/paths.ts', import.meta.url), 'utf8')
const assetVersion = paths.match(/JSDOS_ASSET_VERSION\s*=\s*'([^']+)'/)?.[1]
assert.ok(assetVersion, '必须读取当前 js-dos 资源版本')
const runtimeRoot = new URL(`../public/jsdos/v${assetVersion}/`, import.meta.url)
const main = readFileSync(new URL('js-dos.js', runtimeRoot), 'utf8')
const emulators = readFileSync(new URL('emulators/emulators.js', runtimeRoot), 'utf8')
assert.match(main, /__8bitgoEnsureIpxNetwork/, '运行时必须按玩家操作惰性创建 IPX 网络')
assert.match(main, /IPX network setup timed out/, '网络初始化挂起时必须释放等待状态')
assert.match(main, /__8bitgoReleaseIpxNetwork/, '离开游戏时必须关闭本站创建的网络')
assert.match(emulators, /setNet\(e\)/, '运行中的 CommandInterface 必须支持安装 Net 并启动收包轮询')
assert.match(emulators, /cancelNetworkConnect\(\)/, 'IPX 连接超时后必须清除连接状态')
assert.match(emulators, /cancelNetworkDisconnect\(\)/, 'IPX 断开超时后必须清除断开状态')
for (const core of ['wdosbox.js', 'wdosbox-x.js', 'wdosbox-x-jspi.js']) {
  const worker = readFileSync(new URL(`emulators/${core}`, runtimeRoot), 'utf8')
  assert.match(worker, /wc-net-peer-id/, `${core} 必须接受运行时更新的 WebRTC peer id`)
}

// 运行从实际 js-dos 主 bundle 抽出的闭包：普通单机不开 peer、并发点击只建一份网络，且迟到结果会关闭。
const apiStart = main.indexOf('e.__8bitgoEnsureIpxNetwork=')
const apiEnd = main.indexOf(';_?e.sendBackendEvent', apiStart)
assert.ok(apiStart >= 0 && apiEnd > apiStart, '必须从 js-dos 实际产物中定位按需 IPX API')
const lazyApi = main.slice(apiStart, apiEnd)
const makeLazyIpxHarness = ({ sharedNet = false, createNet, timeoutScale = 1 } = {}) => {
  let attached = null
  const e = {
    exited: false,
    net: () => attached,
    setNet(net) { attached = net; return net },
  }
  const f = { ci: e, options: { sharedNet }, net: undefined }
  const context = {
    e,
    f,
    Al: createNet,
    console: { log() {}, error() {} },
    Promise,
    setTimeout(callback, ms) { return setTimeout(callback, Math.max(1, ms * timeoutScale)) },
    clearTimeout,
  }
  vm.runInNewContext(lazyApi, context, { timeout: 5_000 })
  return { e, f, get attached() { return attached } }
}
{
  let createCount = 0
  let resolveNetwork
  const networkReady = new Promise((resolve) => { resolveNetwork = resolve })
  const harness = makeLazyIpxHarness({ createNet: async () => { createCount++; return networkReady } })
  assert.equal(createCount, 0, '单机 DOS 初始化本身不能建立 WebRTC peer')
  const first = harness.e.__8bitgoEnsureIpxNetwork()
  const second = harness.e.__8bitgoEnsureIpxNetwork()
  assert.equal(createCount, 1, '快速重复点击只能建立一个 WebRTC peer')
  const network = { peerId: 22, shutdownCount: 0, shutdown() { this.shutdownCount++ } }
  resolveNetwork(network)
  assert.strictEqual(await first, network)
  assert.strictEqual(await second, network)
  assert.strictEqual(harness.attached, network, '网络应挂到当前会话而不是重启 DOS')
  assert.strictEqual(await harness.e.__8bitgoEnsureIpxNetwork(), network, '已初始化的网络应复用')
  harness.e.__8bitgoReleaseIpxNetwork()
  assert.equal(harness.attached, null, '关闭 IPX 应从 CI 摘掉网络')
  assert.equal(network.shutdownCount, 1, '本站创建的网络应关闭')
}
{
  let resolveNetwork
  const networkReady = new Promise((resolve) => { resolveNetwork = resolve })
  const harness = makeLazyIpxHarness({ createNet: async () => networkReady })
  const pending = harness.e.__8bitgoEnsureIpxNetwork()
  harness.e.__8bitgoReleaseIpxNetwork()
  const late = { peerId: 23, shutdownCount: 0, shutdown() { this.shutdownCount++ } }
  resolveNetwork(late)
  await assert.rejects(pending, /cancelled/)
  assert.equal(harness.attached, null, '离页后的迟到结果不能挂回已经销毁的游戏')
  assert.equal(late.shutdownCount, 1, '离页后的迟到网络必须关闭')
}
{
  let resolveNetwork
  const networkReady = new Promise((resolve) => { resolveNetwork = resolve })
  const harness = makeLazyIpxHarness({ createNet: async () => networkReady, timeoutScale: 0.0001 })
  const pending = harness.e.__8bitgoEnsureIpxNetwork()
  await assert.rejects(pending, /timed out/)
  const late = { peerId: 24, shutdownCount: 0, shutdown() { this.shutdownCount++ } }
  resolveNetwork(late)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(harness.attached, null, '初始化超时后的迟到结果不能挂到会话')
  assert.equal(late.shutdownCount, 1, '初始化超时后的迟到 peer 必须关闭')
}
{
  const shared = { peerId: 25, shutdownCount: 0, shutdown() { this.shutdownCount++ } }
  const harness = makeLazyIpxHarness({ sharedNet: shared, createNet: async () => shared })
  assert.strictEqual(await harness.e.__8bitgoEnsureIpxNetwork(), shared)
  harness.e.__8bitgoReleaseIpxNetwork()
  assert.strictEqual(harness.attached, shared, '共享 Net 必须由共享持有方管理')
  assert.equal(shared.shutdownCount, 0, '不能关闭其它会话持有的共享 Net')
}

// 在真正的发布版 emulators.js 上验证动态 attach、收包轮询、detach 和连接超时，不只检查补丁字符串。
const runtimeContext = {
  console,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Uint8Array,
  ArrayBuffer,
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  WebAssembly,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Number,
  Math,
  Object,
  Array,
  Error,
  Reflect,
  Date,
  RegExp,
  JSON,
}
runtimeContext.global = runtimeContext
runtimeContext.window = runtimeContext
runtimeContext.self = runtimeContext
runtimeContext.globalThis = runtimeContext
runtimeContext.navigator = {}
runtimeContext.document = { createElement() { return {} }, querySelector() { return null } }
vm.runInNewContext(emulators, runtimeContext, { timeout: 5_000 })
let messageHandler
const messages = []
const transport = {
  sessionId: 'ipx-test',
  net: null,
  initMessageHandler(handler) { messageHandler = handler },
  sendMessageToServer(name, props) { messages.push({ name, props }) },
}
const ciPromise = runtimeContext.emulators.backend([], transport, () => {}, {})
messageHandler('ws-server-ready', { sessionId: 'ipx-test' })
const ci = await ciPromise
let incoming = true
let polled = 0
const net = {
  peerId: 123,
  connected: new Set(),
  wait() { polled++ },
  recvBinary() {
    if (!incoming) return null
    incoming = false
    return { peerId: 456, data: Uint8Array.from([1, 2, 3]) }
  },
  registerAlias: async () => {},
  unregisterAlias() {},
  queryAliases: async () => [],
}
ci.setNet(net)
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(ci.net(), net, '运行中的 CI 应能读到按需挂载的 Net')
assert.ok(polled > 0, '按需挂载后必须启动网络轮询')
assert.ok(messages.some((item) => item.name === 'wc-net-peer-id' && item.props.peerId === 123), 'worker 必须收到新 peer id')
assert.ok(messages.some((item) => item.name === 'wc-net-received' && item.props.peerId === 456), '网络收包必须继续转发到 worker')
const pendingConnect = ci.networkConnect(0, '456')
assert.equal(ci.cancelNetworkConnect(), true, '握手超时应能清除正在等待的连接')
await assert.rejects(pendingConnect, /timed out/)
assert.ok(messages.some((item) => item.name === 'wc-disconnect'), '取消握手必须通知 DOSBox 停止连接')
const pendingDisconnect = ci.networkDisconnect(0)
assert.equal(ci.cancelNetworkDisconnect(), true, '断开回执超时应能清除底层状态锁')
await pendingDisconnect
ci.setNet(null)
assert.equal(ci.net(), null, '离开 IPX 房间后应能停止轮询并摘除网络')
const exit = ci.exit()
messageHandler('ws-exit', { sessionId: 'ipx-test' })
await exit

console.log('js-dos IPX 地址、按需初始化、弱网超时与运行时挂载回归通过')
