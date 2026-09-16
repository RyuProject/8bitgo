import { createConnection } from 'node:net'
import { Router } from 'express'
import { WebSocket, WebSocketServer } from 'ws'

const DEFAULT_WS_PATH = '/sfs/sas3'
const SAS3_HOST = 'sas3server.ninjakiwi.com'
const SAS3_PORT = 444

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim())
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function websocketPath(value) {
  const path = String(value || '').trim()
  return path.startsWith('/') && !/[?#]/.test(path) ? path : DEFAULT_WS_PATH
}

function websocketUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? url.href.replace(/\/$/, '') : ''
  } catch {
    return ''
  }
}

function httpBase(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.replace(/\/$/, '') : ''
  } catch {
    return ''
  }
}

/**
 * 所有开关都在运行时读取，故意不做成 VITE_*：SFS 是旁路服务，开关它不应要求重编主站。
 * 数字同时钳上下限，避免一个误填的环境变量把 ws 默认 100 MiB 帧上限重新带回来。
 */
export function readSfsConfig(env = process.env) {
  const publicTcpHost = String(env.SFS_PUBLIC_TCP_HOST || '').trim()
  const explicitOrigins = String(env.SFS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)

  return Object.freeze({
    enabled: flag(env.SFS_ENABLED),
    wsPath: websocketPath(env.SFS_WS_PATH),
    publicWsUrl: websocketUrl(env.SFS_PUBLIC_WS_URL),
    upstreamHost: String(env.SFS_TCP_HOST || '127.0.0.1').trim() || '127.0.0.1',
    upstreamPort: integer(env.SFS_TCP_PORT, 8044, 1, 65535),
    publicTcpHost,
    publicTcpPort: publicTcpHost ? integer(env.SFS_PUBLIC_TCP_PORT, SAS3_PORT, 1, 65535) : 0,
    mapBaseUrl: httpBase(env.SFS_SAS3_MAP_BASE_URL),
    allowedOrigins: explicitOrigins,
    maxConnections: integer(env.SFS_MAX_CONNECTIONS, 200, 1, 5000),
    maxPerIp: integer(env.SFS_MAX_PER_IP, 8, 1, 100),
    maxFrameBytes: integer(env.SFS_MAX_FRAME_BYTES, 64 * 1024, 1024, 1024 * 1024),
    maxBufferedBytes: integer(env.SFS_MAX_BUFFERED_BYTES, 512 * 1024, 16 * 1024, 8 * 1024 * 1024),
    connectTimeoutMs: integer(env.SFS_CONNECT_TIMEOUT_MS, 3000, 250, 30_000),
    idleTimeoutMs: integer(env.SFS_IDLE_TIMEOUT_MS, 4 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  })
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://sfs.local').pathname
  } catch {
    return ''
  }
}

function isLoopback(value) {
  const address = String(value || '').replace(/^::ffff:/i, '')
  return address === '127.0.0.1' || address === '::1'
}

/**
 * Upgrade 请求没经过 Express 的 trust proxy。只有直连者确实是本机反代时才采信 XFF；
 * 直接暴露 Node 端口时，公网客户端自己塞的 XFF 不会绕过每 IP 上限。
 */
function ipOf(req) {
  const direct = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '')
  if (!isLoopback(direct)) return direct
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean)
  return (chain.at(-1) || direct).replace(/^::ffff:/i, '')
}

function sameOrigin(req, origin) {
  try {
    return new URL(origin).host === String(req.headers.host || '')
  } catch {
    return false
  }
}

function originAllowed(req, allowedOrigins) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '')
  // 原生 Linux 客户端通常没有 Origin；浏览器客户端则必须同源或命中显式白名单。
  if (!origin) return true
  if (allowedOrigins.includes('*')) return true
  if (allowedOrigins.length) return allowedOrigins.includes(origin)
  return sameOrigin(req, origin)
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

function publicWebSocketProtocol(req) {
  if (req.secure) return 'wss'
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase()
  if (forwarded === 'https') return 'wss'
  // Cloudflare 到源站可以是 HTTP，但玩家打开的仍是 HTTPS；这时只看 req.protocol 会下发
  // ws://，浏览器会按 mixed content 拦掉。CF-Visitor 是边缘节点补的公开协议事实。
  try {
    if (JSON.parse(String(req.get('cf-visitor') || '{}')).scheme === 'https') return 'wss'
  } catch {
    /* 畸形代理头按非 TLS 处理，不能让一条配置请求 500 */
  }
  for (const candidate of [req.get('origin'), req.get('referer')]) {
    try {
      if (candidate && new URL(candidate).protocol === 'https:') return 'wss'
    } catch {
      /* 继续检查下一项 */
    }
  }
  return 'ws'
}

function publicWsUrl(req, config) {
  if (config.publicWsUrl) return config.publicWsUrl
  const protocol = publicWebSocketProtocol(req)
  return `${protocol}://${req.get('host')}${config.wsPath}`
}

function ruffleConfig(req, config) {
  if (!config.enabled) return {}
  const result = {
    socketProxy: [{ host: SAS3_HOST, port: SAS3_PORT, proxyUrl: publicWsUrl(req, config) }],
  }
  if (config.mapBaseUrl) {
    result.urlRewriteRules = [
      ['^https?://sas3maps\\.ninjakiwi\\.com/sas3maps/(.*)$', `${config.mapBaseUrl}/$1`],
    ]
  }
  return result
}

function probeTcp(config) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: config.upstreamHost, port: config.upstreamPort })
    let done = false
    const finish = (reachable) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(reachable)
    }
    const timer = setTimeout(() => finish(false), Math.min(config.connectTimeoutMs, 2000))
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * SmartFoxServer 1.x 的旧客户端说的是裸 TCP，浏览器不能直接连；这里仅做字节透明的
 * WebSocket ↔ TCP 桥，不解析、不伪造 SFS 数据包。真正的房间状态全部留在 Java sidecar。
 * 这样 sidecar 崩溃只会关掉当前 SAS3 socket，不会把 Express / 直播 / 现有联机一起带倒。
 */
export function createSfsService({ env = process.env, logger = console } = {}) {
  const config = readSfsConfig(env)
  const router = Router()
  const perIp = new Map()
  const stats = {
    active: 0,
    accepted: 0,
    rejected: 0,
    upstreamFailures: 0,
    bytesFromClient: 0,
    bytesFromUpstream: 0,
    lastUpstreamConnectedAt: null,
  }
  let wss = null
  let upgradeHandler = null
  let attachedServer = null
  let probeCache = { at: 0, promise: null, reachable: false }

  const probe = async () => {
    if (!config.enabled) return false
    const now = Date.now()
    if (probeCache.promise) return probeCache.promise
    if (now - probeCache.at < 5000) return probeCache.reachable
    probeCache.promise = probeTcp(config).then((reachable) => {
      probeCache = { at: Date.now(), promise: null, reachable }
      return reachable
    })
    return probeCache.promise
  }

  router.get('/config', (req, res) => {
    res.json({
      enabled: config.enabled,
      protocol: 'SmartFoxServer 1.x',
      games: ['sas3'],
      websocket: config.enabled ? { path: config.wsPath, url: publicWsUrl(req, config) } : null,
      native: config.enabled && config.publicTcpHost
        ? { host: config.publicTcpHost, port: config.publicTcpPort, note: '未修改的 SAS3.swf 仍需 hosts/DNS 或重打包才能使用此地址' }
        : null,
      ruffle: ruffleConfig(req, config),
    })
  })

  router.get('/status', async (_req, res) => {
    const reachable = await probe()
    res.json({
      enabled: config.enabled,
      ready: config.enabled && reachable,
      protocol: 'SmartFoxServer 1.x',
      games: ['sas3'],
      upstream: { reachable, checkedAt: new Date(probeCache.at || Date.now()).toISOString() },
      connections: {
        active: stats.active,
        accepted: stats.accepted,
        rejected: stats.rejected,
        limit: config.maxConnections,
        perIpLimit: config.maxPerIp,
      },
      traffic: { fromClient: stats.bytesFromClient, fromUpstream: stats.bytesFromUpstream },
      lastUpstreamConnectedAt: stats.lastUpstreamConnectedAt,
    })
  })

  const attach = (httpServer) => {
    if (attachedServer) return wss
    attachedServer = httpServer
    wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes })
    wss.on('error', (error) => logger.warn?.('[sfs] WebSocket 服务异常：', error.message))

    upgradeHandler = (req, socket, head) => {
      if (requestPath(req) !== config.wsPath) return
      if (!config.enabled) {
        stats.rejected += 1
        return rejectUpgrade(socket, '503 Service Unavailable', 'SFS bridge is disabled')
      }
      if (!originAllowed(req, config.allowedOrigins)) {
        stats.rejected += 1
        return rejectUpgrade(socket, '403 Forbidden', 'Origin is not allowed')
      }
      const ip = ipOf(req)
      if (stats.active >= config.maxConnections || (ip && (perIp.get(ip) || 0) >= config.maxPerIp)) {
        stats.rejected += 1
        return rejectUpgrade(socket, '429 Too Many Requests', 'SFS connection limit reached')
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip))
    }
    httpServer.on('upgrade', upgradeHandler)

    wss.on('connection', (ws, _req, ip) => {
      stats.active += 1
      stats.accepted += 1
      if (ip) perIp.set(ip, (perIp.get(ip) || 0) + 1)

      let released = false
      let upstreamReady = false
      let failed = false
      let pending = []
      let pendingBytes = 0
      const upstream = createConnection({ host: config.upstreamHost, port: config.upstreamPort })
      upstream.setNoDelay(true)
      upstream.setKeepAlive(true, 30_000)
      upstream.setTimeout(config.idleTimeoutMs)

      const release = () => {
        if (released) return
        released = true
        stats.active = Math.max(0, stats.active - 1)
        if (ip) {
          const left = (perIp.get(ip) || 1) - 1
          if (left > 0) perIp.set(ip, left)
          else perIp.delete(ip)
        }
      }
      const closeWs = (code, reason) => {
        if (ws.readyState === WebSocket.OPEN) ws.close(code, reason)
        else if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
      }
      const failUpstream = (reason) => {
        if (failed) return
        failed = true
        stats.upstreamFailures += 1
        pending = []
        pendingBytes = 0
        upstream.destroy()
        // 1013 明确告诉客户端「旁路服务暂时不可用」，不会暗示主站本身需要重启。
        closeWs(1013, reason)
      }
      const writeUpstream = (buffer) => {
        if (upstream.destroyed || !upstream.writable) return failUpstream('SFS upstream unavailable')
        upstream.write(buffer)
        if (upstream.writableLength > config.maxBufferedBytes) failUpstream('SFS upstream congested')
      }

      upstream.once('connect', () => {
        upstreamReady = true
        stats.lastUpstreamConnectedAt = new Date().toISOString()
        probeCache = { at: Date.now(), promise: null, reachable: true }
        for (const buffer of pending) writeUpstream(buffer)
        pending = []
        pendingBytes = 0
      })
      upstream.on('data', (data) => {
        stats.bytesFromUpstream += data.length
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount + data.length > config.maxBufferedBytes) return failUpstream('SFS client congested')
        ws.send(data, { binary: true })
      })
      upstream.once('timeout', () => failUpstream('SFS session idle timeout'))
      upstream.once('error', (error) => {
        probeCache = { at: Date.now(), promise: null, reachable: false }
        logger.warn?.(`[sfs] SAS3 上游连接失败：${error.message}`)
        failUpstream('SFS upstream unavailable')
      })
      upstream.once('close', () => {
        if (!failed) closeWs(1011, 'SFS upstream closed')
      })

      ws.on('message', (data) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
        stats.bytesFromClient += buffer.length
        if (upstreamReady) return writeUpstream(buffer)
        pendingBytes += buffer.length
        if (pendingBytes > config.maxBufferedBytes) return failUpstream('SFS connect buffer exceeded')
        pending.push(buffer)
      })
      ws.once('error', (error) => {
        logger.warn?.(`[sfs] 浏览器 WebSocket 异常：${error.message}`)
        upstream.destroy()
      })
      ws.once('close', () => {
        release()
        upstream.destroy()
      })

      const connectTimer = setTimeout(() => {
        if (!upstreamReady) failUpstream('SFS upstream timeout')
      }, config.connectTimeoutMs)
      connectTimer.unref?.()
      upstream.once('connect', () => clearTimeout(connectTimer))
      upstream.once('close', () => clearTimeout(connectTimer))
    })

    if (config.enabled) logger.log?.(`[sfs] SAS3 桥已启用：${config.wsPath} → ${config.upstreamHost}:${config.upstreamPort}`)
    else logger.log?.('[sfs] 未启用（SFS_ENABLED=0）：主站与单机游戏不受影响')
    return wss
  }

  const close = () => {
    if (attachedServer && upgradeHandler) attachedServer.off('upgrade', upgradeHandler)
    for (const client of wss?.clients || []) client.terminate()
    try { wss?.close() } catch { /* noServer 未接过连接时可以直接忽略 */ }
    wss = null
    attachedServer = null
    upgradeHandler = null
  }

  return { config, router, stats, probe, attach, close }
}
