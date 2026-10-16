import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import express from 'express'
import { createServer as createHttpServer } from 'node:http'
import { WebSocket } from 'ws'
import {
  createCs16RelayService,
  isPublicIpv4,
  parseDirectAddress,
  parseServerInfo,
  probeServer,
  queryPublicDirectory,
  readCs16RelayConfig,
} from '../src/cs16-relay.js'

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address()))
})
const close = (server) => new Promise((resolve) => server.close(resolve))
const bindUdp = (socket) => new Promise((resolve, reject) => {
  socket.once('error', reject)
  socket.bind(0, '127.0.0.1', () => resolve(socket.address()))
})

const cstring = (value) => Buffer.from(`${value}\0`, 'utf8')
const infoPacket = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x30]),
  cstring('8BitGo Test Server'),
  cstring('de_dust2'),
  cstring('cstrike'),
  cstring('Counter-Strike'),
  Buffer.from([0x0a, 0x00, 0x03, 0x10, 0x00, 0x64, 0x6c, 0x00, 0x01]),
  cstring('1.1.2.7/Stdio'),
])

const udp = dgram.createSocket('udp4')
let challenged = false
udp.on('message', (message, remote) => {
  if (message.length > 5 && message[4] === 0x54) {
    if (!challenged) {
      challenged = true
      udp.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x12, 0x34, 0x56, 0x78]), remote.port, remote.address)
    } else {
      udp.send(infoPacket, remote.port, remote.address)
    }
    return
  }
  if (message[0] === 0xfa) {
    for (let index = 0; index < 40; index += 1) {
      udp.send(Buffer.from([0x46, index]), remote.port, remote.address)
    }
    return
  }
  udp.send(Buffer.concat([Buffer.from([0x45]), message]), remote.port, remote.address)
})
const udpAddress = await bindUdp(udp)

const env = {
  CS16_PUBLIC_DIRECTORY: '0',
  CS16_SERVERS_JSON: JSON.stringify([{
    id: 'arena',
    name: '8BitGo Dust II',
    host: '127.0.0.1',
    port: udpAddress.port,
    map: 'de_dust2',
    region: 'CN',
    netId: 42,
    maxPlayers: 16,
  }]),
  CS16_ALLOWED_ORIGINS: 'http://allowed.test',
  CS16_RELAY_CONNECT_TIMEOUT_MS: '500',
  CS16_RELAY_PROBE_TIMEOUT_MS: '500',
  CS16_RELAY_HEARTBEAT_INTERVAL_MS: '5000',
  CS16_RELAY_MAX_PACKETS_PER_SECOND: '32',
}
const silent = { log() {}, warn() {} }
let directProbeCalls = 0
let directProbeMode = 'good'
const service = createCs16RelayService({
  env,
  logger: silent,
  probe: async (candidate, timeoutMs) => {
    if (candidate.host !== '8.8.8.8') return probeServer(candidate, timeoutMs)
    directProbeCalls += 1
    return {
      name: 'Typed IP Dust II', map: directProbeMode === 'good' ? 'de_dust2' : 'de_inferno', folder: 'cstrike', appId: 10,
      protocol: 48, players: 5, maxPlayers: 16, password: false, pingMs: 21,
    }
  },
})
const app = express()
app.use(express.json())
app.use('/api/cs16', service.router)
app.get('/still-alive', (_req, res) => res.json({ ok: true }))
const http = createHttpServer(app)
service.attach(http)
const httpAddress = await listen(http)
const httpOrigin = `http://127.0.0.1:${httpAddress.port}`
const wsUrl = `${httpOrigin.replace('http:', 'ws:')}/api/cs16/relay?server=arena`

const rejectedStatus = (url, origin) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { origin })
  ws.once('unexpected-response', (_request, response) => {
    response.resume()
    resolve(response.statusCode)
  })
  ws.once('error', () => {})
  setTimeout(() => reject(new Error('等待 WebSocket 拒绝响应超时')), 1500).unref()
})

const openRelay = (url, origin) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { origin })
  const timer = setTimeout(() => reject(new Error('等待 relay ready 超时')), 1500)
  timer.unref()
  ws.once('error', reject)
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const message = JSON.parse(data.toString())
    if (message.type === 'ready') {
      clearTimeout(timer)
      resolve(ws)
    }
  })
})

try {
  assert.deepEqual(parseServerInfo(infoPacket), {
    name: '8BitGo Test Server',
    map: 'de_dust2',
    folder: 'cstrike',
    appId: 10,
    protocol: 48,
    players: 3,
    maxPlayers: 16,
    password: false,
    vac: true,
  })

  assert.equal(isPublicIpv4('8.8.8.8'), true)
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.2', '192.168.1.1', '203.0.113.5', '224.0.0.1']) {
    assert.equal(isPublicIpv4(address), false, `${address} 不能进入自动 UDP 目标表`)
  }
  assert.deepEqual(parseDirectAddress('8.8.8.8'), { host: '8.8.8.8', port: 27015, family: 4 })
  assert.deepEqual(parseDirectAddress('8.8.8.8:27016'), { host: '8.8.8.8', port: 27016, family: 4 })
  assert.equal(parseDirectAddress('127.0.0.1:27015'), null)
  assert.equal(parseDirectAddress('example.com:27015'), null, 'IP 直连不接受会 DNS 重绑定的域名')

  const automaticConfig = readCs16RelayConfig({})
  assert.equal(automaticConfig.enabled, true, '未配置固定服务器时应默认启用自动公共目录')
  assert.equal(automaticConfig.publicDirectory, true)

  let requestedDirectoryUrl = ''
  const directoryCandidates = await queryPublicDirectory({
    maxCandidates: 8,
    fetchImpl: async (url) => {
      requestedDirectoryUrl = String(url)
      return new Response(JSON.stringify({
        ok: true,
        servers: [
          { ip: '8.8.4.4', port: 27015, country: 'US', map: 'de_dust2' },
          { ip: '127.0.0.1', port: 27015, country: 'LAN', map: 'de_dust2' },
          { ip: '8.8.4.4', port: 27015, country: 'US', map: 'de_dust2' },
          { ip: '1.1.1.1', port: 27015, country: 'AU', map: 'fy_pool_day' },
        ],
      }), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  assert.match(requestedDirectoryUrl, /online=1/)
  assert.deepEqual(directoryCandidates, [{
    host: '8.8.4.4', port: 27015, family: 4, region: 'US', reportedMap: 'de_dust2',
  }])

  const parsed = readCs16RelayConfig({
    CS16_PUBLIC_DIRECTORY: '0',
    CS16_SERVERS_JSON: JSON.stringify([
      { id: 'ok', name: 'OK', host: '127.0.0.1', port: 27015, map: 'de_dust2', netId: 7 },
      { id: 'bad', name: 'Bad', host: 'https://evil.invalid/x', port: 27015, map: 'de_dust2' },
      { id: 'bad-map', name: 'Bad Map', host: '127.0.0.1', port: 27015, map: '../../etc' },
    ]),
    CS16_RELAY_MAX_FRAME_BYTES: '999999999',
  }, ['*'])
  assert.equal(parsed.servers.length, 1, '固定服务器配置必须拒绝 URL 主机和未发布地图')
  assert.equal(parsed.maxFrameBytes, 65507, 'UDP 帧不能超过协议最大长度')
  assert.deepEqual(parsed.allowedOrigins, [], '主站 CORS 的 * 不能让任意网页借用 UDP 桥')

  let publicProbeCalls = 0
  const automaticService = createCs16RelayService({
    env: { CS16_PUBLIC_DIRECTORY: '1', CS16_PUBLIC_MAX_SERVERS: '8' },
    logger: silent,
    queryDirectory: async () => [
      { host: '8.8.8.8', port: 27015, family: 4, region: 'US' },
      { host: '8.8.8.8', port: 27016, family: 4, region: 'US' },
      { host: '8.8.8.8', port: 27017, family: 4, region: 'US' },
      { host: '1.1.1.1', port: 27015, family: 4, region: 'AU' },
      { host: '127.0.0.1', port: 27015, family: 4, region: 'LAN' },
    ],
    probe: async (candidate) => {
      publicProbeCalls += 1
      return {
        name: candidate.port === 27015 ? 'Public Dust II' : 'Wrong Map',
        map: candidate.port === 27015 ? 'de_dust2' : 'fy_pool_day',
        folder: 'cstrike',
        appId: 10,
        protocol: 48,
        players: 7,
        maxPlayers: 20,
        password: candidate.host === '1.1.1.1',
        pingMs: 35,
      }
    },
  })
  const automaticServers = await automaticService.listServers()
  assert.equal(publicProbeCalls, 3, '同一 IP 只允许探测两个端口，私网地址完全不探测')
  assert.equal(automaticServers.length, 1, '自动目录只收录通过 CS1.6、地图与密码校验的服务器')
  assert.match(automaticServers[0].id, /^public-[a-f0-9]{16}$/)
  assert.equal(automaticServers[0].source, 'public-directory')
  assert.equal(automaticServers[0].joinable, true)
  assert.equal('host' in automaticServers[0], false, '自动目录也不能向网页泄露 UDP 目标')
  automaticService.close()

  const offlineService = createCs16RelayService({
    env: {
      CS16_PUBLIC_DIRECTORY: '0',
      CS16_SERVERS_JSON: JSON.stringify([
        { id: 'offline', name: 'Offline', host: '127.0.0.1', port: 27015, map: 'de_dust2', netId: 8 },
      ]),
    },
    logger: silent,
    probe: async () => null,
  })
  const [offlineServer] = await offlineService.listServers()
  assert.equal(offlineServer.online, false)
  assert.equal(offlineServer.joinable, false, 'A2S 离线的固定服务器不能继续显示成可加入')
  offlineService.close()

  let failedDirectoryCalls = 0
  const failingDirectoryService = createCs16RelayService({
    env: { CS16_PUBLIC_DIRECTORY: '1' },
    logger: silent,
    queryDirectory: async () => {
      failedDirectoryCalls += 1
      throw new Error('目录离线')
    },
  })
  assert.deepEqual(await failingDirectoryService.listServers(), [])
  assert.deepEqual(await failingDirectoryService.listServers(), [])
  assert.equal(failedDirectoryCalls, 1, '目录失败必须短期负缓存，不能被公开 GET 接口持续触发重试')
  failingDirectoryService.close()

  assert.deepEqual(await fetch(`${httpOrigin}/still-alive`).then((response) => response.json()), { ok: true })
  const response = await fetch(`${httpOrigin}/api/cs16/servers`)
  assert.match(response.headers.get('cache-control') || '', /no-store/)
  const directory = await response.json()
  assert.equal(directory.enabled, true)
  assert.equal(directory.servers.length, 1)
  assert.equal(directory.servers[0].online, true)
  assert.equal(directory.servers[0].players, 3)
  assert.equal(directory.servers[0].map, 'de_dust2')
  assert.equal(directory.servers[0].netId, 42)
  assert.equal('host' in directory.servers[0], false, '公开目录不能泄露或接受 UDP 目标主机')

  const privateDirect = await fetch(`${httpOrigin}/api/cs16/servers/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '127.0.0.1:27015' }),
  })
  assert.equal(privateDirect.status, 400, '手输 IP 不能把中继变成内网 UDP 探针')
  const crossSiteDirect = await fetch(`${httpOrigin}/api/cs16/servers/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
    body: JSON.stringify({ address: '8.8.8.8:27015' }),
  })
  assert.equal(crossSiteDirect.status, 403, '第三方网页不能借访客浏览器发起 UDP 探测')
  assert.equal(directProbeCalls, 0)
  const directResponse = await fetch(`${httpOrigin}/api/cs16/servers/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '8.8.8.8:27015' }),
  })
  assert.equal(directResponse.status, 200)
  const direct = await directResponse.json()
  assert.match(direct.id, /^direct-[a-f0-9]{16}$/)
  assert.equal(direct.source, 'direct-ip')
  assert.equal(direct.joinable, true)
  assert.equal('host' in direct, false, '手输地址验证后仍不能向浏览器泄露后端 UDP 目标字段')
  assert.equal(directProbeCalls, 1)

  // 从验证 IP 到大资源加载完可能隔数分钟；真正接入时必须再验一次，防止端口已换服务或地图已变。
  directProbeMode = 'changed'
  const directClosed = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${httpOrigin.replace('http:', 'ws:')}/api/cs16/relay?server=${direct.id}`, { origin: 'http://allowed.test' })
    const timer = setTimeout(() => reject(new Error('等待手输 IP 二次验证拒绝超时')), 1500)
    timer.unref()
    ws.once('close', (code) => { clearTimeout(timer); resolve(code) })
    ws.once('error', () => {})
  })
  assert.equal(await directClosed, 1013)
  assert.equal(directProbeCalls, 2, '手输 IP 必须在 WSS 实际接入时二次 A2S 验真')

  assert.equal(await rejectedStatus(wsUrl, 'https://evil.invalid'), 403, '跨站网页不能借用 CS1.6 UDP 桥')
  assert.equal(await rejectedStatus(`${httpOrigin.replace('http:', 'ws:')}/api/cs16/relay?server=unknown`, 'http://allowed.test'), 404)

  // 即使查询串偷偷带 host/port，网关也只按 server=arena 查服务端目标表。
  const ws = await openRelay(`${wsUrl}&host=evil.invalid&port=9`, 'http://allowed.test')
  const reply = new Promise((resolve, reject) => {
    ws.on('message', (data, isBinary) => { if (isBinary) resolve(Buffer.from(data)) })
    ws.once('error', reject)
  })
  ws.send(Buffer.from([0x01, 0x02, 0xff]))
  assert.deepEqual(await reply, Buffer.from([0x45, 0x01, 0x02, 0xff]), 'WSS 与 UDP 必须逐数据报透明转发')
  ws.close()
  await new Promise((resolve) => ws.once('close', resolve))

  const textWs = await openRelay(wsUrl, 'http://allowed.test')
  const textClosed = new Promise((resolve) => textWs.once('close', (code) => resolve(code)))
  textWs.send('not a datagram')
  assert.equal(await textClosed, 1003, '文字帧不能进入 UDP 通路')

  const status = await fetch(`${httpOrigin}/api/cs16/status`).then((res) => res.json())
  assert.equal(status.connections.active, 0)
  assert.equal(status.traffic.packetsFromClient, 1)
  assert.equal(status.traffic.packetsFromServer, 1)

  const floodWs = await openRelay(wsUrl, 'http://allowed.test')
  const floodClosed = new Promise((resolve) => floodWs.once('close', (code) => resolve(code)))
  floodWs.send(Buffer.from([0xfa]))
  assert.equal(await floodClosed, 1008, '恶意或被接管的游戏服不能无上限地向浏览器/网关泛洪')
  console.log('CS1.6 联机自测通过：自动目录、目标校验、同源限制、WSS↔UDP 数据报与连接回收')
} finally {
  service.close()
  await close(http)
  await close(udp)
}
