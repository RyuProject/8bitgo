import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { Resolver } from 'node:dns/promises'
import net from 'node:net'
import { Router } from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import { clientIpFrom } from './presence.js'
import { take } from './rateLimit.js'

const PATH = '/api/nds-wfc/socket/'
const DNS_SERVERS = new Set(['178.62.43.212', '95.217.77.181', '172.104.88.237'])
// 本次实测 ROM 内的 NAS / GameSpy 域名全部归在 nintendowifi.net；不扩大成任意 DNS 代理。
const WFC_DOMAINS = ['nintendowifi.net']
const SESSION_MS = 2 * 60 * 60 * 1000
// DS 固件可能把 DNS 结果缓存整局；中继的授权不能比本局会话短，否则老玩家中途重新建 socket 会被误拒。
const DNS_IP_MS = SESSION_MS
// 同一局里 DS 会反复查询 NAS；30 秒过期会在上游 DNS 短暂抖动时引发整批重试，最终报 20100。
const DNS_CACHE_MS = 10 * 60 * 1000
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
  if (!question || question.name.toLowerCase() !== expectedName || question.next + 4 > packet.length) return []
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

/**
 * 给白名单外的查询回 REFUSED。以前直接关掉整条 WebSocket：客体那边的 UDP socket 还在，
 * 之后同一 socket 发出的 NAS / GameSpy 查询全部石沉大海，游戏只能超时报 20100。
 */
export function dnsRefusedReply(query) {
  if (!Buffer.isBuffer(query) || query.length < 12 || (query[2] & 0x80)) return null
  const question = query.readUInt16BE(4) === 1 ? dnsName(query, 12) : null
  const end = question && question.next + 4 <= query.length ? question.next + 4 : 12
  const reply = Buffer.from(query.subarray(0, end))
  // QR=1，保留 opcode 与 RD；RA=1，RCODE=5（REFUSED）
  reply[2] = 0x80 | (query[2] & 0x79)
  reply[3] = 0x80 | 5
  reply.writeUInt16BE(end > 12 ? 1 : 0, 4)
  reply.writeUInt16BE(0, 6)
  reply.writeUInt16BE(0, 8)
  reply.writeUInt16BE(0, 10)
  return reply
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

function resolveDns4(host, name) {
  const resolver = new Resolver({ timeout: 1500, tries: 2 })
  resolver.setServers([host])
  return resolver.resolve4(name)
}

export function createNdsWfcService({
  enabled = process.env.NDS_WFC_ENABLED === '1',
  udpSocketFactory = () => dgram.createSocket('udp4'),
  tcpSocketFactory = (options) => net.createConnection(options),
  dnsResolver = resolveDns4,
} = {}) {
  const router = Router()
  const sessions = new Map()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  let socketCount = 0
  let pendingTcpCount = 0
  const trace = (...parts) => { if (process.env.NDS_WFC_TRACE === '1') console.info('[nds-wfc]', ...parts) }

  function sweep() {
    const now = Date.now()
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now && session.sockets === 0) sessions.delete(token)
      for (const [ip, expiresAt] of session.allowedIps) if (expiresAt <= now) session.allowedIps.delete(ip)
      for (const [peer, expiresAt] of session.allowedPeers) if (expiresAt <= now) session.allowedPeers.delete(peer)
      for (const [name, entry] of session.dnsCache) if (entry.expiresAt <= now) session.dnsCache.delete(name)
    }
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
          return res.json({ token, path: PATH, expiresIn: SESSION_MS / 1000 })
        }
      }
    }
    if (!take(`nds-wfc:${ip}`, 12, 60_000).ok) return res.status(429).json({ error: 'rate_limited' })
    if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter((item) => item.ip === ip).length >= MAX_SESSIONS_PER_IP) {
      return res.status(429).json({ error: 'capacity' })
    }
    const token = randomBytes(24).toString('base64url')
    sessions.set(token, { ip, clientId, expiresAt: Date.now() + SESSION_MS, sockets: 0, pendingTcp: 0, allowedIps: new Map(), allowedPeers: new Map(), dnsCache: new Map(), udpGroups: new Map() })
    res.json({ token, path: PATH, expiresIn: SESSION_MS / 1000 })
  })

  function attach(httpServer) {
    if (!enabled) return
    httpServer.on('upgrade', (req, socket, head) => {
      let url
      try { url = new URL(req.url || '/', 'http://localhost') } catch { return reject(socket, '400 Bad Request') }
      if (!url.pathname.startsWith(PATH)) return
      if (!originAllowed(req)) return reject(socket, '403 Forbidden')
      const match = url.pathname.match(/^\/api\/nds-wfc\/socket\/([A-Za-z0-9_-]{32})\/(tcp|udp)\/(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,5})(?:\/(\d{1,6})\/([a-f0-9]{16}))?$/)
      if (!match) return reject(socket, '400 Bad Request')
      const [, token, protocol, host, portText, socketId, instanceId] = match
      if ((protocol === 'udp') !== Boolean(socketId)) return reject(socket, '400 Bad Request')
      const udpGroupId = `${instanceId}:${socketId}`
      const session = sessions.get(token)
      const port = Number(portText)
      if (!session || session.ip !== ipOf(req) || session.expiresAt <= Date.now()) {
        trace('reject session', protocol, host, port)
        return reject(socket, '403 Forbidden')
      }
      if (!publicIpv4(host) || !isPortAllowed(protocol, port)) {
        trace('reject target', protocol, host, port)
        return reject(socket, '403 Forbidden')
      }
      const isDns = protocol === 'udp' && port === 53 && DNS_SERVERS.has(host)
      // 撮合后的对战对端：只认可信 NATNEG 服务器在 CONNECT 里点名的精确 IP:端口（UDP）
      const natnegPeer = protocol === 'udp' && (session.allowedPeers.get(`${host}:${port}`) || 0) > Date.now()
      if (!isDns && !natnegPeer && (session.allowedIps.get(host) || 0) <= Date.now()) {
        trace('reject unauthorized IP', protocol, host, port, [...session.allowedIps.keys()])
        return reject(socket, '403 Forbidden')
      }
      if (session.sockets + session.pendingTcp >= MAX_SOCKETS_PER_SESSION || socketCount + pendingTcpCount >= MAX_SOCKETS_TOTAL) {
        trace('reject socket capacity', session.sockets, socketCount)
        return reject(socket, '429 Too Many Requests')
      }
      const upgrade = (connectedTcp = null) => wss.handleUpgrade(req, socket, head, (ws) => {
        trace('accepted', protocol, host, port)
        session.sockets++
        socketCount++
        let closed = false
        let second = 0
        let bytes = 0
        let lastPong = Date.now()
        let heartbeat
        const pendingDns = new Map()
        let udpGroup = null
        let udpHandler = null
        let upstream = connectedTcp
        const close = () => {
          if (closed) return
          closed = true
          trace('closed', protocol, host, port)
          clearInterval(heartbeat)
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
          return true
        }

        if (isDns) upstream = udpSocketFactory()
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
          const gpPort = port === 29900 || port === 29901
          upstream.on('data', (data) => {
            trace('tcp recv', host, port, data.length, gpPort ? gpTraceSummary(data) ?? '' : '')
            send(data)
          })
          upstream.on('error', (error) => { trace('tcp error', host, port, error.code); close() })
          upstream.on('end', () => trace('tcp end', host, port))
          upstream.on('close', (hadError) => { trace('tcp close', host, port, hadError); close() })
          ws.on('message', (raw, binary) => {
            const message = Buffer.from(raw)
            if (!binary || !admit(message)) return
            if (isPortHandshake(message)) return
            trace('tcp send', host, port, message.length, gpPort ? gpTraceSummary(message) ?? '' : '')
            if (message.length) upstream.write(message)
            if (upstream.writableLength > MAX_BUFFERED) close()
          })
          upstream.resume()
        } else if (isDns) {
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
              for (const ip of ips) session.allowedIps.set(ip, Date.now() + DNS_IP_MS)
              if (ips.length) {
                // NAS 整局会重复解析同一名字；缓存十分钟，免得上游 DNS 抖动时重试风暴拖垮登录。
                if (session.dnsCache.size >= 32) session.dnsCache.delete(session.dnsCache.keys().next().value)
                session.dnsCache.set(request.name, { ips, expiresAt: Date.now() + DNS_CACHE_MS })
              }
              send(answer)
            }
            if (message[2] & 0x02) {
              // Kaeru 会对普通 UDP DNS 查询回 TC=1；DS 游戏不一定按 RFC 再走 TCP。
              // 只对已验证的 WFC 域名，代它完成 TCP 重试，避免客体卡在 DNS 阶段。
              void dnsResolver(host, request.name).then((ips) => {
                const answer = dnsAReply(request.packet, ips)
                if (answer) finishDns(answer)
                else send(message)
              }).catch(() => send(message))
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
            if (cached && cached.expiresAt > now) {
              const reply = dnsAReply(message, cached.ips)
              if (reply) {
                for (const ip of cached.ips) session.allowedIps.set(ip, now + DNS_IP_MS)
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
            const timer = setTimeout(() => {
              const request = pendingDns.get(id)
              if (!request) return
              // 部分 Kaeru UDP DNS 请求只收到截断标记或根本不回；由同一 DNS 节点做 TCP 回退。
              void dnsResolver(host, name).then((ips) => {
                if (pendingDns.get(id) !== request) return
                const answer = dnsAReply(message, ips)
                if (!answer) return
                pendingDns.delete(id)
                for (const ip of ips) session.allowedIps.set(ip, Date.now() + DNS_IP_MS)
                if (session.dnsCache.size >= 32) session.dnsCache.delete(session.dnsCache.keys().next().value)
                session.dnsCache.set(name, { ips, expiresAt: Date.now() + DNS_CACHE_MS })
                trace('dns fallback', name, ips)
                send(answer)
              }).catch((error) => trace('dns fallback error', name, error.code))
            }, 1200)
            timer.unref?.()
            pendingDns.set(id, { name, packet: message, startedAt: now, timer })
            if (!udpReady) {
              if (pending.length >= 4) return trace('drop DNS query before upstream ready', name)
              pending.push(message)
            } else sendUpstream(message)
          })
          upstream.connect(port, host, () => {
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
              // 撮合服务器本身必须是本局 DNS 授权过的地址，否则任何人都能伪造 CONNECT 给自己开出口。
              if ((session.allowedIps.get(remote.address) || 0) > Date.now()) {
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
      })
      if (protocol !== 'tcp') return upgrade()
      // WebSocket OPEN 会让 SOCKFS 把虚拟 TCP 标成已连接；必须等真实上游连通，
      // 否则游戏可能在首包挑战前进入错误的连接状态（61020），断线也无法正确反馈。
      pendingTcpCount++
      session.pendingTcp++
      let settled = false
      const tcp = tcpSocketFactory({ host, port })
      tcp.setNoDelay(true)
      tcp.setKeepAlive(true, 30_000)
      const finishPending = () => {
        if (settled) return false
        settled = true
        pendingTcpCount--
        session.pendingTcp--
        clearTimeout(connectTimer)
        return true
      }
      const connectTimer = setTimeout(() => {
        if (!finishPending()) return
        trace('tcp connect timeout', host, port)
        tcp.destroy()
        reject(socket, '504 Gateway Timeout')
      }, 8_000)
      connectTimer.unref?.()
      const onPendingError = (error) => {
        trace('tcp error', host, port, error.code)
        if (finishPending()) reject(socket, '502 Bad Gateway')
        tcp.destroy()
      }
      tcp.once('connect', () => {
        if (!finishPending()) return
        tcp.off('error', onPendingError)
        trace('tcp connected', host, port)
        tcp.pause()
        if (socket.destroyed) return tcp.destroy()
        upgrade(tcp)
      })
      tcp.once('error', onPendingError)
      socket.once('close', () => {
        finishPending()
        tcp.destroy()
      })
    })
  }

  return { router, attach, enabled }
}
