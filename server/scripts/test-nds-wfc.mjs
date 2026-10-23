import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import net from 'node:net'
import express from 'express'
import { WebSocket } from 'ws'
import { createNdsWfcService, dnsAReply, dnsAnswerIps, dnsQueryName, dnsRefusedReply, dnsServFailReply, gpTraceSummary, natnegConnectPeer, resolveDns4Tcp, wfcDnsStaticIp, wfcDnsUpstream } from '../src/nds-wfc.js'

const labels = 'nas.nintendowifi.net'.split('.')
const name = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])])
const question = Buffer.concat([name, Buffer.from([0, 1, 0, 1])])
const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])
const query = Buffer.concat([header, question])
const queryFor = (hostname, id = 0x5678) => {
  const queryHeader = Buffer.from(header)
  queryHeader.writeUInt16BE(id, 0)
  const labels = Buffer.concat([...hostname.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])])
  return Buffer.concat([queryHeader, labels, Buffer.from([0, 1, 0, 1])])
}
const fallbackName = 'fallback.nintendowifi.net'
const fallbackQuestion = Buffer.concat([
  ...fallbackName.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
  Buffer.from([0, 0, 1, 0, 1]),
])
const fallbackQuery = Buffer.concat([header, fallbackQuestion])
assert.equal(dnsQueryName(query), 'nas.nintendowifi.net')
assert.equal(dnsQueryName(Buffer.concat([header, Buffer.from([3, 98, 97, 100, 0, 0, 1, 0, 1])])), null)
const answer = (ip) => Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...ip])
let dnsTcpQueryCount = 0
const dnsTcpServer = net.createServer((socket) => {
  let received = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk])
    if (received.length < 2) return
    const length = received.readUInt16BE(0)
    if (received.length < length + 2) return
    dnsTcpQueryCount++
    const queryPacket = received.subarray(2, length + 2)
    const responseHeader = Buffer.from(queryPacket.subarray(0, 12))
    responseHeader[2] = 0x81
    responseHeader[3] = 0x80
    responseHeader.writeUInt16BE(1, 6)
    const response = Buffer.concat([responseHeader, queryPacket.subarray(12), answer([95, 217, 77, 151])])
    const responsePrefix = Buffer.alloc(2)
    responsePrefix.writeUInt16BE(response.length)
    const framedResponse = Buffer.concat([responsePrefix, response])
    // 分段回包，确保 TCP 帧解析不依赖一次 data 事件刚好收完整个 DNS 消息。
    socket.write(framedResponse.subarray(0, 3))
    setImmediate(() => socket.end(framedResponse.subarray(3)))
  })
})
await new Promise((resolve) => dnsTcpServer.listen(0, '127.0.0.1', resolve))
const tcpDnsAddress = dnsTcpServer.address()
const tcpDnsIps = await resolveDns4Tcp('178.62.43.212', 'nas.nintendowifi.net', {
  connect: () => net.createConnection({ host: '127.0.0.1', port: tcpDnsAddress.port }),
  timeoutMs: 1_000,
})
assert.deepEqual(tcpDnsIps, ['95.217.77.151'], 'UDP 无回包时必须能通过真正的 DNS-over-TCP 取到 A 记录')
assert.equal(dnsTcpQueryCount, 1)
let blockedDnsConnect = false
await assert.rejects(resolveDns4Tcp('127.0.0.1', 'nas.nintendowifi.net', {
  connect: () => { blockedDnsConnect = true; throw new Error('不应连接未授权 DNS') },
}), { code: 'DNS_TCP_SERVER_NOT_ALLOWED' })
assert.equal(blockedDnsConnect, false, 'DNS-over-TCP 不能把中继扩大成任意外连代理')
await new Promise((resolve, reject) => dnsTcpServer.close((error) => error ? reject(error) : resolve()))
const reply = Buffer.concat([
  Buffer.from([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]),
  question,
  answer([178, 62, 43, 212]),
  answer([127, 0, 0, 1]),
])
assert.deepEqual(dnsAnswerIps(reply, 'nas.nintendowifi.net'), ['178.62.43.212'])
assert.deepEqual(dnsAnswerIps(reply, 'other.nintendowifi.net'), [])
assert.deepEqual(dnsAnswerIps(dnsAReply(query, ['178.62.43.212']), 'nas.nintendowifi.net'), ['178.62.43.212'])
assert.equal(dnsAReply(query, ['127.0.0.1']), null)
const unrelated = Buffer.from('unrelated.nintendowifi.net'.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]).concat(0))
const unrelatedReply = Buffer.concat([
  Buffer.from([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]), question,
  answer([178, 62, 43, 212]), unrelated, Buffer.from([0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 1, 1, 1, 1]),
])
assert.deepEqual(dnsAnswerIps(unrelatedReply, 'nas.nintendowifi.net'), ['178.62.43.212'])
const alias = Buffer.from('alias.example'.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]).concat(0))
const cnameReply = Buffer.concat([
  Buffer.from([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]), question,
  Buffer.from([0xc0, 0x0c, 0, 5, 0, 1, 0, 0, 0, 30, 0, alias.length]), alias,
  alias, Buffer.from([0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 95, 217, 77, 151]),
])
assert.deepEqual(dnsAnswerIps(cnameReply, 'nas.nintendowifi.net'), ['95.217.77.151'])
const badQuery = Buffer.concat([header, Buffer.from([3, 98, 97, 100, 0, 0, 1, 0, 1])])
const refused = dnsRefusedReply(badQuery)
assert.equal(refused.readUInt16BE(0), 0x1234, 'REFUSED 必须沿用查询的事务 ID')
assert.equal(refused[2] & 0x80, 0x80)
assert.equal(refused[3] & 0x0f, 5)
assert.equal(refused.readUInt16BE(4), 1)
assert.equal(refused.readUInt16BE(6), 0)
assert.equal(dnsServFailReply(query)[3] & 0x0f, 2, '上游 DNS 完全失败时应快速返回 SERVFAIL，不应留下悬挂查询')
assert.equal(dnsRefusedReply(reply), null, '响应包不能再被当成查询回复')
assert.equal(gpTraceSummary(Buffer.from('\\lc\\1\\challenge\\X\\final\\')), 'lc 1')
assert.equal(gpTraceSummary(Buffer.from('\\login\\\\challenge\\x\\authtoken\\SECRET\\final\\')), 'login')
assert.equal(gpTraceSummary(Buffer.from('\\error\\\\err\\260\\fatal\\\\errmsg\\Bad login\\id\\1\\final\\')),
  'error err=260 fatal= msg="Bad login"')
assert.equal(gpTraceSummary(Buffer.from('GET / HTTP/1.1')), null)
const natnegConnect = (ip, port, finished = 0) => Buffer.from([
  0xfd, 0xfc, 0x1e, 0x66, 0x6a, 0xb2, 3, 5, 0, 0, 0, 42, ...ip, port >> 8, port & 0xff, 1, finished,
])
assert.deepEqual(natnegConnectPeer(natnegConnect([203, 0, 114, 7], 40000)), { host: '203.0.114.7', port: 40000 })
assert.equal(natnegConnectPeer(natnegConnect([10, 0, 0, 2], 40000)), null, '内网地址不能被 CONNECT 开出口')
assert.equal(natnegConnectPeer(natnegConnect([203, 0, 114, 7], 40000, 1)), null, '撮合失败的 CONNECT 不授权')
assert.equal(natnegConnectPeer(Buffer.from('\\heartbeat\\')), null)

const app = express()
app.use(express.json())
const udpSockets = []
const resolverCalls = []
const tcpSockets = []
class FakeUdpSocket extends EventEmitter {
  sent = []
  closed = false
  connect(_port, _host, callback) { queueMicrotask(callback) }
  send(message, ...args) {
    this.sent.push({ message: Buffer.from(message), args })
    const callback = args.at(-1)
    if (typeof callback === 'function') queueMicrotask(() => callback(null))
    if (args.length === 0 && message.equals(query)) queueMicrotask(() => this.emit('message', dnsAReply(message, ['95.217.77.151'])))
  }
  close() { this.closed = true }
}
class FakeTcpSocket extends EventEmitter {
  sent = []
  writableLength = 0
  destroyed = false
  setNoDelay() {}
  setKeepAlive() {}
  pause() {}
  resume() {}
  write(message) { this.sent.push(Buffer.from(message)); return true }
  destroy() { this.destroyed = true }
}
const service = createNdsWfcService({ enabled: true, udpSocketFactory: () => {
  const socket = new FakeUdpSocket()
  udpSockets.push(socket)
  return socket
}, tcpSocketFactory: () => {
  const socket = new FakeTcpSocket()
  tcpSockets.push(socket)
  return socket
}, dnsResolver: async (host, name) => {
  resolverCalls.push(`${host}|${name}`)
  return name.startsWith('natneg') ? ['95.217.77.152'] : ['95.217.77.151']
} })
app.use('/api/nds-wfc', service.router)
const server = createServer(app)
service.attach(server)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${address.port}`
try {
  const denied = await fetch(`${base}/api/nds-wfc/session`, {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameSlug: 'call-of-duty-world-at-war' }),
  })
  assert.equal(denied.status, 403)

  const sessionResponse = await fetch(`${base}/api/nds-wfc/session`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameSlug: 'call-of-duty-world-at-war' }),
  })
  assert.equal(sessionResponse.status, 200)
  const session = await sessionResponse.json()
  assert.match(session.token, /^[A-Za-z0-9_-]{32}$/)

  const clientId = 'a'.repeat(32)
  const nextSession = await fetch(`${base}/api/nds-wfc/session`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameSlug: 'call-of-duty-world-at-war', clientId }),
  })
  assert.equal(nextSession.status, 200)
  const second = await nextSession.json()
  assert.notEqual(second.token, session.token)
  const reused = await fetch(`${base}/api/nds-wfc/session`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameSlug: 'call-of-duty-world-at-war', clientId }),
  })
  const reusedBody = await reused.json()
  assert.equal(reusedBody.token, second.token)
  // 进程启动 / 建会话时已在后台预解析：会话响应里带上这张表，浏览器可在本地回答 DNS
  assert.equal(reusedBody.dns.server, '178.62.43.212')
  assert.deepEqual(reusedBody.dns.answers['nas.nintendowifi.net'], ['95.217.77.151'])
  assert.deepEqual(reusedBody.dns.answers['gpcm.gs.nintendowifi.net'], ['95.217.77.151'])
  assert.deepEqual(reusedBody.dns.answers['natneg1.gs.nintendowifi.net'], ['95.217.77.152'])
  // 同 IP 的第二个玩家/探针开局后，第一个玩家的 DNS socket 仍必须能升级成功。
  const firstSocket = new WebSocket(`${base.replace('http:', 'ws:')}${session.path}${session.token}/udp/178.62.43.212/53/1/${'a'.repeat(16)}`, {
    headers: { Origin: base },
  })
  await new Promise((resolve, reject) => {
    firstSocket.once('open', resolve)
    firstSocket.once('unexpected-response', (_request, response) => reject(new Error(`旧会话被撤销：${response.statusCode}`)))
    firstSocket.once('error', reject)
  })
  const dnsReply = new Promise((resolve) => firstSocket.once('message', resolve))
  firstSocket.send(query)
  assert.deepEqual(dnsAnswerIps(Buffer.from(await dnsReply), 'nas.nintendowifi.net'), ['95.217.77.151'])
  const cachedReply = new Promise((resolve) => firstSocket.once('message', resolve))
  firstSocket.send(query)
  assert.deepEqual(dnsAnswerIps(Buffer.from(await cachedReply), 'nas.nintendowifi.net'), ['95.217.77.151'])
  // 会话创建时已在后台预热 NAS 等常用名字：DS 的查询直接命中共享缓存，一个包都不必发上游
  assert.equal(udpSockets[0].sent.length, 0, '预热过的名字不应再次访问上游')
  assert.equal(resolverCalls.filter((call) => call === '178.62.43.212|nas.nintendowifi.net').length, 1,
    '同一名字的并发解析与重复查询只能打一次上游')
  // 白名单外的名字只回 REFUSED，同一条 DNS socket 之后的合法查询必须照常可用
  const refusedReply = new Promise((resolve) => firstSocket.once('message', resolve))
  firstSocket.send(badQuery)
  assert.equal(Buffer.from(await refusedReply)[3] & 0x0f, 5)
  assert.equal(firstSocket.readyState, WebSocket.OPEN, '白名单外查询不能关掉整条 DNS socket')
  const fallbackReply = new Promise((resolve) => firstSocket.once('message', resolve))
  firstSocket.send(fallbackQuery)
  assert.deepEqual(dnsAnswerIps(Buffer.from(await fallbackReply), fallbackName), ['95.217.77.151'],
    '上游 UDP DNS 不回包时必须用同一解析节点补答，不能让游戏持续重试到 20100')
  const natnegDnsReply = new Promise((resolve) => firstSocket.once('message', resolve))
  firstSocket.send(queryFor('natneg1.gs.nintendowifi.net'))
  assert.deepEqual(dnsAnswerIps(Buffer.from(await natnegDnsReply), 'natneg1.gs.nintendowifi.net'), ['95.217.77.152'])
  firstSocket.close()
  await new Promise((resolve) => firstSocket.once('close', resolve))

  // 先接受 WebSocket 再连上游：DS 的 connect 约 2 秒就放弃，不能让它再等一次跨洲 TCP 建连。
  // 上游连通前客体发来的数据要先缓存，连通后按顺序转发；挑战包照常送达。
  const gp = new WebSocket(`${base.replace('http:', 'ws:')}${session.path}${session.token}/tcp/95.217.77.151/29900`, {
    headers: { Origin: base },
  })
  await new Promise((resolve, reject) => { gp.once('open', resolve); gp.once('error', reject) })
  for (let i = 0; i < 50 && tcpSockets.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(tcpSockets.length, 1, '接受 WebSocket 的同时应开始连接真实上游')
  gp.send(Buffer.from('\\early\\final\\'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(tcpSockets[0].sent.length, 0, '上游没连通前不能写')
  tcpSockets[0].emit('connect')
  for (let i = 0; i < 50 && tcpSockets[0].sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(tcpSockets[0].sent[0].toString('ascii'), '\\early\\final\\', '连通后要补发缓存的数据')
  const gpChallenge = Buffer.from('\\lc\\1\\challenge\\test\\id\\1\\final\\')
  const receivedChallenge = new Promise((resolve) => gp.once('message', resolve))
  tcpSockets[0].emit('data', gpChallenge)
  assert.deepEqual(Buffer.from(await receivedChallenge), gpChallenge)
  gp.send(Buffer.from('\\login\\test\\final\\'))
  for (let i = 0; i < 50 && tcpSockets[0].sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(tcpSockets[0].sent[1].toString('ascii'), '\\login\\test\\final\\')
  gp.close()
  await new Promise((resolve) => gp.once('close', resolve))

  const failedGp = new WebSocket(`${base.replace('http:', 'ws:')}${session.path}${session.token}/tcp/95.217.77.151/29900`, {
    headers: { Origin: base },
  })
  await new Promise((resolve, reject) => { failedGp.once('open', resolve); failedGp.once('error', reject) })
  for (let i = 0; i < 50 && tcpSockets.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(tcpSockets.length, 2)
  const failedClosed = new Promise((resolve) => failedGp.once('close', resolve))
  tcpSockets[1].emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
  await failedClosed
  assert.equal(tcpSockets[1].destroyed, true, '真实 TCP 拒绝时要关掉 WebSocket，客体看到的是对端关闭')

  // 预热连接池：先开空闲 WSS，首条文本帧绑定目标；未授权目标直接关掉
  const poolUrl = `${base.replace('http:', 'ws:')}${session.path}${session.token}/pool/${'a'.repeat(16)}`
  const pooled = new WebSocket(poolUrl, { headers: { Origin: base } })
  await new Promise((resolve, reject) => { pooled.once('open', resolve); pooled.once('error', reject) })
  pooled.send(JSON.stringify({ protocol: 'tcp', host: '95.217.77.151', port: 29900 }))
  for (let i = 0; i < 50 && tcpSockets.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(tcpSockets.length, 3, '池里的连接绑定后应立即连上游')
  tcpSockets[2].emit('connect')
  pooled.send(Buffer.from('\\login\\pool\\final\\'))
  for (let i = 0; i < 50 && tcpSockets[2].sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(tcpSockets[2].sent[0].toString('ascii'), '\\login\\pool\\final\\')
  const pooledReply = new Promise((resolve) => pooled.once('message', resolve))
  tcpSockets[2].emit('data', Buffer.from('\\lc\\2\\final\\'))
  assert.equal(Buffer.from(await pooledReply).toString('ascii'), '\\lc\\2\\final\\')
  pooled.close()
  await new Promise((resolve) => pooled.once('close', resolve))
  const evilPool = new WebSocket(poolUrl, { headers: { Origin: base } })
  await new Promise((resolve, reject) => { evilPool.once('open', resolve); evilPool.once('error', reject) })
  const evilClosed = new Promise((resolve) => evilPool.once('close', resolve))
  evilPool.send(JSON.stringify({ protocol: 'tcp', host: '203.0.113.9', port: 443 }))
  await evilClosed
  assert.equal(tcpSockets.length, 3, '连接池不能绕过 DNS 授权去连任意地址')

  const wsBase = `${base.replace('http:', 'ws:')}${session.path}${session.token}/udp/95.217.77.151/`
  const openSocket = async (port, instanceId = 'a'.repeat(16)) => {
    const ws = new WebSocket(`${wsBase}${port}/2/${instanceId}`, { headers: { Origin: base } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    return ws
  }
  const peerA = await openSocket(27900)
  const peerB = await openSocket(27901)
  assert.equal(udpSockets.length, 2, '同一个客体 UDP socket 的两个目标应共用一个公网 socket')
  peerA.send(Buffer.from([1]))
  peerB.send(Buffer.from([2]))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(udpSockets[1].sent.map(({ message }) => [...message]), [[1], [2]])
  const replyA = new Promise((resolve) => peerA.once('message', resolve))
  udpSockets[1].emit('message', Buffer.from([3]), { address: '95.217.77.151', port: 27900 })
  assert.deepEqual([...Buffer.from(await replyA)], [3])
  peerA.close()
  await new Promise((resolve) => peerA.once('close', resolve))
  assert.equal(udpSockets[1].closed, false, '第一个目标关闭不应断开第二个目标的公网源端口')
  const replyB = new Promise((resolve) => peerB.once('message', resolve))
  udpSockets[1].emit('message', Buffer.from([4]), { address: '95.217.77.151', port: 27901 })
  assert.deepEqual([...Buffer.from(await replyB)], [4])
  peerB.close()
  await new Promise((resolve) => peerB.once('close', resolve))
  for (let i = 0; i < 50 && !udpSockets[1].closed; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(udpSockets[1].closed, true)

  // NATNEG：未授权的对端不能直连；可信撮合服务器（DNS 授权过的 IP）发来 CONNECT 后只放行那一个 IP:端口。
  const peerUrl = (ip, port) => `${wsBase.replace('95.217.77.151', ip)}${port}/2/${'a'.repeat(16)}`
  const peerStatus = (ip, port) => new Promise((resolve) => {
    const ws = new WebSocket(peerUrl(ip, port), { headers: { Origin: base } })
    ws.once('open', () => { ws.close(); resolve(101) })
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    ws.once('error', () => resolve(0))
  })
  assert.equal(await peerStatus('203.0.114.7', 40000), 403, '撮合之前不能连任意玩家地址')
  const natnegPeerBase = wsBase.replace('95.217.77.151', '95.217.77.152')
  const natnegSocket = new WebSocket(`${natnegPeerBase}27901/2/${'a'.repeat(16)}`, { headers: { Origin: base } })
  await new Promise((resolve, reject) => { natnegSocket.once('open', resolve); natnegSocket.once('error', reject) })
  const natnegGroup = udpSockets.at(-1)
  natnegGroup.emit('message', natnegConnect([203, 0, 114, 7], 40000), { address: '95.217.77.151', port: 27901 })
  assert.equal(await peerStatus('203.0.114.7', 40000), 403, '仅 NAS / GP DNS 授权过的同 IP 不能伪造 NATNEG CONNECT')
  natnegGroup.emit('message', natnegConnect([203, 0, 114, 7], 40000), { address: '95.217.77.152', port: 27900 })
  assert.equal(await peerStatus('203.0.114.7', 40000), 403, 'NATNEG DNS 地址上的非服务端口不能伪造 CONNECT')
  natnegGroup.emit('message', natnegConnect([203, 0, 114, 7], 40000), { address: '198.51.99.1', port: 27901 })
  assert.equal(await peerStatus('203.0.114.7', 40000), 403, '非 DNS 授权来源伪造的 CONNECT 不能开出口')
  natnegGroup.emit('message', natnegConnect([203, 0, 114, 7], 40000), { address: '95.217.77.152', port: 27901 })
  assert.equal(await peerStatus('203.0.114.7', 40000), 101, 'CONNECT 点名的对端必须能直连')
  assert.equal(await peerStatus('203.0.114.7', 40001), 403, '只放行精确端口')
  natnegSocket.close()
  await new Promise((resolve) => natnegSocket.once('close', resolve))

  // 复制标签页会克隆 sessionStorage 令牌，但两台虚拟 DS 绝不能共用同一个公网 UDP 端口。
  const socketsBeforeTabs = udpSockets.length
  const tabA = await openSocket(27900, 'a'.repeat(16))
  const tabB = await openSocket(27900, 'b'.repeat(16))
  assert.equal(udpSockets.length, socketsBeforeTabs + 2)
  tabA.close()
  tabB.close()
  await Promise.all([
    new Promise((resolve) => tabA.once('close', resolve)),
    new Promise((resolve) => tabB.once('close', resolve)),
  ])

  const missingSocketId = new WebSocket(`${wsBase}27900`, { headers: { Origin: base } })
  const missingStatus = await new Promise((resolve) => {
    missingSocketId.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    missingSocketId.once('error', () => resolve(0))
  })
  assert.equal(missingStatus, 400)

  // 即使拿到合法令牌，不能把本站变成访问本机管理接口的通用 TCP/UDP 代理。
  const deniedSocket = new WebSocket(`${base.replace('http:', 'ws:')}${session.path}${session.token}/tcp/127.0.0.1/80`, {
    headers: { Origin: base },
  })
  const status = await new Promise((resolve) => {
    deniedSocket.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    deniedSocket.once('error', () => resolve(0))
  })
  assert.equal(status, 403)
} catch (error) {
  // 升级后的 WebSocket 不归 http.Server 管，server.close 会一直等；失败时先把原因打印出来再退出。
  console.error(error)
  process.exit(1)
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

// 自建 WFC：DS 仍向 178.62.43.212 查询，中继改问配置的上游；非法值一律忽略
assert.equal(wfcDnsUpstream(' 103.242.13.112 '), '103.242.13.112')
assert.equal(wfcDnsUpstream('10.0.0.5'), null)
assert.equal(wfcDnsUpstream('evil.example'), null)
assert.equal(wfcDnsUpstream(undefined), null)
assert.equal(wfcDnsStaticIp(' 103.242.13.112 '), '103.242.13.112')
assert.equal(wfcDnsStaticIp('10.0.0.5'), null)
assert.equal(wfcDnsStaticIp('evil.example'), null)
assert.equal(wfcDnsStaticIp(undefined), null)
await assert.rejects(resolveDns4Tcp('103.242.13.112', 'nas.nintendowifi.net'), { code: 'DNS_TCP_SERVER_NOT_ALLOWED' })
{
  const upstreamCalls = []
  const upstreamService = createNdsWfcService({
    enabled: true,
    dnsUpstream: '103.242.13.112',
    dnsResolver: async (host, name, options) => {
      upstreamCalls.push({ host, name, servers: options?.servers ? [...options.servers] : null })
      return ['103.242.13.112']
    },
  })
  assert.ok(upstreamService.enabled)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(upstreamCalls.length > 0, '启动时应预解析')
  assert.ok(upstreamCalls.every((call) => call.host === '103.242.13.112' && call.servers?.[0] === '103.242.13.112'),
    '配置上游后不能再去问 Kaeru')
}

// 自建入口 DNS 53 不可达时，WFC 白名单域名也能稳定解析到同一台受限服务。
{
  let staticResolverCalls = 0
  const staticApp = express()
  staticApp.use(express.json())
  const staticService = createNdsWfcService({
    enabled: true,
    dnsUpstream: '103.242.13.112',
    dnsStaticIp: '103.242.13.112',
    udpSocketFactory: () => new FakeUdpSocket(),
    dnsResolver: async () => { staticResolverCalls++; throw new Error('静态映射不能访问上游 DNS') },
  })
  staticApp.use('/api/nds-wfc', staticService.router)
  const staticServer = createServer(staticApp)
  staticService.attach(staticServer)
  await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve))
  const staticAddress = staticServer.address()
  const staticBase = `http://127.0.0.1:${staticAddress.port}`
  try {
    const response = await fetch(`${staticBase}/api/nds-wfc/session`, {
      method: 'POST', headers: { Origin: staticBase, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSlug: 'call-of-duty-world-at-war' }),
    })
    assert.equal(response.status, 200)
    const session = await response.json()
    assert.deepEqual(session.dns.answers['nas.nintendowifi.net'], ['103.242.13.112'])
    assert.deepEqual(session.dns.answers['gpcm.gs.nintendowifi.net'], ['103.242.13.112'])
    assert.deepEqual(session.dns.answers['natneg1.gs.nintendowifi.net'], ['103.242.13.112'])

    const dnsSocket = new WebSocket(`${staticBase.replace('http:', 'ws:')}${session.path}${session.token}/udp/178.62.43.212/53/9/${'c'.repeat(16)}`, {
      headers: { Origin: staticBase },
    })
    const dynamicDnsAnswer = await new Promise((resolve, reject) => {
      dnsSocket.once('open', () => dnsSocket.send(queryFor('cod5victoryds.available.gs.nintendowifi.net')))
      dnsSocket.once('message', (message) => resolve(Buffer.from(message)))
      dnsSocket.once('error', reject)
    })
    assert.deepEqual(dnsAnswerIps(dynamicDnsAnswer, 'cod5victoryds.available.gs.nintendowifi.net'), ['103.242.13.112'])
    const dnsClosed = new Promise((resolve) => dnsSocket.once('close', resolve))
    dnsSocket.close()
    await dnsClosed
    assert.equal(staticResolverCalls, 0, '静态映射不能再连接不可达的 DNS 53')
  } finally {
    staticServer.closeAllConnections()
    await new Promise((resolve) => staticServer.close(resolve))
  }
}

console.log('NDS WFC：DNS 域名 / 公网 IP / 同源会话 / 内网出口检查通过')
