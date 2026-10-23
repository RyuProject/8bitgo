import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { fixSockfsDgramPoll, installNdsWfcRuntime, isWorldAtWarNdsRomHeader, loadNdsWfcSettings, ndsWfcMacAddress, ndsWfcSocketUrl, saveNdsWfcSettings } from '../src/emulator/ndsWfc.ts'
import { NDS_WFC_SETTINGS_PATH, NDS_WFC_SETTINGS_SIZE } from '../src/emulator/ndsStartup.ts'
import { buildDnsAReply, dnsAnswerIpsFor, installNdsWfcDnsShim, LocalDnsSocket, parseDnsQuestion, parseRelayUrl, PooledSocket, RetryingWebSocket, sanitizeDnsTable } from '../src/emulator/ndsWfcDns.ts'

const storedMac = new Map()
const macWindow = {
  localStorage: {
    getItem: (key) => storedMac.get(key) ?? null,
    setItem: (key, value) => storedMac.set(key, value),
  },
  crypto: { getRandomValues: (bytes) => { bytes.set([0x12, 0x34, 0x56]); return bytes } },
}
// 任天堂 OUI；旧版 v1 的 00:08:BF 不再沿用
storedMac.set('8bitgo:nds-wfc-mac-v1', '00:08:bf:aa:bb:cc')
assert.equal(ndsWfcMacAddress(macWindow), '00:09:bf:12:34:56')
assert.equal(storedMac.get('8bitgo:nds-wfc-mac-v2'), '00:09:bf:12:34:56')
assert.equal(ndsWfcMacAddress(macWindow), '00:09:bf:12:34:56')

// WFC 设置（WFC 用户 ID 等）按网卡地址存取；长度不对、全 0 的都不能当成有效存档
assert.equal(NDS_WFC_SETTINGS_PATH, '/home/web_user/retroarch/userdata/system/melonDS DS/wfcsettings.bin')
assert.equal(NDS_WFC_SETTINGS_SIZE, 2304)
const wfcStore = new Map()
const storage = { getItem: (key) => wfcStore.get(key) ?? null, setItem: (key, value) => wfcStore.set(key, value) }
const settings = new Uint8Array(NDS_WFC_SETTINGS_SIZE).map((_, i) => (i * 7) & 0xff)
assert.equal(loadNdsWfcSettings('00:09:BF:12:34:56', NDS_WFC_SETTINGS_SIZE, storage), null)
assert.equal(saveNdsWfcSettings('00:09:BF:12:34:56', settings, NDS_WFC_SETTINGS_SIZE, storage), true)
assert.deepEqual(loadNdsWfcSettings('00:09:bf:12:34:56', NDS_WFC_SETTINGS_SIZE, storage), settings)
assert.equal(loadNdsWfcSettings('00:09:bf:ff:ff:ff', NDS_WFC_SETTINGS_SIZE, storage), null, '另一台虚拟 DS 不能拿到这台的 WFC ID')
assert.equal(saveNdsWfcSettings('00:09:bf:12:34:56', new Uint8Array(NDS_WFC_SETTINGS_SIZE), NDS_WFC_SETTINGS_SIZE, storage), false)
assert.equal(saveNdsWfcSettings('00:09:bf:12:34:56', new Uint8Array(10), NDS_WFC_SETTINGS_SIZE, storage), false)
assert.deepEqual(loadNdsWfcSettings('00:09:bf:12:34:56', NDS_WFC_SETTINGS_SIZE, storage), settings)

const session = { token: 'A'.repeat(32), path: '/api/nds-wfc/socket/', instanceId: 'b'.repeat(16) }
const header = new Uint8Array(16)
header.set(Buffer.from('CALLOFDUTY5'), 0)
header.set(Buffer.from('CALE'), 12)
assert.equal(isWorldAtWarNdsRomHeader(header), true)
header.set(Buffer.from('CALP'), 12)
assert.equal(isWorldAtWarNdsRomHeader(header), true)
header[12] = 0
assert.equal(isWorldAtWarNdsRomHeader(header), false)
header.set(Buffer.from('CALE'), 12)
header[0] = 0
assert.equal(isWorldAtWarNdsRomHeader(header), false)
assert.equal(
  ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 2, 'socket[12]'),
  `wss://8bitgo.com/api/nds-wfc/socket/${session.token}/udp/178.62.43.212/53/12/${session.instanceId}`,
)
assert.equal(
  ndsWfcSocketUrl('http://127.0.0.1:5173', session, '95.217.77.151', 29900, 1),
  `ws://127.0.0.1:5173/api/nds-wfc/socket/${session.token}/tcp/95.217.77.151/29900`,
)
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, 'localhost', 80, 1))
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 99))
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 2))
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 2, 'socket[../1]'))

const win = { EJS_Runtime: (config) => config }
assert.equal(installNdsWfcRuntime(win, session, 'https://8bitgo.com'), true)
assert.equal(installNdsWfcRuntime(win, session, 'https://8bitgo.com'), true)
const moduleConfig = win.EJS_Runtime({ noInitialRun: true })
assert.equal(moduleConfig.noInitialRun, true)
assert.equal(moduleConfig.websocket.url('178.62.43.212', 53, 2, 'socket[12]'),
  `wss://8bitgo.com/api/nds-wfc/socket/${session.token}/udp/178.62.43.212/53/12/${session.instanceId}`)
assert.equal(moduleConfig.websocket.subprotocol, 'binary')
const renewed = { ...session, token: 'B'.repeat(32) }
assert.equal(installNdsWfcRuntime(win, renewed, 'https://8bitgo.com'), true)
assert.equal(moduleConfig.websocket.url('178.62.43.212', 53, 2, 'socket[12]'),
  `wss://8bitgo.com/api/nds-wfc/socket/${session.token}/udp/178.62.43.212/53/12/${session.instanceId}`)
assert.equal(win.EJS_Runtime({}).websocket.url('95.217.77.151', 29900, 1),
  `wss://8bitgo.com/api/nds-wfc/socket/${renewed.token}/tcp/95.217.77.151/29900`)
// ---- SOCKFS 的 UDP poll：没数据时不能报可读，否则 libslirp 每次 poll 都回客体一个 ICMP 不可达 ----
{
  // 与发布核心里的 SOCKFS poll 同构：UDP 没有 peer，`!dest` 让它永远可读
  const sockOps = {
    poll(sock) {
      const dest = sock.type === 1 ? sock.peer : null
      let mask = 0
      if (sock.recv_queue.length || !dest) mask |= 64 | 1
      if (!dest || dest.socket.readyState === 1) mask |= 4
      return mask
    },
  }
  const udp = { type: 2, recv_queue: [], sock_ops: sockOps }
  const tcp = { type: 1, recv_queue: [], sock_ops: sockOps, peer: { socket: { readyState: 1 } } }
  const fs = { streams: [null, { node: { name: 'socket[3]', sock: udp } }, { node: { name: 'socket[4]', sock: tcp } }] }
  const pollWin = { EJS_Runtime: (config) => { config.FS = fs; return config } }
  assert.equal(installNdsWfcRuntime(pollWin, session, 'https://8bitgo.com'), true)
  const pollModule = pollWin.EJS_Runtime({})
  assert.equal(udp.sock_ops.poll(udp) & 0x41, 0x41, '未修补前 UDP 永远可读（复现线上问题）')
  pollModule.websocket.url('178.62.43.212', 53, 2, 'socket[3]')
  assert.equal(udp.sock_ops.poll(udp), 4, '空 UDP socket 只能报可写')
  udp.recv_queue.push({ data: new Uint8Array(4) })
  assert.equal(udp.sock_ops.poll(udp) & 0x41, 0x41, '有数据的 UDP socket 仍然可读')
  assert.equal(tcp.sock_ops.poll(tcp), 4, 'TCP 不受影响')
  assert.equal(fixSockfsDgramPoll(udp), false, '共用的 sock_ops 只包一次')
  // 没有 FS 的模块（单测里的假工厂）也不能让 URL 工厂报错
  assert.ok(win.EJS_Runtime({}).websocket.url('178.62.43.212', 53, 2, 'socket[9]').includes('/udp/178.62.43.212/53/9/'))
}

// ---- 浏览器本地 DNS 应答：DS 每 ~2 秒换 socket 重查，不能每次都等 WSS + 跨洲 DNS ----
const dnsQuery = (id, name) => new Uint8Array([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  ...name.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]), 0, 0, 1, 0, 1])
const nasQuery = dnsQuery(0x1234, 'nas.nintendowifi.net')
const nasQuestion = parseDnsQuestion(nasQuery)
assert.equal(nasQuestion.name, 'nas.nintendowifi.net')
const localReply = buildDnsAReply(nasQuery, nasQuestion, ['178.62.43.212'])
assert.equal(localReply[0], 0x12)
assert.equal(localReply[1], 0x34)
assert.equal(localReply[2] & 0x80, 0x80)
assert.deepEqual(dnsAnswerIpsFor(localReply, 'nas.nintendowifi.net'), ['178.62.43.212'])
assert.equal(sanitizeDnsTable({ server: '178.62.43.212', answers: { 'evil.example.com': ['1.2.3.4'], 'NAS.nintendowifi.net': ['178.62.43.212', 'x'] } })
  .answers['evil.example.com'], undefined, '表里不能混进非 WFC 域名')
assert.deepEqual(sanitizeDnsTable({ server: '178.62.43.212', answers: { 'NAS.nintendowifi.net': ['178.62.43.212', 'x'] } }).answers,
  { 'nas.nintendowifi.net': ['178.62.43.212'] })
assert.equal(sanitizeDnsTable({ server: 'evil', answers: {} }), null)
assert.equal(sanitizeDnsTable({ server: '999.1.2.3', answers: {} }), null, 'DNS 中继地址必须是有效公网 IPv4')
assert.deepEqual(sanitizeDnsTable({ server: '178.62.43.212', answers: { 'nas.nintendowifi.net': ['192.168.1.1', '95.217.77.151'] } }).answers,
  { 'nas.nintendowifi.net': ['95.217.77.151'] }, 'DNS 缓存不能把内网地址带进模拟器')

class FakeRealSocket {
  static created = []
  static direct = () => FakeRealSocket.created.filter((ws) => !ws.url.includes('/pool/'))
  static pooled = () => FakeRealSocket.created.filter((ws) => ws.url.includes('/pool/'))
  readyState = 0
  sent = []
  constructor(url, protocols) { this.url = url; this.protocols = protocols; FakeRealSocket.created.push(this) }
  send(data) { this.sent.push(typeof data === 'string' ? data : new Uint8Array(data)) }
  close() { this.readyState = 3 }
}
const shimWin = { WebSocket: FakeRealSocket }
const dnsTable = { server: '178.62.43.212', answers: { 'nas.nintendowifi.net': ['178.62.43.212'] } }
assert.equal(installNdsWfcDnsShim(shimWin, dnsTable, '/api/nds-wfc/socket/'), true)
const dnsUrl = `wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/udp/178.62.43.212/53/3/${'b'.repeat(16)}`
const local = new shimWin.WebSocket(dnsUrl, ['binary'])
assert.ok(local instanceof LocalDnsSocket, 'DNS 节点:53 必须换成本地应答 socket')
assert.equal(FakeRealSocket.direct().length, 0, '表里有的名字一条真 WSS 都不该开')
assert.equal(FakeRealSocket.pooled().length, 4, '没传池地址时，客体一开始查 DNS 就预热 4 条中继连接')
assert.equal(FakeRealSocket.pooled()[0].url, `wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/pool/${'b'.repeat(16)}`)
await new Promise((resolve) => { local.onopen = resolve })
assert.equal(local.readyState, local.OPEN)
const localAnswer = new Promise((resolve) => { local.onmessage = (event) => resolve(new Uint8Array(event.data)) })
local.send(nasQuery.buffer.slice(0))
assert.deepEqual(dnsAnswerIpsFor(await localAnswer, 'nas.nintendowifi.net'), ['178.62.43.212'])
// 核心在 EmulatorJS 的 iframe 里：SOCKFS 交来的 ArrayBuffer 属于另一个 realm，instanceof 判断会失效
const foreignQuery = vm.runInNewContext('Uint8Array.from(bytes).buffer', { bytes: [...nasQuery] })
assert.equal(foreignQuery instanceof ArrayBuffer, false, '测试前提：这是另一个 realm 的 ArrayBuffer')
const foreignAnswer = new Promise((resolve) => { local.onmessage = (event) => resolve(new Uint8Array(event.data)) })
local.send(foreignQuery)
assert.deepEqual(dnsAnswerIpsFor(await foreignAnswer, 'nas.nintendowifi.net'), ['178.62.43.212'],
  '跨 realm 的查询也必须当场作答（以前被当成空包转发，最后报 52100）')
// 表里没有的名字：懒开一条真中继 WSS，答案回来后记进表，之后就地作答
const gpQuery = dnsQuery(0x2222, 'gpcm.gs.nintendowifi.net')
local.send(gpQuery)
// 池里的连接还没 OPEN：退回新开一条带重试的直连
assert.equal(FakeRealSocket.direct().length, 1)
assert.equal(FakeRealSocket.direct()[0].url, dnsUrl)
const upstream = FakeRealSocket.direct()[0]
upstream.readyState = 1
upstream.onopen({})
assert.deepEqual([...upstream.sent[0]], [...gpQuery])
const gpReply = buildDnsAReply(gpQuery, parseDnsQuestion(gpQuery), ['95.217.77.151'])
const forwarded = new Promise((resolve) => { local.onmessage = (event) => resolve(new Uint8Array(event.data)) })
upstream.onmessage({ data: vm.runInNewContext('Uint8Array.from(bytes).buffer', { bytes: [...gpReply] }) })
assert.deepEqual(dnsAnswerIpsFor(await forwarded, 'gpcm.gs.nintendowifi.net'), ['95.217.77.151'])
assert.deepEqual(dnsTable.answers['gpcm.gs.nintendowifi.net'], ['95.217.77.151'])
local.close()
assert.equal(local.readyState, local.CLOSED)
// DNS 转发异常/核心重复查询不能无限累计事务映射；关闭时也要释放排队包和映射。
{
  const existingSockets = FakeRealSocket.created.slice()
  FakeRealSocket.created.length = 0
  const limited = new LocalDnsSocket(dnsUrl, ['binary'], { server: '178.62.43.212', answers: {} }, FakeRealSocket)
  await new Promise((resolve) => { limited.onopen = resolve })
  limited.send(dnsQuery(1, 'gpcm.gs.nintendowifi.net'))
  const dnsUpstream = FakeRealSocket.direct()[0]
  dnsUpstream.readyState = 1
  dnsUpstream.onopen({})
  for (let id = 2; id < 42; id++) limited.send(dnsQuery(id, 'gpcm.gs.nintendowifi.net'))
  assert.equal(limited.pendingNames.size, 32, 'DNS 答案学习映射必须有固定上限')
  limited.close()
  assert.equal(limited.pendingNames.size, 0)
  assert.equal(limited.upstreamQueue.length, 0)
  FakeRealSocket.created.push(...existingSockets)
}
// 池里有已 OPEN 的连接时，客体的 TCP connect 直接拿一条：先发 bind 文本帧，随后异步宣布 OPEN
for (const ws of FakeRealSocket.pooled()) { ws.readyState = 1; ws.onopen({}) }
const tcpUrl = `wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/tcp/178.62.43.212/443`
const pooledTcp = new shimWin.WebSocket(tcpUrl, ['binary'])
assert.ok(pooledTcp instanceof PooledSocket, '有预热连接时 TCP 不能再等一次 WSS 握手')
const bound = FakeRealSocket.pooled().find((ws) => ws.sent.length)
assert.deepEqual(JSON.parse(bound.sent[0]), { protocol: 'tcp', host: '178.62.43.212', port: 443 })
await new Promise((resolve) => { pooledTcp.onopen = resolve })
assert.equal(pooledTcp.readyState, 1)
pooledTcp.send(new Uint8Array([0x16, 3, 0]).buffer)
assert.deepEqual([...bound.sent[1]], [0x16, 3, 0])
const pooledData = new Promise((resolve) => { pooledTcp.onmessage = (event) => resolve(new Uint8Array(event.data)) })
bound.onmessage({ data: new Uint8Array([0x16, 3, 1]).buffer })
assert.deepEqual([...(await pooledData)], [0x16, 3, 1])
assert.equal(FakeRealSocket.pooled().length, 5, '取走一条后立即补一条')
assert.deepEqual(parseRelayUrl(`wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/udp/95.217.77.151/27900/7/${'b'.repeat(16)}`, '/api/nds-wfc/socket/'),
  { poolUrl: `wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/pool/${'b'.repeat(16)}`, protocol: 'udp', host: '95.217.77.151', port: 27900, socketId: '7' })
// 其它 socket（别的 DNS 节点、池已空时的 TCP）走带重试的直连
for (const ws of FakeRealSocket.pooled()) if (!ws.sent.length) ws.readyState = 3
const tcp = new shimWin.WebSocket(tcpUrl, ['binary'])
assert.ok(tcp instanceof RetryingWebSocket, '中继 TCP 要带握手重试')
const otherDns = new shimWin.WebSocket(`wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/udp/95.217.77.181/53/4/${'b'.repeat(16)}`)
assert.ok(otherDns instanceof RetryingWebSocket)
assert.ok(new shimWin.WebSocket('wss://8bitgo.com/socket.io/?EIO=4') instanceof FakeRealSocket, '站内其它 WebSocket 不能被改动')

// 握手失败（OPEN 之前 close）自动换一条重连；OPEN 之后的断线照常交给 SOCKFS
FakeRealSocket.created.length = 0
const retrying = new RetryingWebSocket('wss://8bitgo.com/api/nds-wfc/socket/x/tcp/178.62.43.212/443', ['binary'], FakeRealSocket, [1, 1])
const events = []
retrying.onopen = () => events.push('open')
retrying.onerror = () => events.push('error')
retrying.onclose = () => events.push('close')
FakeRealSocket.created[0].onerror({})
FakeRealSocket.created[0].onclose({ code: 1006 })
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(FakeRealSocket.created.length, 2, '第一次握手失败后应重连')
assert.deepEqual(events, [], '重试期间不能向 SOCKFS 报错')
FakeRealSocket.created[1].readyState = 1
FakeRealSocket.created[1].onopen({})
assert.equal(retrying.readyState, 1)
retrying.send(new Uint8Array([1, 2]).buffer)
assert.deepEqual([...FakeRealSocket.created[1].sent[0]], [1, 2])
FakeRealSocket.created[1].onclose({ code: 1000 })
assert.deepEqual(events, ['open', 'close'])
assert.equal(FakeRealSocket.created.length, 2, 'OPEN 之后断线不能偷偷重连，否则会把半截 TCP 流接到新连接上')
// 重试用尽才报错
FakeRealSocket.created.length = 0
const failing = new RetryingWebSocket('wss://8bitgo.com/api/nds-wfc/socket/x/tcp/178.62.43.212/443', ['binary'], FakeRealSocket, [1])
const failEvents = []
failing.onerror = () => failEvents.push('error')
failing.onclose = () => failEvents.push('close')
FakeRealSocket.created[0].onclose({ code: 1006 })
await new Promise((resolve) => setTimeout(resolve, 10))
FakeRealSocket.created[1].onclose({ code: 1006 })
assert.deepEqual(failEvents, ['error', 'close'])
assert.equal(failing.readyState, 3)
assert.equal(installNdsWfcDnsShim(shimWin, { server: '178.62.43.212', answers: {} }, '/api/nds-wfc/socket/'), true, '重复安装只换表')
// 开局就预热连接池：conntest 紧跟第一次 DNS，等 DNS 时才开池的话第一条 TCP 必然赶不上（52200）
FakeRealSocket.created.length = 0
const eagerWin = { WebSocket: FakeRealSocket }
const eagerPool = `wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/pool/${'c'.repeat(16)}`
assert.equal(installNdsWfcDnsShim(eagerWin, dnsTable, '/api/nds-wfc/socket/', eagerPool), true)
assert.equal(FakeRealSocket.pooled().length, 4, '安装时就要开好 4 条空闲连接')
assert.ok(FakeRealSocket.pooled().every((ws) => ws.url === eagerPool))
for (const ws of FakeRealSocket.pooled()) { ws.readyState = 1; ws.onopen({}) }
assert.ok(new eagerWin.WebSocket(`wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/tcp/198.62.122.140/80`, ['binary']) instanceof PooledSocket,
  '第一条 TCP（conntest）也要直接用预热连接')

// 同一 iframe 重开游戏后会换会话令牌；旧池必须关闭并按新令牌重建，否则会把首条连接送去过期会话。
FakeRealSocket.created.length = 0
const rotatingWin = { WebSocket: FakeRealSocket }
const poolA = `wss://8bitgo.com/api/nds-wfc/socket/${'A'.repeat(32)}/pool/${'d'.repeat(16)}`
const poolB = `wss://8bitgo.com/api/nds-wfc/socket/${'B'.repeat(32)}/pool/${'d'.repeat(16)}`
assert.equal(installNdsWfcDnsShim(rotatingWin, dnsTable, '/api/nds-wfc/socket/', poolA), true)
const oldPoolSockets = FakeRealSocket.pooled().slice()
assert.equal(oldPoolSockets.length, 4)
assert.equal(installNdsWfcDnsShim(rotatingWin, dnsTable, '/api/nds-wfc/socket/', poolB), true)
assert.ok(oldPoolSockets.every((ws) => ws.readyState === 3), '旧令牌的空闲连接必须释放')
const freshPoolSockets = FakeRealSocket.pooled().filter((ws) => ws.url === poolB)
assert.equal(freshPoolSockets.length, 4)
for (const ws of freshPoolSockets) { ws.readyState = 1; ws.onopen({}) }
const rotatedTcp = new rotatingWin.WebSocket(`wss://8bitgo.com/api/nds-wfc/socket/${'B'.repeat(32)}/tcp/198.62.122.140/80`, ['binary'])
assert.ok(rotatedTcp instanceof PooledSocket, '新会话的首条 TCP 必须使用新池')

// WebSocket 握手若一直停在 CONNECTING，客户端要主动结束本次尝试并按退避策略重连。
class ClosingSocket extends FakeRealSocket {
  close() {
    this.readyState = 3
    this.onclose?.({ type: 'close', code: 1006 })
  }
}
FakeRealSocket.created.length = 0
const timed = new RetryingWebSocket('wss://8bitgo.com/api/nds-wfc/socket/x/tcp/178.62.43.212/443', ['binary'], ClosingSocket, [1], 5)
const timedEvents = []
timed.onerror = () => timedEvents.push('error')
timed.onclose = () => timedEvents.push('close')
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(FakeRealSocket.created.length, 2, 'CONNECTING 超时后必须产生一次受控重试')
assert.deepEqual(timedEvents, ['error', 'close'])
FakeRealSocket.created.length = 0
const cancelRetry = new RetryingWebSocket('wss://8bitgo.com/api/nds-wfc/socket/x/tcp/178.62.43.212/443', ['binary'], ClosingSocket, [80], 5)
const cancelEvents = []
cancelRetry.onerror = () => cancelEvents.push('error')
cancelRetry.onclose = () => cancelEvents.push('close')
await new Promise((resolve) => setTimeout(resolve, 10))
cancelRetry.close()
await new Promise((resolve) => setTimeout(resolve, 90))
assert.equal(FakeRealSocket.created.length, 1, '用户关闭后必须取消等待中的自动重试')
assert.deepEqual(cancelEvents, ['close'], '用户关闭不能伪装成网络错误')

// 以前出现过“源码打了补丁、线上静态核心仍是旧产物”；这次直接验实际发给浏览器的归档。
const archive = fileURLToPath(new URL('../public/emulatorjs/cores/melondsds-wasm.data', import.meta.url))
const shippedJs = execFileSync('7z', ['x', '-so', archive, 'melondsds_libretro.js'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
assert.ok(shippedJs.includes('SOCKFS.websocketArgs["url"](addr,port,sock.type,sock.stream.node.name)'), '发布核心缺少逐 socket WFC 路由补丁')
// 运行时修补 UDP poll 依赖这两处：Module 就是传给工厂的对象、FS 挂在 Module 上
assert.ok(shippedJs.includes('var Module=moduleArg;'), '核心不再直接使用传入的 Module 对象，UDP poll 修补拿不到 FS')
assert.ok(shippedJs.includes('Module["FS"]=FS'), '核心没有导出 FS，UDP poll 修补拿不到 socket')
const shippedWasm = execFileSync('7z', ['x', '-so', archive, 'melondsds_libretro.wasm'], { maxBuffer: 16 * 1024 * 1024 })
assert.ok(shippedWasm.includes(Buffer.from('/8bitgo-wfc-mac.txt')), '发布核心没有登记逐浏览器 MAC 选项，RetroArch 会静默回退共享默认地址')
console.log('NDS WFC：核心工厂注入及 TCP/UDP 目标路由检查通过')
