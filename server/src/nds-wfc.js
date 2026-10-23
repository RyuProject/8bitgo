import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'
import { Router } from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import { clientIpFrom } from './presence.js'
import { take } from './rateLimit.js'

const PATH = '/api/nds-wfc/socket/'
const DNS_SERVERS = new Set(['178.62.43.212', '95.217.77.181', '172.104.88.237'])
// 本次实测 ROM 内的 NAS / GameSpy 域名全部归在 nintendowifi.net；不扩大成任意 DNS 代理。
const WFC_DOMAINS = ['nintendowifi.net']
// 生产探测到 WFC DNS 的 TCP 53 有时要 2～9 秒才回；2 秒会把可用上游误判为不可用，启动预热永远填不满缓存。
const DNS_TCP_TIMEOUT_MS = 10_000
// WFC 只查 A 记录，限制 TCP DNS 响应缓冲，避免坏上游拖大单个会话的内存占用。
const DNS_TCP_MAX_MESSAGE = 4_096
const SESSION_MS = 2 * 60 * 60 * 1000
// DS 固件可能把 DNS 结果缓存整局；中继的授权不能比本局会话短，否则老玩家中途重新建 socket 会被误拒。
const DNS_IP_MS = SESSION_MS
// 同一局里 DS 会反复查询 NAS；30 秒过期会在上游 DNS 短暂抖动时引发整批重试，最终报 20100。
const DNS_CACHE_MS = 10 * 60 * 1000
// 过期后仍可先拿旧答案顶上（同时后台刷新）的时长：Kaeru / Wiimmfi 的入口 IP 很少变，
// 而生产机到这几台 DNS 的 UDP 不回包、TCP 每次又要 2～9 秒，DS 的解析器等不了这么久。
const DNS_STALE_MS = 6 * 60 * 60 * 1000
// 会话一建立就在后台先解析这些名字：玩家真正走到 WFC 登录时，NAS / GP 的查询直接命中缓存。
const DNS_PREWARM_NAMES = [
  'conntest.nintendowifi.net',
  'nas.nintendowifi.net',
  'gpcm.gs.nintendowifi.net',
  'gpsp.gs.nintendowifi.net',
  'natneg1.gs.nintendowifi.net',
  'natneg2.gs.nintendowifi.net',
  'natneg3.gs.nintendowifi.net',
  'gamestats.gs.nintendowifi.net',
  'gamestats2.gs.nintendowifi.net',
]
const NATNEG_DNS_NAMES = new Set(['natneg1.gs.nintendowifi.net', 'natneg2.gs.nintendowifi.net', 'natneg3.gs.nintendowifi.net'])
// GameSpy NATNEG 服务固定从 UDP 27901 回包；仅有 WFC DNS 的 IP 授权不足以信任该 IP 上的任意 UDP 服务。
const NATNEG_SERVER_PORT = 27901
const DNS_DEFAULT_SERVER = '178.62.43.212'
const MAX_SESSIONS = 256
const MAX_SESSIONS_PER_IP = 8
// 一次 WFC 登录会同时挂着：每次 DNS 查询各一个 UDP socket（slirp 10 秒后才回收）、conntest、
// NAS 的若干条 HTTPS（DS 发完 FIN 后网页端 SOCKFS 没有 shutdown，要等服务器关）、GP、GPSP、
// 可用性检查和统计。24 条在重试时会被顶满，后续连接直接 429，游戏只会报 20100 / 61020。
const MAX_SOCKETS_PER_SESSION = 48
const MAX_SOCKETS_TOTAL = 256
const MAX_FRAME = 64 * 1024
const MAX_BUFFERED = 512 * 1024
const MAX_BYTES_PER_SECOND = 1024 * 1024
const MAX_ALLOWED_DNS_IPS = 128

function publicIpv4(host) {
  if (net.isIP(host) !== 4) return false
  const [a, b, c] = host.split('.').map(Number)
  return a > 0 && a < 224 && a !== 10 && a !== 127 && a !== 169 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && c <= 2))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
}

function wfcDomain(name) {
  const lower = String(name).toLowerCase().replace(/\.$/, '')
  return WFC_DOMAINS.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))
}

function dnsName(packet, offset) {
  let at = offset
  let end = -1
  let jumps = 0
  const labels = []
  while (at < packet.length && jumps++ < 24) {
    const length = packet[at++]
    if (length === 0) return { name: labels.join('.'), next: end < 0 ? at : end }
    if ((length & 0xc0) === 0xc0) {
      if (at >= packet.length) return null
      const pointer = ((length & 0x3f) << 8) | packet[at++]
      if (pointer >= packet.length) return null
      if (end < 0) end = at
      at = pointer
      continue
    }
    if (length > 63 || at + length > packet.length) return null
    labels.push(packet.toString('ascii', at, at + length))
    if (labels.join('.').length > 253) return null
    at += length
  }
  return null
}

export function dnsQueryName(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 17 || (packet[2] & 0x80) || packet.readUInt16BE(4) !== 1) return null
  const question = dnsName(packet, 12)
  if (!question || question.next + 4 > packet.length) return null
  return wfcDomain(question.name) ? question.name.toLowerCase() : null
}

export function dnsAnswerIps(packet, expectedName) {
  if (!Buffer.isBuffer(packet) || packet.length < 17 || !(packet[2] & 0x80) || packet.readUInt16BE(4) !== 1) return []
  const question = dnsName(packet, 12)
  if (!question || question.name.toLowerCase() !== expectedName || question.next + 4 > packet.length ||
      packet.readUInt16BE(question.next) !== 1 || packet.readUInt16BE(question.next + 2) !== 1) return []
  let at = question.next + 4
  const records = []
  const count = Math.min(packet.readUInt16BE(6), 32)
  for (let i = 0; i < count; i++) {
    const owner = dnsName(packet, at)
    if (!owner || owner.next + 10 > packet.length) return []
    at = owner.next
    const type = packet.readUInt16BE(at)
    const klass = packet.readUInt16BE(at + 2)
    const size = packet.readUInt16BE(at + 8)
    at += 10
    if (at + size > packet.length) return []
    let target = null
    if (type === 5 && klass === 1) {
      const alias = dnsName(packet, at)
      if (!alias || alias.next !== at + size) return []
      target = alias.name.toLowerCase()
    }
    records.push({ owner: owner.name.toLowerCase(), type, klass, at, size, target })
    at += size
  }
  // DNS 响应可以带无关的 A 记录；只授权查询名及其 CNAME 链，不能把额外记录变成出站白名单。
  const names = new Set([expectedName])
  for (let i = 0; i < records.length; i++) {
    let changed = false
    for (const record of records) {
      if (record.target && names.has(record.owner) && !names.has(record.target)) {
        names.add(record.target)
        changed = true
      }
    }
    if (!changed) break
  }
  const ips = []
  for (const record of records) {
    if (!names.has(record.owner) || record.type !== 1 || record.klass !== 1 || record.size !== 4) continue
    const ip = Array.from(packet.subarray(record.at, record.at + 4)).join('.')
    if (publicIpv4(ip)) ips.push(ip)
  }
  return ips
}

function dnsErrorReply(query, rcode) {
  if (!Buffer.isBuffer(query) || query.length < 12 || (query[2] & 0x80)) return null
  const question = query.readUInt16BE(4) === 1 ? dnsName(query, 12) : null
  const end = question && question.next + 4 <= query.length ? question.next + 4 : 12
  const reply = Buffer.from(query.subarray(0, end))
  // QR=1，保留 opcode 与 RD；RA=1，并返回指定错误码，让客体不必等到 DNS 超时才重试。
  reply[2] = 0x80 | (query[2] & 0x79)
  reply[3] = 0x80 | (rcode & 0x0f)
  reply.writeUInt16BE(end > 12 ? 1 : 0, 4)
  reply.writeUInt16BE(0, 6)
  reply.writeUInt16BE(0, 8)
  reply.writeUInt16BE(0, 10)
  return reply
}

/**
 * 给白名单外的查询回 REFUSED。以前直接关掉整条 WebSocket：客体那边的 UDP socket 还在，
 * 之后同一 socket 发出的 NAS / GameSpy 查询全部石沉大海，游戏只能超时报 20100。
 */
export function dnsRefusedReply(query) {
  return dnsErrorReply(query, 5)
}

export function dnsServFailReply(query) {
  return dnsErrorReply(query, 2)
}

/**
 * GameSpy GP（29900/29901）是明文的 `\cmd\...\final\`。追踪时只记命令名，
 * 服务器的 \error\ 再多记 err / fatal / errmsg —— 61020 到底是哪一步被拒绝，靠这一行定位。
 * 不记录 login 里的 authtoken / response / 会话密钥。
 */
export function gpTraceSummary(data) {
  if (!Buffer.isBuffer(data) || data.length < 3 || data[0] !== 0x5c) return null
  const text = data.subarray(0, 512).toString('latin1')
  const command = /^\\([a-z]{1,16})\\/i.exec(text)?.[1]
  if (!command) return null
  if (command !== 'error') return command === 'lc' ? `lc ${/^\\lc\\(\d)/.exec(text)?.[1] ?? '?'}` : command
  const field = (name) => new RegExp(`\\\\${name}\\\\([^\\\\]{0,120})`).exec(text)?.[1]
  return `error err=${field('err') ?? '?'} fatal=${field('fatal') ?? '?'} msg=${JSON.stringify(field('errmsg') ?? '')}`
}

const NATNEG_MAGIC = Buffer.from([0xfd, 0xfc, 0x1e, 0x66, 0x6a, 0xb2])
const NATNEG_CONNECT = 5
// NATNEG 撮合成功后两边要直接互发 UDP；授权只给 CONNECT 里点名的那一个 IP:端口，10 分钟内有效。
const NATNEG_PEER_MS = 10 * 60 * 1000

/**
 * GameSpy NATNEG 的 CONNECT 包（natneg SDK：magic[6] version type cookie[4] remoteIP[4] remotePort[2]
 * gotyourdata finished）。只有可信撮合服务器发来、finished=0、对端是公网 IPv4 时才返回对端地址。
 */
export function natnegConnectPeer(message) {
  if (!Buffer.isBuffer(message) || message.length < 20 || !message.subarray(0, 6).equals(NATNEG_MAGIC)) return null
  if (message[7] !== NATNEG_CONNECT || message[19] !== 0) return null
  const host = Array.from(message.subarray(12, 16)).join('.')
  const port = message.readUInt16BE(16)
  return publicIpv4(host) && port >= 1024 ? { host, port } : null
}

export function dnsAReply(query, ips) {
  const question = dnsName(query, 12)
  if (!question || question.next + 4 > query.length || ips.length > 8 ||
      query.readUInt16BE(question.next) !== 1 || query.readUInt16BE(question.next + 2) !== 1) return null
  const header = Buffer.alloc(12)
  query.copy(header, 0, 0, 2)
  header.writeUInt16BE(0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(ips.length, 6)
  const records = ips.map((ip) => {
    if (!publicIpv4(ip)) return null
    return Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...ip.split('.').map(Number)])
  })
  if (records.some((record) => !record)) return null
  return Buffer.concat([header, query.subarray(12, question.next + 4), ...records])
}

function originAllowed(req) {
  try {
    const origin = new URL(String(req.headers.origin || ''))
    if (!['http:', 'https:'].includes(origin.protocol)) return false
    if (origin.host === req.headers.host) return true
    // Vite 本地开发代理会把 Host 改成后端的 8788，Origin 仍是前端的 5189。
    // 只给真正从本机回环来的 127.0.0.1 / localhost 放宽端口，公网请求绝不走这条。
    const direct = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
    const target = new URL(`http://${req.headers.host}`)
    return ['127.0.0.1', '::1'].includes(direct) &&
      ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.hostname === target.hostname
  } catch {
    return false
  }
}

function ipOf(req) {
  return clientIpFrom(req.socket?.remoteAddress, req.headers)
}

function reject(socket, status) {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function isPortAllowed(protocol, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  // WFC 的认证 / GameSpy 控制流用固定端口；匹配到真实玩家后 UDP 端口由 NAT 动态分配。
  return protocol === 'tcp' ? [80, 443, 6667, 27900, 28910, 29900, 29901, 29920].includes(port)
    : protocol === 'udp' && (port === 53 || port >= 1024)
}

function isPortHandshake(message) {
  return message.length === 10 && message.subarray(0, 8).equals(Buffer.from([255, 255, 255, 255, 112, 111, 114, 116]))
}

/**
 * 有些 WFC DNS 对这台服务器的 UDP 查询不回包，但 TCP 53 可用；Node Resolver 默认仍走 UDP，
 * 所以超时回退必须自己实现 DNS-over-TCP，不能把同一种 UDP 请求再发一遍。
 */
export function resolveDns4Tcp(host, name, {
  connect = net.createConnection,
  timeoutMs = DNS_TCP_TIMEOUT_MS,
  servers = DNS_SERVERS,
} = {}) {
  if (!servers.has(host)) return Promise.reject(Object.assign(new Error('DNS_TCP_SERVER_NOT_ALLOWED'), { code: 'DNS_TCP_SERVER_NOT_ALLOWED' }))
  const queryName = String(name).toLowerCase().replace(/\.$/, '')
  if (!wfcDomain(queryName)) return Promise.reject(Object.assign(new Error('DNS_TCP_NAME_NOT_ALLOWED'), { code: 'DNS_TCP_NAME_NOT_ALLOWED' }))

  const labels = queryName.split('.')
  if (queryName.length > 253 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/i.test(label))) {
    return Promise.reject(Object.assign(new Error('DNS_TCP_INVALID_NAME'), { code: 'DNS_TCP_INVALID_NAME' }))
  }
  const transactionId = randomBytes(2).readUInt16BE(0)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(transactionId, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const question = Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])),
    Buffer.from([0, 0, 1, 0, 1]),
  ])
  const packet = Buffer.concat([header, question])
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(packet.length, 0)
  const framedQuery = Buffer.concat([prefix, packet])

  return new Promise((resolve, reject) => {
    let socket
    let received = Buffer.alloc(0)
    let settled = false
    const timeout = setTimeout(() => fail('DNS_TCP_TIMEOUT'), timeoutMs)
    timeout.unref?.()
    const finish = (error, ips) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket?.destroy()
      if (error) reject(error)
      else resolve(ips)
    }
    const fail = (code) => finish(Object.assign(new Error(code), { code }))

    try {
      socket = connect({ host, port: 53 })
    } catch (error) {
      fail(error?.code || 'DNS_TCP_CONNECT_FAILED')
      return
    }
    socket.once('connect', () => {
      socket.write(framedQuery, (error) => {
        if (error) fail(error.code || 'DNS_TCP_WRITE_FAILED')
      })
    })
    socket.on('data', (chunk) => {
      if (settled) return
      if (received.length + chunk.length > DNS_TCP_MAX_MESSAGE + 2) return fail('DNS_TCP_RESPONSE_TOO_LARGE')
      received = Buffer.concat([received, chunk])
      if (received.length < 2) return
      const length = received.readUInt16BE(0)
      if (length < 12 || length > DNS_TCP_MAX_MESSAGE) return fail('DNS_TCP_INVALID_FRAME')
      if (received.length < length + 2) return

      const response = received.subarray(2, length + 2)
      if (response.readUInt16BE(0) !== transactionId || !(response[2] & 0x80)) return fail('DNS_TCP_INVALID_RESPONSE')
      const rcode = response[3] & 0x0f
      if (rcode !== 0) return fail(`DNS_TCP_RCODE_${rcode}`)
      const ips = dnsAnswerIps(response, queryName)
      if (!ips.length) return fail('DNS_TCP_NO_PUBLIC_A')
      finish(null, ips)
    })
    socket.once('error', (error) => fail(error?.code || 'DNS_TCP_CONNECT_FAILED'))
    socket.once('end', () => {
      if (!settled) fail('DNS_TCP_INCOMPLETE_RESPONSE')
    })
  })
}

/**
 * 自建 WFC 服务时，中继改向它解析 DNS（`NDS_WFC_DNS_UPSTREAM=<IPv4>`）。
 *
 * DS 这边不用动：melonDS DS 的 WFC DNS 选项只认列表里的几个预设，RetroArch 会静默丢掉自定义 IP
 * （和 MAC 地址同一个坑），所以 DS 仍然向 178.62.43.212 发查询。浏览器本地 DNS 表和中继都把这个
 * 地址当成“DS 面向的 DNS”，真正去问的是这里配置的上游；它答出来的 IP 照常进本局授权。
 * 未配置或不是公网 IPv4 时保持原样（直接问 DS 指定的那台）。
 */
export function wfcDnsUpstream(value = process.env.NDS_WFC_DNS_UPSTREAM) {
  const ip = typeof value === 'string' ? value.trim() : ''
  return ip && publicIpv4(ip) ? ip : null
}

export function createNdsWfcService({
  enabled = process.env.NDS_WFC_ENABLED === '1',
  udpSocketFactory = () => dgram.createSocket('udp4'),
  tcpSocketFactory = (options) => net.createConnection(options),
  dnsResolver = resolveDns4Tcp,
  dnsUpstream = wfcDnsUpstream(),
} = {}) {
  const upstreamDns = wfcDnsUpstream(dnsUpstream ?? '')
  /** DS 面向的 DNS 地址 → 实际去问的上游 */
  const dnsTarget = (host) => upstreamDns ?? host
  const dnsResolverOptions = upstreamDns ? { servers: new Set([upstreamDns]) } : undefined
  const router = Router()
  const sessions = new Map()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  let socketCount = 0
  const trace = (...parts) => { if (process.env.NDS_WFC_TRACE === '1') console.info('[nds-wfc]', ...parts) }

  /*
    全站共享的 WFC DNS 缓存。这些名字的答案对所有玩家都一样（都是 Kaeru / Wiimmfi 的公网入口），
    没必要每局、每次查询都重新跨洲走一遍 TCP DNS。授权仍是按会话的：命中缓存时只给当前会话放行这些 IP。
  */
  const sharedDns = new Map()
  const inflightDns = new Map()
  const sharedKey = (host, name) => `${host}|${name}`
  const rememberDns = (host, name, ips) => {
    if (!ips.length) return
    if (sharedDns.size >= 512) sharedDns.delete(sharedDns.keys().next().value)
    sharedDns.set(sharedKey(host, name), { ips, freshUntil: Date.now() + DNS_CACHE_MS, staleUntil: Date.now() + DNS_STALE_MS })
  }
  const resolveShared = (host, name) => {
    const key = sharedKey(host, name)
    const running = inflightDns.get(key)
    if (running) return running
    const task = Promise.resolve()
      .then(() => dnsResolver(dnsTarget(host), name, dnsResolverOptions))
      .then((ips) => {
        const valid = (Array.isArray(ips) ? ips : []).filter(publicIpv4).slice(0, 8)
        rememberDns(host, name, valid)
        return valid
      })
      .finally(() => inflightDns.delete(key))
    inflightDns.set(key, task)
    return task
  }
  /** 新鲜的直接用；过期但没超出 stale 窗口的也先用，同时后台刷新 */
  const cachedShared = (host, name) => {
    const entry = sharedDns.get(sharedKey(host, name))
    if (!entry) return null
    const now = Date.now()
    if (entry.staleUntil <= now) return null
    if (entry.freshUntil <= now) void resolveShared(host, name).catch((error) => trace('dns refresh error', host, name, error.code))
    return entry.ips
  }
  const prewarmDns = (host = DNS_DEFAULT_SERVER) => {
    for (const name of DNS_PREWARM_NAMES) {
      const entry = sharedDns.get(sharedKey(host, name))
      if (entry && entry.freshUntil > Date.now()) continue
      void resolveShared(host, name).then((ips) => trace('dns prewarm', host, name, ips))
        .catch((error) => trace('dns prewarm error', host, name, error.code))
    }
  }

  function sweep() {
    const now = Date.now()
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now && session.sockets === 0) sessions.delete(token)
      for (const [ip, expiresAt] of session.allowedIps) if (expiresAt <= now) session.allowedIps.delete(ip)
      for (const [ip, expiresAt] of session.allowedNatnegIps) if (expiresAt <= now) session.allowedNatnegIps.delete(ip)
      for (const [peer, expiresAt] of session.allowedPeers) if (expiresAt <= now) session.allowedPeers.delete(peer)
      for (const [name, entry] of session.dnsCache) if (entry.expiresAt <= now) session.dnsCache.delete(name)
    }
  }

  /** 把 DNS 授权按域名用途拆开：普通 WFC 主机可连接，只有 NATNEG 名字的答案能发起撮合授权。 */
  function rememberSessionDns(session, name, ips, now = Date.now()) {
    const expiresAt = now + DNS_IP_MS
    for (const ip of ips) {
      if (!session.allowedIps.has(ip) && session.allowedIps.size >= MAX_ALLOWED_DNS_IPS) {
        session.allowedIps.delete(session.allowedIps.keys().next().value)
      }
      // Map 同时作为有界 LRU：最近实际用过的目标不应被大量旧 DNS 答案挤掉。
      session.allowedIps.delete(ip)
      session.allowedIps.set(ip, expiresAt)
      if (NATNEG_DNS_NAMES.has(name)) session.allowedNatnegIps.set(ip, expiresAt)
    }
  }

  /**
   * 交给浏览器的预解析表：只含 Kaeru 节点、仍在 stale 窗口内的名字。
   *
   * DS 的解析器每 ~2 秒换一个新 UDP socket 重查，而浏览器每个新 socket 都要新开一条 WSS
   * （经 Cloudflare 实测 2.5～3 秒）再加上游 DNS 3～9 秒 —— 永远赶不上，游戏报 52100 / 20100。
   * 有了这张表，浏览器在本地直接回答这些名字（见 src/emulator/ndsWfcDns.ts），
   * 同时这里预先给本会话放行这些 IP，后续 TCP/UDP 连接无需再等 DNS 授权。
   */
  const dnsSnapshot = (session) => {
    const now = Date.now()
    const answers = {}
    for (const [key, entry] of sharedDns) {
      const [host, name] = key.split('|')
      if (host !== DNS_DEFAULT_SERVER || entry.staleUntil <= now || !entry.ips.length) continue
      answers[name] = entry.ips
      rememberSessionDns(session, name, entry.ips, now)
    }
    return { server: DNS_DEFAULT_SERVER, answers }
  }
  if (enabled) {
    // 进程一启动就把常用名字解析好，并定时刷新：第一位玩家也不必等跨洲 TCP DNS。
    if (upstreamDns) trace('dns upstream', DNS_DEFAULT_SERVER, '->', upstreamDns)
    prewarmDns()
    const refresh = setInterval(() => prewarmDns(), 5 * 60 * 1000)
    refresh.unref?.()
  }

  router.get('/status', (_req, res) => res.json({ enabled, transport: enabled ? 'wss' : null }))
  router.post('/session', (req, res) => {
    res.set('Cache-Control', 'no-store')
    if (!enabled) return res.status(503).json({ error: 'wfc_disabled' })
    if (!originAllowed(req)) return res.status(403).json({ error: 'invalid_origin' })
    if (req.body?.gameSlug !== 'call-of-duty-world-at-war') return res.status(400).json({ error: 'unsupported_game' })
    const ip = ipOf(req)
    // 刷新标签页会复用令牌，但复用请求同样要有限速；否则随机 clientId 成了无限调用的免检通道。
    if (!take(`nds-wfc-requests:${ip}`, 120, 60_000).ok) return res.status(429).json({ error: 'rate_limited' })
    sweep()
    const clientId = typeof req.body?.clientId === 'string' && /^[a-f0-9]{32}$/.test(req.body.clientId) ? req.body.clientId : null
    // 同一家庭的两台 DS 会共用公网 IP；不能因为一台刷新或探针新建会话就撤销另一台的令牌。
    // 同标签页刷新复用随机 clientId，既避免无谓占坑，也不把同 IP 玩家合并成一个身份。
    if (clientId) {
      for (const [token, item] of sessions) {
        if (item.ip === ip && item.clientId === clientId && item.expiresAt > Date.now()) {
          item.expiresAt = Date.now() + SESSION_MS
          prewarmDns()
          return res.json({ token, path: PATH, expiresIn: SESSION_MS / 1000, dns: dnsSnapshot(item) })
        }
      }
    }
    if (!take(`nds-wfc:${ip}`, 12, 60_000).ok) return res.status(429).json({ error: 'rate_limited' })
    if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter((item) => item.ip === ip).length >= MAX_SESSIONS_PER_IP) {
      return res.status(429).json({ error: 'capacity' })
    }
    prewarmDns()
    const token = randomBytes(24).toString('base64url')
    const session = { ip, clientId, expiresAt: Date.now() + SESSION_MS, sockets: 0, allowedIps: new Map(), allowedNatnegIps: new Map(), allowedPeers: new Map(), dnsCache: new Map(), udpGroups: new Map() }
    sessions.set(token, session)
    res.json({ token, path: PATH, expiresIn: SESSION_MS / 1000, dns: dnsSnapshot(session) })
  })

  /** 与 URL 路径里的目标同一套校验；连接池的 bind 消息也走这里，不能绕开授权。 */
  function authorizeTarget(session, protocol, host, port) {
    if (!publicIpv4(host) || !isPortAllowed(protocol, port)) return 'target'
    const isDns = protocol === 'udp' && port === 53 && DNS_SERVERS.has(host)
    // 撮合后的对战对端：只认可信 NATNEG 服务器在 CONNECT 里点名的精确 IP:端口（UDP）
    const natnegPeer = protocol === 'udp' && (session.allowedPeers.get(`${host}:${port}`) || 0) > Date.now()
    if (!isDns && !natnegPeer && (session.allowedIps.get(host) || 0) <= Date.now()) return 'unauthorized IP'
    return null
  }

  /**
   * 把一条已接受的 WebSocket 接到真实 TCP / UDP 上。调用前 session.sockets / socketCount 已经 +1，
   * 这里负责在关闭时减回去。
   */
  function serve(ws, session, { protocol, host, port, udpGroupId }) {
    const isDns = protocol === 'udp' && port === 53 && DNS_SERVERS.has(host)
    trace('accepted', protocol, host, port)
    let closed = false
    let second = 0
    let bytes = 0
    let lastPong = Date.now()
    let heartbeat
    const pendingDns = new Map()
    let udpGroup = null
    let udpHandler = null
    let upstream = null
    let connectTimer = null
    const close = () => {
      if (closed) return
      closed = true
      trace('closed', protocol, host, port)
      clearInterval(heartbeat)
      clearTimeout(connectTimer)
      for (const request of pendingDns.values()) clearTimeout(request.timer)
      pendingDns.clear()
      session.sockets--
      socketCount--
      if (udpGroup) {
        const peerKey = `${host}:${port}`
        const peer = udpGroup.peers.get(peerKey)
        peer?.delete(udpHandler)
        if (peer?.size === 0) udpGroup.peers.delete(peerKey)
        if (--udpGroup.refs === 0) {
          session.udpGroups.delete(udpGroupId)
          try { udpGroup.socket.close() } catch { /* 最后一条 WS 关闭时 UDP 可能已经报错 */ }
        }
      } else {
        try { upstream?.destroy?.() } catch { /* 断开的 TCP 不影响其它 WFC 流 */ }
        try { upstream?.close?.() } catch { /* DNS UDP 可能已经关闭 */ }
      }
      if (ws.readyState === WebSocket.OPEN) ws.close()
    }
    const send = (data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount > MAX_BUFFERED) return close()
      try { ws.send(data, { binary: true }) } catch { close() }
    }
    const admit = (message) => {
      const now = Date.now()
      const nowSecond = Math.floor(now / 1000)
      if (second !== nowSecond) { second = nowSecond; bytes = 0 }
      bytes += message.length
      if (message.length > MAX_FRAME || bytes > MAX_BYTES_PER_SECOND) { close(); return false }
      // 真正在玩的局可以超过两小时；只有客体数据才续期，WS Pong 本身不算活跃游戏。
      if (session.expiresAt < now + SESSION_MS / 2) session.expiresAt = now + SESSION_MS
      // 本地 DNS 表会让客体整局复用旧答案；活跃连接续期时同步续上该目标的会话授权，避免长局中途突然 403。
      if (!isDns && session.allowedIps.has(host)) {
        session.allowedIps.delete(host)
        session.allowedIps.set(host, now + DNS_IP_MS)
      }
      if (protocol === 'udp' && port === NATNEG_SERVER_PORT && session.allowedNatnegIps.has(host)) {
        session.allowedNatnegIps.set(host, now + DNS_IP_MS)
      }
      const peerKey = `${host}:${port}`
      if (protocol === 'udp' && session.allowedPeers.has(peerKey)) session.allowedPeers.set(peerKey, now + NATNEG_PEER_MS)
      return true
    }

    // Cloudflare 会回收长时间无流量的 WebSocket；控制器里等人入房时也必须维持传输层活性。
    // Ping 是 WS 控制帧，不会混进 DS 客体的 TCP/UDP 数据。
    heartbeat = setInterval(() => {
      if (Date.now() > session.expiresAt) return close()
      if (Date.now() - lastPong > 90_000) return close()
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 30_000)
    heartbeat.unref?.()
    ws.on('pong', () => { lastPong = Date.now() })
    ws.on('close', (code) => { trace('ws close', protocol, host, port, code); close() })
    ws.on('error', (error) => { trace('ws error', protocol, host, port, error.code); close() })

    if (protocol === 'tcp') {
      /*
        先接受 WebSocket、再连上游，期间客体发来的数据先缓存。
        以前反过来（上游连通才完成升级）：线上一条 WSS 握手 1.5～3 秒、再加跨洲 TCP 建连 1～3 秒，
        而 DS 的 connect 大约 2 秒就放弃重来 —— NAS 登录（443）反复重试直到报 20100。
        上游连不上时直接关掉 WebSocket，客体看到的是对端关闭，和真实网络里连接被拒的效果一样。
      */
      const gpPort = port === 29900 || port === 29901
      const queued = []
      let queuedBytes = 0
      let connected = false
      let upstreamEnded = false
      let pendingUpstreamFrames = 0
      const finishUpstream = () => {
        // conntest 会在短响应后立即 FIN；先等 WebSocket 确认响应帧写出，再发关闭帧，避免客体只看到断线。
        if (upstreamEnded && pendingUpstreamFrames === 0) close()
      }
      upstream = tcpSocketFactory({ host, port })
      upstream.setNoDelay?.(true)
      upstream.setKeepAlive?.(true, 30_000)
      connectTimer = setTimeout(() => {
        if (connected) return
        trace('tcp connect timeout', host, port)
        close()
      }, 8_000)
      connectTimer.unref?.()
      upstream.once('connect', () => {
        connected = true
        clearTimeout(connectTimer)
        trace('tcp connected', host, port)
        for (const message of queued.splice(0)) upstream.write(message)
        queuedBytes = 0
      })
      upstream.on('data', (data) => {
        trace('tcp recv', host, port, data.length, gpPort ? gpTraceSummary(data) ?? '' : '')
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > MAX_BUFFERED) return close()
        pendingUpstreamFrames++
        try {
          ws.send(data, { binary: true }, (error) => {
            pendingUpstreamFrames--
            if (error) return close()
            if (port === 80) trace('tcp response flushed', host, port, data.length)
            finishUpstream()
          })
        } catch {
          pendingUpstreamFrames--
          close()
        }
      })
      upstream.on('error', (error) => { trace('tcp error', host, port, error.code); close() })
      upstream.on('end', () => {
        trace('tcp end', host, port)
        upstreamEnded = true
        finishUpstream()
      })
      upstream.on('close', (hadError) => {
        trace('tcp close', host, port, hadError)
        if (hadError) return close()
        upstreamEnded = true
        finishUpstream()
      })
      ws.on('message', (raw, binary) => {
        const message = Buffer.from(raw)
        if (!binary || !admit(message)) return
        if (isPortHandshake(message)) return
        if (!message.length) return
        trace('tcp send', host, port, message.length, gpPort ? gpTraceSummary(message) ?? '' : '')
        if (!connected) {
          queuedBytes += message.length
          if (queuedBytes > MAX_BUFFERED) return close()
          queued.push(message)
          return
        }
        upstream.write(message)
        if (upstream.writableLength > MAX_BUFFERED) close()
      })
    } else if (isDns) {
      upstream = udpSocketFactory()
      upstream.on('error', (error) => { trace('udp error', host, port, error.code); close() })
      upstream.on('message', (message) => {
        if (message.length < 12) return
        const request = pendingDns.get(message.readUInt16BE(0))
        if (!request) return
        clearTimeout(request.timer)
        pendingDns.delete(message.readUInt16BE(0))
        const finishDns = (answer) => {
          const ips = dnsAnswerIps(answer, request.name)
          trace('dns answer', request.name, ips)
          rememberSessionDns(session, request.name, ips)
          if (ips.length) {
            // NAS 整局会重复解析同一名字；缓存十分钟，免得上游 DNS 抖动时重试风暴拖垮登录。
            if (session.dnsCache.size >= 32) session.dnsCache.delete(session.dnsCache.keys().next().value)
            session.dnsCache.set(request.name, { ips, expiresAt: Date.now() + DNS_CACHE_MS })
            rememberDns(host, request.name, ips)
          }
          send(answer)
        }
        if (message[2] & 0x02) {
          // Kaeru 会对普通 UDP DNS 查询回 TC=1；DS 游戏不一定按 RFC 再走 TCP。
          // 只对已验证的 WFC 域名，代它完成 TCP 重试，避免客体卡在 DNS 阶段。
          void resolveShared(host, request.name).then((ips) => {
            const answer = dnsAReply(request.packet, ips)
            if (answer) finishDns(answer)
            else send(dnsServFailReply(request.packet))
          }).catch((error) => {
            trace('dns TCP fallback error', host, request.name, error.code)
            send(dnsServFailReply(request.packet))
          })
        } else finishDns(message)
      })
      let udpReady = false
      const pending = []
      const sendUpstream = (message) => {
        try { upstream.send(message) } catch { close() }
      }
      ws.on('message', (raw, binary) => {
        const message = Buffer.from(raw)
        if (!binary || !admit(message)) return
        if (isPortHandshake(message)) return
        const name = dnsQueryName(message)
        if (!name) {
          const refused = dnsRefusedReply(message)
          trace('refuse DNS query outside WFC allowlist', refused ? (dnsName(message, 12)?.name ?? '?') : 'unparsable')
          // 答一句 REFUSED 让客体立刻放弃这个名字；别关 socket，否则后面的合法查询全丢。
          if (refused) send(refused)
          return
        }
        trace('dns query', name)
        const now = Date.now()
        const cached = session.dnsCache.get(name)
        const shared = cached && cached.expiresAt > now ? cached.ips : cachedShared(host, name)
        if (shared) {
          const reply = dnsAReply(message, shared)
          if (reply) {
            rememberSessionDns(session, name, shared, now)
            trace('dns cache hit', name, shared)
            return send(reply)
          }
        }
        for (const [id, request] of pendingDns) if (now - request.startedAt > 10_000) {
          clearTimeout(request.timer)
          pendingDns.delete(id)
        }
        // 客体重试风暴时丢掉新包即可（它自己会再发），关 socket 反而让后续查询全部失效。
        if (pendingDns.size >= 8) return trace('drop DNS query: too many pending', name)
        const id = message.readUInt16BE(0)
        /*
          UDP 和 TCP 同时出发，谁先拿到合法 A 记录就用谁。以前先等 UDP 1.2 秒再走 TCP：
          生产机到 Kaeru 的 UDP 从来不回，每个名字都白等 1.2 秒再加一次跨洲 TCP，
          实测单次 3.5～9 秒，DS 解析器早就超时重试，最后报 20100。
        */
        const request = { name, packet: message, startedAt: now, timer: null }
        void resolveShared(host, name).then((ips) => {
          if (pendingDns.get(id) !== request) return
          const answer = dnsAReply(message, ips)
          if (!answer || !ips.length) return
          clearTimeout(request.timer)
          pendingDns.delete(id)
          rememberSessionDns(session, name, ips)
          if (session.dnsCache.size >= 32) session.dnsCache.delete(session.dnsCache.keys().next().value)
          session.dnsCache.set(name, { ips, expiresAt: Date.now() + DNS_CACHE_MS })
          trace('dns tcp answer', name, ips, `${Date.now() - now}ms`)
          send(answer)
        }).catch((error) => trace('dns TCP error', host, name, error.code))
        // TCP 失败、UDP 也一直不回时，别让客体干等到自己的超时：给 SERVFAIL 让它立即重试。
        const timer = setTimeout(() => {
          if (pendingDns.get(id) !== request) return
          pendingDns.delete(id)
          trace('dns servfail after timeout', host, name)
          send(dnsServFailReply(request.packet))
        }, 6_000)
        timer.unref?.()
        request.timer = timer
        pendingDns.set(id, request)
        if (!udpReady) {
          if (pending.length >= 4) return trace('drop DNS query before upstream ready', name)
          pending.push(message)
        } else sendUpstream(message)
      })
      upstream.connect(port, dnsTarget(host), () => {
        udpReady = true
        for (const message of pending) sendUpstream(message)
        pending.length = 0
      })
    } else {
      // 一个 DS UDP socket 会对多个 NATNEG / 匹配目标 sendto；同一 socketId 必须共用公网源端口。
      // DNS 独立处理，因为它需要校验每个事务 ID 后才能给本局授权目标 IP。
      udpGroup = session.udpGroups.get(udpGroupId)
      if (!udpGroup) {
        udpGroup = { socket: udpSocketFactory(), refs: 0, peers: new Map() }
        session.udpGroups.set(udpGroupId, udpGroup)
        const group = udpGroup
        group.socket.on('message', (message, remote) => {
          trace('udp recv', remote.address, remote.port, message.length)
          // 只有 NATNEG 专用 DNS 名字解析出的地址，且来自固定服务端口的报文，才有权声明玩家对端。
          // NAS / GameSpy 普通地址或同 IP 上的其它 UDP 服务不能伪造 CONNECT 扩大出口。
          if (remote.port === NATNEG_SERVER_PORT && (session.allowedNatnegIps.get(remote.address) || 0) > Date.now()) {
            const peer = natnegConnectPeer(message)
            if (peer) {
              if (session.allowedPeers.size >= 64) session.allowedPeers.delete(session.allowedPeers.keys().next().value)
              session.allowedPeers.set(`${peer.host}:${peer.port}`, Date.now() + NATNEG_PEER_MS)
              trace('natneg connect authorizes peer', peer.host, peer.port)
            }
          }
          for (const peer of group.peers.get(`${remote.address}:${remote.port}`) || []) peer.send(message)
        })
        group.socket.on('error', (error) => {
          trace('udp error', error.code)
          for (const peers of [...group.peers.values()]) for (const peer of [...peers]) peer.close()
        })
      }
      udpGroup.refs++
      const peerKey = `${host}:${port}`
      if (!udpGroup.peers.has(peerKey)) udpGroup.peers.set(peerKey, new Set())
      udpHandler = { send, close }
      udpGroup.peers.get(peerKey).add(udpHandler)
      ws.on('message', (raw, binary) => {
        const message = Buffer.from(raw)
        if (!binary || !admit(message)) return
        if (isPortHandshake(message)) return
        trace('udp send', host, port, message.length)
        udpGroup.socket.send(message, port, host, (error) => { if (error) close() })
      })
    }
  }

  /**
   * 预热的空闲连接：浏览器提前开好几条 WSS，客体真正 connect 时直接拿一条，
   * 用第一条文本帧告诉中继目标（JSON：protocol / host / port / socketId）。
   * 这样客体的 TCP 握手不必再等一次 Cloudflare WSS 握手。空闲太久或首帧不合法就关掉。
   */
  const POOL_IDLE_MS = 10 * 60 * 1000
  function servePool(ws, session, instanceId) {
    trace('pool socket ready')
    let bound = false
    let lastPong = Date.now()
    const idle = setTimeout(() => { if (!bound) finish() }, POOL_IDLE_MS)
    idle.unref?.()
    const heartbeat = setInterval(() => {
      if (bound) return clearInterval(heartbeat)
      if (Date.now() - lastPong > 90_000) return finish()
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 30_000)
    heartbeat.unref?.()
    let finished = false
    function finish() {
      if (finished || bound) return
      finished = true
      clearTimeout(idle)
      clearInterval(heartbeat)
      session.sockets--
      socketCount--
      if (ws.readyState === WebSocket.OPEN) ws.close()
    }
    ws.on('pong', () => { lastPong = Date.now() })
    ws.once('close', finish)
    ws.on('error', finish)
    ws.once('message', (raw, binary) => {
      if (binary) return finish()
      let bind
      try { bind = JSON.parse(Buffer.from(raw).toString('utf8')) } catch { return finish() }
      const protocol = bind?.protocol === 'tcp' || bind?.protocol === 'udp' ? bind.protocol : null
      const host = typeof bind?.host === 'string' ? bind.host : ''
      const port = Number(bind?.port)
      const socketId = typeof bind?.socketId === 'string' && /^\d{1,6}$/.test(bind.socketId) ? bind.socketId : null
      if (!protocol || (protocol === 'udp') !== Boolean(socketId) || !Number.isInteger(port)) return finish()
      const denied = authorizeTarget(session, protocol, host, port)
      if (denied) {
        trace('pool reject', denied, protocol, host, port)
        return finish()
      }
      bound = true
      clearTimeout(idle)
      clearInterval(heartbeat)
      ws.removeListener('close', finish)
      ws.removeListener('error', finish)
      serve(ws, session, { protocol, host, port, udpGroupId: `${instanceId}:${socketId}` })
    })
  }

  function attach(httpServer) {
    if (!enabled) return
    httpServer.on('upgrade', (req, socket, head) => {
      let url
      try { url = new URL(req.url || '/', 'http://localhost') } catch { return reject(socket, '400 Bad Request') }
      if (!url.pathname.startsWith(PATH)) return
      if (!originAllowed(req)) return reject(socket, '403 Forbidden')
      const poolMatch = url.pathname.match(/^\/api\/nds-wfc\/socket\/([A-Za-z0-9_-]{32})\/pool\/([a-f0-9]{16})$/)
      const match = poolMatch ? null : url.pathname.match(/^\/api\/nds-wfc\/socket\/([A-Za-z0-9_-]{32})\/(tcp|udp)\/(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,5})(?:\/(\d{1,6})\/([a-f0-9]{16}))?$/)
      if (!poolMatch && !match) return reject(socket, '400 Bad Request')
      const token = poolMatch ? poolMatch[1] : match[1]
      const session = sessions.get(token)
      if (!session || session.ip !== ipOf(req) || session.expiresAt <= Date.now()) {
        trace('reject session', poolMatch ? 'pool' : `${match[2]} ${match[3]} ${match[4]}`)
        return reject(socket, '403 Forbidden')
      }
      let target = null
      if (match) {
        const [, , protocol, host, portText, socketId, instanceId] = match
        if ((protocol === 'udp') !== Boolean(socketId)) return reject(socket, '400 Bad Request')
        const port = Number(portText)
        const denied = authorizeTarget(session, protocol, host, port)
        if (denied) {
          trace('reject', denied, protocol, host, port, denied === 'unauthorized IP' ? [...session.allowedIps.keys()] : '')
          return reject(socket, '403 Forbidden')
        }
        target = { protocol, host, port, udpGroupId: `${instanceId}:${socketId}` }
      }
      if (session.sockets >= MAX_SOCKETS_PER_SESSION || socketCount >= MAX_SOCKETS_TOTAL) {
        trace('reject socket capacity', session.sockets, socketCount)
        return reject(socket, '429 Too Many Requests')
      }
      // 占位要在握手之前：并发升级不能一起越过上限
      session.sockets++
      socketCount++
      let accepted = false
      socket.once('close', () => {
        if (accepted) return
        accepted = true
        session.sockets--
        socketCount--
      })
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (accepted) return ws.terminate()
        accepted = true
        if (target) serve(ws, session, target)
        else servePool(ws, session, poolMatch[2])
      })
    })
  }

  return { router, attach, enabled }
}
