import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import { clientIpFrom, isPrivateIp } from './presence.js'
import { take } from './rateLimit.js'

const ROOM_PATH = '/api/cs16/room'
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_HOST_PROTOCOL_PREFIX = '8bitgo.cs16.host.'
const ROOM_GUEST_PROTOCOL_PREFIX = '8bitgo.cs16.guest.'
const SUPPORTED_MAPS = new Set([
  'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train',
  'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo',
])

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function enabledByDefault(value) {
  if (value == null || String(value).trim() === '') return true
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
  })
}

function requestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://cs16.local')
  } catch {
    return null
  }
}

function sameOrigin(req, origin) {
  try {
    const source = new URL(origin)
    const target = new URL(`http://${String(req.headers.host || '')}`)
    if (source.host === target.host) return true
    const loopback = (hostname) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
    // Vite 的 changeOrigin 会同时把 localhost 改成 127.0.0.1、把端口改成后端端口；只在直连对端
    // 本身是可信私网代理时放宽，不能让公网请求靠伪造 Origin 绕过创建房间的跨站保护。
    return isPrivateIp(req.socket?.remoteAddress) &&
      (source.hostname === target.hostname || (loopback(source.hostname) && loopback(target.hostname)))
  } catch {
    return false
  }
}

function originAllowed(req, allowedOrigins) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '')
  return !origin || sameOrigin(req, origin) || allowedOrigins.includes(origin)
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return
  const body = Buffer.from(message)
  socket.write(
    `HTTP/1.1 ${status}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n` +
    'Connection: close\r\n\r\n',
  )
  socket.end(body)
}

function ipOf(req) {
  return clientIpFrom(req.socket?.remoteAddress, req.headers || {}) || 'unknown'
}

function roomCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code) ? code : ''
}

function digestToken(token) {
  return createHash('sha256').update(token).digest()
}

function tokenMatches(room, token) {
  const supplied = digestToken(String(token || ''))
  return supplied.length === room.hostTokenHash.length && timingSafeEqual(supplied, room.hostTokenHash)
}

function tokenFromProtocols(req, prefix) {
  const protocols = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((value) => value.trim())
  const credential = protocols.find((value) => value.startsWith(prefix))
  return credential ? credential.slice(prefix.length) : ''
}

function hostTokenFromRequest(req, url) {
  const protocolToken = tokenFromProtocols(req, ROOM_HOST_PROTOCOL_PREFIX)
  if (protocolToken) return protocolToken
  const legacyToken = String(url.searchParams.get('token') || '')
  /*
   * 旧 Pages 客户端把 token 放在查询串。新后端必须先上线，否则新 Pages 会碰到不认识子协议的
   * 旧后端；这里仅作滚动发布兼容，新客户端已经不会生成该 URL，避免两次发布之间房间功能全挂。
   */
  return /^[A-Za-z0-9_-]{24,128}$/.test(legacyToken) ? legacyToken : ''
}

function newRoomCode(rooms) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = randomBytes(6)
    let code = ''
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length]
    if (!rooms.has(code)) return code
  }
  throw new Error('无法分配房间码')
}

function roomView(room) {
  return {
    code: room.code,
    map: room.map,
    botCount: room.botCount,
    difficulty: room.difficulty,
    hostReady: !!room.host,
    players: room.guests.size + (room.host ? 1 : 0),
    maxPlayers: room.maxGuests + 1,
    server: { netId: room.hostNetId, port: room.serverPort },
    // 好友可能比房主更快加载完 60MB+ 资源；把真实剩余等待时间交给客户端，不能写死两分钟。
    hostWaitMsRemaining: room.host ? 0 : Math.max(0, room.hostDeadline - Date.now()),
    expiresAt: room.expiresAt,
  }
}

function closeSocket(ws, code, reason) {
  if (!ws) return
  if (ws.readyState === WebSocket.OPEN) ws.close(code, reason)
  else if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
}

export function readCs16RoomConfig(env = process.env, defaultAllowedOrigins = []) {
  const explicitOrigins = String(env.CS16_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
  const inherited = Array.isArray(defaultAllowedOrigins) ? defaultAllowedOrigins : []
  return Object.freeze({
    enabled: enabledByDefault(env.CS16_ROOMS_ENABLED),
    roomPath: ROOM_PATH,
    allowedOrigins: Object.freeze((explicitOrigins.length ? explicitOrigins : inherited).filter((origin) => origin !== '*')),
    maxRooms: integer(env.CS16_ROOM_MAX_ROOMS, 200, 1, 2000),
    maxGuests: integer(env.CS16_ROOM_MAX_GUESTS, 15, 1, 31),
    maxConnections: integer(env.CS16_ROOM_MAX_CONNECTIONS, 2048, 16, 10_000),
    maxPerIp: integer(env.CS16_ROOM_MAX_PER_IP, 24, 2, 128),
    maxFrameBytes: integer(env.CS16_RELAY_MAX_FRAME_BYTES, 16 * 1024, 1024, 65507),
    maxBufferedBytes: integer(env.CS16_RELAY_MAX_BUFFERED_BYTES, 512 * 1024, 16 * 1024, 8 * 1024 * 1024),
    maxPacketsPerSecond: integer(env.CS16_RELAY_MAX_PACKETS_PER_SECOND, 512, 32, 4000),
    maxBytesPerSecond: integer(env.CS16_RELAY_MAX_BYTES_PER_SECOND, 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    heartbeatIntervalMs: integer(env.CS16_RELAY_HEARTBEAT_INTERVAL_MS, 30_000, 5000, 5 * 60_000),
    hostWaitMs: integer(env.CS16_ROOM_HOST_WAIT_MS, 15 * 60_000, 60_000, 30 * 60_000),
    hostReconnectMs: integer(env.CS16_ROOM_HOST_RECONNECT_MS, 90_000, 15_000, 5 * 60_000),
    guestReconnectMs: integer(env.CS16_ROOM_GUEST_RECONNECT_MS, 60_000, 15_000, 5 * 60_000),
    lifetimeMs: integer(env.CS16_ROOM_LIFETIME_MS, 6 * 60 * 60_000, 5 * 60_000, 24 * 60 * 60_000),
    serverPort: 27015,
    // getaddrinfo 会把这个 ID 映射成 101.101.254.202；固定值只存在浏览器虚拟网，不对应公网 IP。
    hostNetId: 0xcafe,
  })
}

/**
 * 房主本身运行 Xash 监听服；本站只在同一个房间的浏览器之间交换 GoldSrc 数据报。
 * 因为这条路径完全不碰公网 UDP，它既不需要服务器白名单，也不会退化成任意 UDP 代理。
 */
export function createCs16RoomService({
  env = process.env,
  logger = console,
  defaultAllowedOrigins = [],
} = {}) {
  const config = readCs16RoomConfig(env, defaultAllowedOrigins)
  const router = Router()
  const rooms = new Map()
  const perIpConnections = new Map()
  const stats = { roomsCreated: 0, activeConnections: 0, packets: 0, bytes: 0, rejected: 0 }
  let attachedServer = null
  let upgradeHandler = null
  let heartbeatTimer = null
  let sweepTimer = null
  let wss = null

  const removeRoom = (room, code = 1012, reason = 'Room closed') => {
    if (!room || rooms.get(room.code) !== room) return
    rooms.delete(room.code)
    closeSocket(room.host, code, reason)
    for (const guest of room.guests.values()) closeSocket(guest, code, reason)
    room.guests.clear()
    room.guestSessions.clear()
    room.host = null
  }

  const sweepGuestSessions = (room, now = Date.now()) => {
    for (const [key, session] of room.guestSessions) {
      if (!room.guests.has(session.peerId) && now >= session.expiresAt) room.guestSessions.delete(key)
    }
  }

  const sweepRooms = () => {
    const now = Date.now()
    for (const room of rooms.values()) {
      sweepGuestSessions(room, now)
      if (now >= room.expiresAt || (!room.host && now >= room.hostDeadline)) {
        removeRoom(room, 1001, now >= room.expiresAt ? 'Room expired' : 'Host did not start the room')
      }
    }
  }

  router.post('/rooms', (req, res) => {
    noStore(res)
    if (!config.enabled) return res.status(503).json({ error: 'Temporary rooms are currently unavailable' })
    // 主站 CORS 可能允许 `*`；这里仍要单独挡住第三方网页借访客浏览器批量占满匿名房间。
    if (!originAllowed(req, config.allowedOrigins)) {
      stats.rejected += 1
      return res.status(403).json({ error: 'This page is not allowed to create CS1.6 rooms' })
    }
    sweepRooms()
    const ip = ipOf(req)
    const perIp = take(`cs16-room:create:${ip}`, 10, 60 * 60_000)
    const global = take('cs16-room:create:global', 500, 60 * 60_000)
    if (!perIp.ok || !global.ok) {
      const retryAfter = Math.max(perIp.retryAfter || 0, global.retryAfter || 0, 1)
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ error: 'Too many rooms have been created. Please try again later.', retryAfter })
    }
    if (rooms.size >= config.maxRooms) return res.status(503).json({ error: 'All temporary room slots are in use. Please try again later.' })
    const map = String(req.body?.map || '')
    const botCount = Number(req.body?.botCount)
    const difficulty = Number(req.body?.difficulty)
    if (!SUPPORTED_MAPS.has(map) || !Number.isInteger(botCount) || botCount < 0 || botCount > 15 ||
        !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 3) {
      return res.status(400).json({ error: 'Invalid map or BOT settings' })
    }
    const now = Date.now()
    const code = newRoomCode(rooms)
    const hostToken = randomBytes(24).toString('base64url')
    const room = {
      code,
      map,
      botCount,
      difficulty,
      createdBy: ip,
      createdAt: now,
      expiresAt: now + config.lifetimeMs,
      hostDeadline: now + config.hostWaitMs,
      hostTokenHash: digestToken(hostToken),
      hostNetId: config.hostNetId,
      serverPort: config.serverPort,
      maxGuests: config.maxGuests,
      nextPeerId: 1,
      host: null,
      guests: new Map(),
      // 访客瞬断时短时保留 peerId；GoldSrc 把虚拟 UDP 地址视为连接身份，换 ID 就无法原地续局。
      guestSessions: new Map(),
    }
    rooms.set(code, room)
    stats.roomsCreated += 1
    res.status(201).json({ ...roomView(room), hostToken })
  })

  router.get('/rooms/:code', (req, res) => {
    noStore(res)
    const ip = ipOf(req)
    const quota = take(`cs16-room:lookup:${ip}`, 120, 60_000)
    if (!quota.ok) {
      res.set('Retry-After', String(quota.retryAfter))
      return res.status(429).json({ error: 'Too many room lookups. Please try again later.' })
    }
    sweepRooms()
    const code = roomCode(req.params.code)
    const room = code ? rooms.get(code) : null
    if (!room) return res.status(404).json({ error: 'The room does not exist or has already ended' })
    res.json(roomView(room))
  })

  router.get('/rooms-status', (_req, res) => {
    noStore(res)
    sweepRooms()
    res.json({ enabled: config.enabled, rooms: rooms.size, ...stats })
  })

  const attach = (httpServer) => {
    if (attachedServer) return wss
    attachedServer = httpServer
    wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes + 2 })
    wss.on('error', (error) => logger.warn?.('[cs16-room] WebSocket 服务异常：', error.message))

    heartbeatTimer = setInterval(() => {
      for (const ws of wss?.clients || []) {
        if (ws.cs16Alive === false) {
          ws.terminate()
          continue
        }
        ws.cs16Alive = false
        try { ws.ping() } catch { ws.terminate() }
      }
    }, config.heartbeatIntervalMs)
    heartbeatTimer.unref?.()
    sweepTimer = setInterval(sweepRooms, 30_000)
    sweepTimer.unref?.()

    upgradeHandler = (req, socket, head) => {
      const url = requestUrl(req)
      if (url?.pathname !== config.roomPath) return
      if (!config.enabled) return rejectUpgrade(socket, '503 Service Unavailable', 'CS1.6 rooms are disabled')
      if (!originAllowed(req, config.allowedOrigins)) {
        stats.rejected += 1
        return rejectUpgrade(socket, '403 Forbidden', 'Origin is not allowed')
      }
      sweepRooms()
      const code = roomCode(url.searchParams.get('room'))
      const role = url.searchParams.get('role')
      const room = code ? rooms.get(code) : null
      if (!room || !['host', 'guest'].includes(role)) {
        stats.rejected += 1
        return rejectUpgrade(socket, '404 Not Found', 'Unknown CS1.6 room')
      }
      const ip = ipOf(req)
      if (stats.activeConnections >= config.maxConnections || (perIpConnections.get(ip) || 0) >= config.maxPerIp) {
        stats.rejected += 1
        return rejectUpgrade(socket, '429 Too Many Requests', 'CS1.6 room connection limit reached')
      }
      let guestResume = null
      if (role === 'host') {
        // 新客户端只走子协议；查询串仅用于承接已缓存的旧 Pages 版本，不能在新代码里重新生成。
        if (!tokenMatches(room, hostTokenFromRequest(req, url)) || room.host) {
          stats.rejected += 1
          return rejectUpgrade(socket, '403 Forbidden', 'Invalid room host token')
        }
      } else {
        sweepGuestSessions(room)
        const resumeToken = tokenFromProtocols(req, ROOM_GUEST_PROTOCOL_PREFIX)
        if (resumeToken) {
          const sessionKey = digestToken(resumeToken).toString('hex')
          const session = room.guestSessions.get(sessionKey)
          if (!/^[A-Za-z0-9_-]{24,128}$/.test(resumeToken) || !session || room.guests.has(session.peerId)) {
            stats.rejected += 1
            return rejectUpgrade(socket, '403 Forbidden', 'Invalid room player resume token')
          }
          guestResume = { sessionKey, session }
        } else if (room.guestSessions.size >= room.maxGuests) {
          stats.rejected += 1
          return rejectUpgrade(socket, '409 Conflict', 'CS1.6 room is full')
        }
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { room, role, ip, guestResume }))
      } catch (error) {
        logger.warn?.('[cs16-room] upgrade 失败：', error?.message || error)
        socket.destroy()
      }
    }
    httpServer.on('upgrade', upgradeHandler)

    wss.on('connection', (ws, _req, { room, role, ip, guestResume }) => {
      stats.activeConnections += 1
      perIpConnections.set(ip, (perIpConnections.get(ip) || 0) + 1)
      ws.cs16Alive = true
      ws.on('pong', () => { ws.cs16Alive = true })
      let released = false
      let peerId = 0
      let guestSessionKey = ''
      let guestResumeToken = ''
      let windowStartedAt = Date.now()
      let windowPackets = 0
      let windowBytes = 0

      const withinRate = (bytes) => {
        const now = Date.now()
        if (now - windowStartedAt >= 1000) {
          windowStartedAt = now
          windowPackets = 0
          windowBytes = 0
        }
        windowPackets += 1
        windowBytes += bytes
        return windowPackets <= config.maxPacketsPerSecond && windowBytes <= config.maxBytesPerSecond
      }
      const release = () => {
        if (released) return
        released = true
        stats.activeConnections = Math.max(0, stats.activeConnections - 1)
        const left = (perIpConnections.get(ip) || 1) - 1
        if (left > 0) perIpConnections.set(ip, left)
        else perIpConnections.delete(ip)
        if (role === 'guest') room.guests.delete(peerId)
      }
      const fail = (code, reason) => {
        stats.rejected += 1
        closeSocket(ws, code, reason)
      }

      if (role === 'host') {
        room.host = ws
        room.hostDeadline = room.expiresAt
        ws.send(JSON.stringify({ type: 'room-ready', ...roomView(room), role: 'host' }))
        for (const [id, guest] of room.guests) {
          if (guest.readyState === WebSocket.OPEN) {
            guest.send(JSON.stringify({ type: 'room-ready', ...roomView(room), role: 'guest', peerId: id }))
          }
        }
      } else {
        if (guestResume) {
          peerId = guestResume.session.peerId
          guestSessionKey = guestResume.sessionKey
          guestResume.session.expiresAt = room.expiresAt
        } else {
          const reservedIds = new Set([...room.guestSessions.values()].map((session) => session.peerId))
          while (room.guests.has(room.nextPeerId) || reservedIds.has(room.nextPeerId)) {
            room.nextPeerId = room.nextPeerId >= 65535 ? 1 : room.nextPeerId + 1
          }
          peerId = room.nextPeerId
          room.nextPeerId = peerId >= 65535 ? 1 : peerId + 1
          guestResumeToken = randomBytes(24).toString('base64url')
          guestSessionKey = digestToken(guestResumeToken).toString('hex')
          room.guestSessions.set(guestSessionKey, { peerId, expiresAt: room.expiresAt })
        }
        room.guests.set(peerId, ws)
        const resume = guestResumeToken ? { resumeToken: guestResumeToken } : {}
        if (room.host) ws.send(JSON.stringify({ type: 'room-ready', ...roomView(room), role: 'guest', peerId, ...resume }))
        else ws.send(JSON.stringify({ type: 'room-waiting', code: room.code, map: room.map, ...resume }))
      }

      ws.on('message', (data, isBinary) => {
        if (!isBinary) return fail(1003, 'CS1.6 room accepts binary datagrams only')
        const message = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if ((role === 'host' && (message.length < 3 || message.length > config.maxFrameBytes + 2)) ||
            (role === 'guest' && (message.length < 1 || message.length > config.maxFrameBytes))) {
          return fail(1009, 'Invalid CS1.6 room datagram size')
        }
        if (!withinRate(message.length)) return fail(1008, 'CS1.6 room rate limit exceeded')
        stats.packets += 1
        stats.bytes += message.length
        if (role === 'host') {
          const targetId = message.readUInt16BE(0)
          const guest = room.guests.get(targetId)
          if (!guest || guest.readyState !== WebSocket.OPEN) return
          const payload = message.subarray(2)
          if (guest.bufferedAmount + payload.length > config.maxBufferedBytes) return closeSocket(guest, 1013, 'CS1.6 room connection congested')
          guest.send(payload, { binary: true })
          return
        }
        const host = room.host
        if (!host || host.readyState !== WebSocket.OPEN) return
        if (host.bufferedAmount + message.length + 2 > config.maxBufferedBytes) return fail(1013, 'CS1.6 room connection congested')
        const envelope = Buffer.allocUnsafe(message.length + 2)
        envelope.writeUInt16BE(peerId, 0)
        message.copy(envelope, 2)
        host.send(envelope, { binary: true })
      })

      // error 理论上会紧跟 close，但不能靠这个隐含约定释放容量；主动终止才能避免半死连接继续占房。
      ws.once('error', () => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
      })
      ws.once('close', (code, reasonBuffer) => {
        release()
        const reason = Buffer.from(reasonBuffer || []).toString()
        if (role === 'guest') {
          const session = room.guestSessions.get(guestSessionKey)
          if (session) {
            if (code === 1000 && reason === 'page closed') room.guestSessions.delete(guestSessionKey)
            else session.expiresAt = Math.min(room.expiresAt, Date.now() + config.guestReconnectMs)
          }
          return
        }
        if (room.host !== ws) return
        room.host = null
        if (code === 1000 && reason === 'page closed') {
          removeRoom(room, 1012, 'Host left the room')
          return
        }
        /*
         * 浏览器、Cloudflare 或移动网络的一次瞬断不等于房主主动退出。旧实现立即删房，客户端因此
         * 只能显示“temporary server connection was lost”。保留同一个 room/token 一小段时间，
         * 原有访客保持 WebSocket，房主重连后继续使用相同 peerId 路由；明确的页面关闭仍立即回收。
         */
        room.hostDeadline = Math.min(room.expiresAt, Date.now() + config.hostReconnectMs)
        for (const guest of room.guests.values()) {
          if (guest.readyState === WebSocket.OPEN) {
            guest.send(JSON.stringify({
              type: 'room-waiting',
              code: room.code,
              map: room.map,
              reconnecting: true,
              hostWaitMsRemaining: Math.max(0, room.hostDeadline - Date.now()),
            }))
          }
        }
      })
    })

    logger.log?.(`[cs16-room] 临时监听服房间${config.enabled ? '已启用' : '已关闭'}，路径 ${config.roomPath}`)
    return wss
  }

  const close = () => {
    if (attachedServer && upgradeHandler) attachedServer.off('upgrade', upgradeHandler)
    clearInterval(heartbeatTimer)
    clearInterval(sweepTimer)
    for (const room of rooms.values()) removeRoom(room, 1001, 'Server shutting down')
    for (const ws of wss?.clients || []) ws.terminate()
    try { wss?.close() } catch { /* noServer 未接过连接时可以忽略 */ }
    rooms.clear()
    perIpConnections.clear()
    attachedServer = null
    upgradeHandler = null
    heartbeatTimer = null
    sweepTimer = null
    wss = null
  }

  return { config, router, rooms, stats, attach, close }
}
