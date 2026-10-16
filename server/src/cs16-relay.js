import dgram from 'node:dgram'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { Router } from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import { clientIpFrom, isPrivateIp } from './presence.js'
import { take } from './rateLimit.js'

const RELAY_PATH = '/api/cs16/relay'
const SUPPORTED_MAPS = new Set([
  'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train',
  'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo',
])
const INFO_REQUEST = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from('Source Engine Query\0', 'latin1'),
])
const DEFAULT_DIRECTORY_URL = 'https://xcstrike.com/api/v1/cs16/servers'
const MAX_DIRECTORY_BYTES = 512 * 1024

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function text(value, max) {
  const result = typeof value === 'string' ? value.trim() : ''
  return result && result.length <= max ? result : ''
}

function enabledByDefault(value) {
  if (value == null || String(value).trim() === '') return true
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

function validHostname(value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
  })
}

function parseServers(raw, warnings) {
  if (!String(raw || '').trim()) return []
  let entries
  try {
    entries = JSON.parse(raw)
  } catch (error) {
    warnings.push(`CS16_SERVERS_JSON 不是合法 JSON：${error.message}`)
    return []
  }
  if (!Array.isArray(entries)) {
    warnings.push('CS16_SERVERS_JSON 必须是数组')
    return []
  }

  const servers = []
  const ids = new Set()
  const netIds = new Set()
  for (const [index, item] of entries.slice(0, 32).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`第 ${index + 1} 个 CS1.6 服务器不是对象，已忽略`)
      continue
    }
    const id = text(item.id, 32)
    const name = text(item.name, 64)
    const host = text(item.host, 253)
    const port = Number(item.port)
    const map = text(item.map, 32)
    const netId = item.netId == null ? index + 1 : Number(item.netId)
    const family = Number(item.family) === 6 ? 6 : 4
    const literalFamily = isIP(host)
    const validHost = literalFamily ? literalFamily === family : validHostname(host)
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || ids.has(id) || !name || !validHost ||
        !Number.isInteger(port) || port < 1 || port > 65535 || !SUPPORTED_MAPS.has(map) ||
        !Number.isInteger(netId) || netId < 1 || netId > 65535 || netIds.has(netId)) {
      warnings.push(`第 ${index + 1} 个 CS1.6 服务器字段无效或重复，已忽略`)
      continue
    }
    ids.add(id)
    netIds.add(netId)
    servers.push(Object.freeze({
      id,
      name,
      host,
      port,
      map,
      netId,
      family,
      region: text(item.region, 24),
      description: text(item.description, 160),
      maxPlayers: integer(item.maxPlayers, 32, 1, 255),
    }))
  }
  if (entries.length > 32) warnings.push('CS1.6 服务器最多配置 32 个，超出的已忽略')
  return servers
}

/** 浏览器请求从不接收 host / port；固定项与自动发现项都只在服务端注册为短 ID。 */
export function readCs16RelayConfig(env = process.env, defaultAllowedOrigins = []) {
  const warnings = []
  const servers = parseServers(env.CS16_SERVERS_JSON, warnings)
  const publicDirectory = enabledByDefault(env.CS16_PUBLIC_DIRECTORY)
  const directConnect = enabledByDefault(env.CS16_DIRECT_CONNECT)
  const configuredDirectoryUrl = text(env.CS16_DIRECTORY_URL, 500)
  const validatedDirectoryUrl = validHttpsUrl(configuredDirectoryUrl || DEFAULT_DIRECTORY_URL)
  const directoryUrl = validatedDirectoryUrl || DEFAULT_DIRECTORY_URL
  if (configuredDirectoryUrl && !validatedDirectoryUrl) {
    warnings.push('CS16_DIRECTORY_URL 必须是无账号信息的 HTTPS 地址，已使用默认公共目录')
  }
  const explicitOrigins = String(env.CS16_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
  const inherited = Array.isArray(defaultAllowedOrigins) ? defaultAllowedOrigins : []
  const allowedOrigins = (explicitOrigins.length ? explicitOrigins : inherited)
    // 主站 CORS 的 `*` 不能等价套到 UDP 桥；跨站网页借桥虽打不到任意主机，仍能消耗游戏服流量。
    .filter((origin) => origin !== '*')

  return Object.freeze({
    enabled: directConnect || publicDirectory || servers.length > 0,
    relayPath: RELAY_PATH,
    servers: Object.freeze(servers),
    publicDirectory,
    directoryUrl,
    directoryTimeoutMs: integer(env.CS16_DIRECTORY_TIMEOUT_MS, 8000, 500, 15_000),
    directoryMaxCandidates: integer(env.CS16_DIRECTORY_MAX_CANDIDATES, 96, 8, 100),
    publicMaxServers: integer(env.CS16_PUBLIC_MAX_SERVERS, 24, 1, 64),
    publicProbeConcurrency: integer(env.CS16_PUBLIC_PROBE_CONCURRENCY, 12, 1, 24),
    publicRefreshMs: integer(env.CS16_PUBLIC_REFRESH_MS, 5 * 60_000, 60_000, 30 * 60_000),
    publicTtlMs: integer(env.CS16_PUBLIC_TTL_MS, 15 * 60_000, 2 * 60_000, 60 * 60_000),
    directConnect,
    directTtlMs: integer(env.CS16_DIRECT_TTL_MS, 10 * 60_000, 2 * 60_000, 30 * 60_000),
    directProbeTimeoutMs: integer(env.CS16_DIRECT_PROBE_TIMEOUT_MS, 1500, 300, 5000),
    directMaxServers: integer(env.CS16_DIRECT_MAX_SERVERS, 512, 16, 5000),
    warnings: Object.freeze(warnings),
    allowedOrigins: Object.freeze(allowedOrigins),
    maxConnections: integer(env.CS16_RELAY_MAX_CONNECTIONS, 128, 1, 2000),
    maxPerIp: integer(env.CS16_RELAY_MAX_PER_IP, 2, 1, 16),
    maxFrameBytes: integer(env.CS16_RELAY_MAX_FRAME_BYTES, 16 * 1024, 1024, 65507),
    maxBufferedBytes: integer(env.CS16_RELAY_MAX_BUFFERED_BYTES, 512 * 1024, 16 * 1024, 8 * 1024 * 1024),
    maxPacketsPerSecond: integer(env.CS16_RELAY_MAX_PACKETS_PER_SECOND, 512, 32, 4000),
    maxBytesPerSecond: integer(env.CS16_RELAY_MAX_BYTES_PER_SECOND, 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    connectTimeoutMs: integer(env.CS16_RELAY_CONNECT_TIMEOUT_MS, 5000, 250, 30_000),
    idleTimeoutMs: integer(env.CS16_RELAY_IDLE_TIMEOUT_MS, 120_000, 30_000, 30 * 60_000),
    sessionTimeoutMs: integer(env.CS16_RELAY_SESSION_TIMEOUT_MS, 6 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    heartbeatIntervalMs: integer(env.CS16_RELAY_HEARTBEAT_INTERVAL_MS, 30_000, 5000, 5 * 60_000),
    probeTimeoutMs: integer(env.CS16_RELAY_PROBE_TIMEOUT_MS, 900, 100, 5000),
  })
}

/** 只接受字面量公网 IPv4，避免 DNS 重绑定把一次通过校验的域名随后指到内网。 */
export function parseDirectAddress(value) {
  const match = String(value || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/)
  if (!match) return null
  const host = match[1]
  const port = match[2] ? Number(match[2]) : 27015
  return isPublicIpv4(host) && Number.isInteger(port) && port >= 1 && port <= 65535
    ? { host, port, family: 4 }
    : null
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
    // 开发反代会改 Host 的端口；公网直连请求不能使用这条放宽，避免伪造 Origin 绕过限制。
    return isPrivateIp(req.socket?.remoteAddress) && source.hostname === target.hostname
  } catch {
    return false
  }
}

function originAllowed(req, allowedOrigins) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '')
  // 命令行诊断工具没有 Origin；网页一定带 Origin，并且必须同源或命中专用白名单。
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
  return clientIpFrom(req.socket?.remoteAddress, req.headers || {})
}

function readCString(buffer, state) {
  const end = buffer.indexOf(0, state.at)
  if (end < 0) throw new Error('字符串没有结束符')
  const value = buffer.toString('utf8', state.at, end)
  state.at = end + 1
  return value
}

/** 只读 A2S_INFO / GoldSrc info 必需字段；额外字段格式变化不会影响服务器可加入。 */
export function parseServerInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readInt32LE(0) !== -1) return null
  const type = buffer[4]
  const state = { at: 5 }
  try {
    if (type === 0x49) {
      const protocol = buffer[state.at++]
      const name = readCString(buffer, state)
      const map = readCString(buffer, state)
      const folder = readCString(buffer, state)
      readCString(buffer, state) // game
      if (state.at + 8 > buffer.length) return null
      const appId = buffer.readUInt16LE(state.at)
      state.at += 2
      const players = buffer[state.at++]
      const maxPlayers = buffer[state.at++]
      state.at += 3 // bots / type / environment
      const password = buffer[state.at++] !== 0
      const vac = state.at < buffer.length ? buffer[state.at] !== 0 : null
      return { name, map, folder, appId, protocol, players, maxPlayers, password, vac }
    }
    if (type === 0x6d) {
      readCString(buffer, state) // address
      const name = readCString(buffer, state)
      const map = readCString(buffer, state)
      const folder = readCString(buffer, state)
      readCString(buffer, state) // game
      if (state.at + 3 > buffer.length) return null
      const players = buffer[state.at++]
      const maxPlayers = buffer[state.at++]
      const protocol = buffer[state.at++]
      state.at += 2 // type / environment
      const password = state.at < buffer.length ? buffer[state.at] !== 0 : false
      return { name, map, folder, appId: null, protocol, players, maxPlayers, password, vac: null }
    }
  } catch {
    return null
  }
  return null
}

export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false
  const parts = address.split('.').map(Number)
  const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
  const inCidr = (base, prefix) => Math.floor(value / (2 ** (32 - prefix))) === Math.floor(base / (2 ** (32 - prefix)))
  return ![
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ].some(([base, prefix]) => inCidr(base, prefix))
}

/**
 * 旧版 Valve UDP Master 已不再稳定解析；默认目录改用免密钥的人工审核列表，但这里只把它当候选源。
 * 目录里的名称、人数和地图都不直接信任，后面仍会逐台发 A2S_INFO 重新确认。
 */
export async function queryPublicDirectory({
  url = DEFAULT_DIRECTORY_URL,
  timeoutMs = 8000,
  maxCandidates = 96,
  fetchImpl = fetch,
} = {}) {
  const endpoint = new URL(url)
  endpoint.searchParams.set('online', '1')
  endpoint.searchParams.set('page', '1')
  endpoint.searchParams.set('limit', String(Math.min(100, maxCandidates)))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`公共目录返回 HTTP ${response.status}`)
    const declaredBytes = Number(response.headers.get('content-length') || 0)
    if (declaredBytes > MAX_DIRECTORY_BYTES) throw new Error('公共目录响应超过大小上限')
    if (!response.body) throw new Error('公共目录响应没有正文')
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > MAX_DIRECTORY_BYTES) throw new Error('公共目录响应超过大小上限')
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      void reader.cancel(error).catch(() => {})
      throw error
    }
    const body = Buffer.concat(chunks, totalBytes)
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      throw new Error('公共目录没有返回合法 JSON')
    }
    if (!payload?.ok || !Array.isArray(payload.servers)) throw new Error('公共目录响应结构无效')
    const servers = []
    const seen = new Set()
    for (const item of payload.servers) {
      const host = text(item?.ip, 45)
      const port = Number(item?.port)
      const reportedMap = text(item?.map, 32)
      const key = `${host}:${port}`
      // 这里只用第三方地图字段减少无意义 UDP 探测；能否加入仍以后面的本站 A2S 结果为准。
      if (!isPublicIpv4(host) || !Number.isInteger(port) || port < 1 || port > 65535 ||
          !SUPPORTED_MAPS.has(reportedMap) || seen.has(key)) continue
      seen.add(key)
      servers.push({ host, port, family: 4, region: text(item?.country, 8), reportedMap })
      if (servers.length >= maxCandidates) break
    }
    return servers
  } finally {
    clearTimeout(timer)
  }
}

export function probeServer(server, timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(server.family === 6 ? 'udp6' : 'udp4')
    const startedAt = performance.now()
    let settled = false
    let challenged = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* connect/DNS 失败时可能已经关掉 */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    socket.once('error', () => finish(null))
    socket.on('message', (message) => {
      // 新版 Valve 查询会先回 A2S_SERVERQUERY_GETCHALLENGE；挑战只能原样发回同一白名单目标。
      if (!challenged && message.length >= 9 && message.readInt32LE(0) === -1 && message[4] === 0x41) {
        challenged = true
        socket.send(Buffer.concat([INFO_REQUEST, message.subarray(5, 9)]))
        return
      }
      const info = parseServerInfo(message)
      if (info) finish({ ...info, pingMs: Math.max(0, Math.round(performance.now() - startedAt)) })
    })
    socket.connect(server.port, server.host, () => socket.send(INFO_REQUEST))
  })
}

function publicServer(server, info) {
  const reportedMap = text(info?.map, 32)
  const mapSupported = !info || (!!reportedMap && SUPPORTED_MAPS.has(reportedMap))
  const password = info?.password ?? false
  const unavailableReason = !info
    ? '服务器当前无响应'
    : !mapSupported
      ? reportedMap
        ? `服务器当前地图 ${reportedMap} 尚未随网页版发布`
        : '服务器返回了无效地图名'
      : password
        ? '该服务器需要密码，网页版目录暂不下发口令'
        : null
  return {
    id: server.id,
    name: server.name,
    region: server.region || null,
    description: server.description || null,
    map: mapSupported && reportedMap ? reportedMap : server.map,
    reportedMap: reportedMap || null,
    netId: server.netId,
    port: server.port,
    online: !!info,
    players: info?.players ?? null,
    maxPlayers: info?.maxPlayers || server.maxPlayers,
    pingMs: info?.pingMs ?? null,
    password,
    joinable: !!info && mapSupported && !password,
    unavailableReason,
    source: server.direct ? 'direct-ip' : server.automatic ? 'public-directory' : 'configured',
  }
}

function compatiblePublicServer(info) {
  return !!info && info.folder?.toLowerCase() === 'cstrike' &&
    (info.appId == null || info.appId === 10) && [47, 48].includes(info.protocol) &&
    SUPPORTED_MAPS.has(info.map) && !info.password && info.maxPlayers > 0
}

function publicServerIdentity(host, port) {
  return createHash('sha256').update(`${host}:${port}`).digest()
}

function allocateNetId(digest, usedNetIds) {
  let netId = digest.readUInt16BE(0) || 1
  while (usedNetIds.has(netId)) netId = netId === 65535 ? 1 : netId + 1
  usedNetIds.add(netId)
  return netId
}

function automaticServer(candidate, info, usedNetIds, expiresAt) {
  const digest = publicServerIdentity(candidate.host, candidate.port)
  const printableName = Array.from(String(info.name || ''), (character) => {
    const code = character.codePointAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
  const serverName = text(printableName, 64)
  return Object.freeze({
    id: `public-${digest.toString('hex').slice(0, 16)}`,
    name: serverName || `CS1.6 ${info.map}`,
    host: candidate.host,
    port: candidate.port,
    map: info.map,
    netId: allocateNetId(digest, usedNetIds),
    family: 4,
    region: candidate.region || 'Public',
    description: '公共目录自动发现；已通过 CS1.6 协议与地图校验',
    maxPlayers: info.maxPlayers,
    automatic: true,
    directory: true,
    expiresAt,
  })
}

function directServer(candidate, info, usedNetIds, expiresAt) {
  const digest = publicServerIdentity(candidate.host, candidate.port)
  const printableName = Array.from(String(info.name || ''), (character) => {
    const code = character.codePointAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
  return Object.freeze({
    id: `direct-${digest.toString('hex').slice(0, 16)}`,
    name: text(printableName, 64) || `CS1.6 ${info.map}`,
    host: candidate.host,
    port: candidate.port,
    map: info.map,
    netId: allocateNetId(digest, usedNetIds),
    family: 4,
    region: 'Direct IP',
    description: '玩家输入的公网地址；已通过本站 CS1.6 协议与地图兼容复检',
    maxPlayers: info.maxPlayers,
    automatic: true,
    direct: true,
    expiresAt,
  })
}

async function mapLimited(values, limit, mapper) {
  const results = Array.from({ length: values.length })
  let next = 0
  const worker = async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

export function createCs16RelayService({
  env = process.env,
  logger = console,
  defaultAllowedOrigins = [],
  queryDirectory = queryPublicDirectory,
  probe = probeServer,
} = {}) {
  const config = readCs16RelayConfig(env, defaultAllowedOrigins)
  const router = Router()
  const serverById = new Map(config.servers.map((server) => [server.id, server]))
  const perIp = new Map()
  const stats = {
    active: 0,
    accepted: 0,
    rejected: 0,
    packetsFromClient: 0,
    packetsFromServer: 0,
    bytesFromClient: 0,
    bytesFromServer: 0,
  }
  let configuredCache = { at: 0, promise: null, servers: [] }
  let publicCache = { at: 0, expiresAt: 0, promise: null, servers: [] }
  let attachedServer = null
  let wss = null
  let upgradeHandler = null
  let heartbeatTimer = null
  let directoryWarmupTimer = null

  const listConfiguredServers = async () => {
    const now = Date.now()
    if (configuredCache.promise) return configuredCache.promise
    if (now - configuredCache.at < 5000) return configuredCache.servers
    configuredCache.promise = Promise.all(config.servers.map(async (server) => {
      const info = await probe(server, config.probeTimeoutMs)
      return publicServer(server, info)
    })).then((servers) => {
      configuredCache = { at: Date.now(), promise: null, servers }
      return servers
    }).catch((error) => {
      configuredCache.promise = null
      throw error
    })
    return configuredCache.promise
  }

  const replaceAutomaticServers = (servers) => {
    for (const [id, server] of serverById) {
      // 手动 IP 的短期注册与公共目录刷新互不相干；只替换这一轮目录自己发现的目标。
      if (server.directory) serverById.delete(id)
    }
    for (const server of servers) serverById.set(server.id, server)
  }

  const listPublicServers = async () => {
    if (!config.publicDirectory) return []
    const now = Date.now()
    if (publicCache.promise) return publicCache.promise
    if (now - publicCache.at < config.publicRefreshMs && now < publicCache.expiresAt) return publicCache.servers

    const previous = publicCache
    const refresh = (async () => {
      try {
        const discovered = await Promise.resolve().then(() => queryDirectory({
          url: config.directoryUrl,
          timeoutMs: config.directoryTimeoutMs,
          maxCandidates: config.directoryMaxCandidates,
        }))
        // 主目录长期存在同一 IP 批量伪造条目的问题；自动目录最多探测同一 IP 的前两个端口。
        const perHost = new Map()
        const candidates = discovered.filter((candidate) => {
          if (!isPublicIpv4(candidate.host) || candidate.family !== 4 || !Number.isInteger(candidate.port) ||
              candidate.port < 1 || candidate.port > 65535) return false
          const count = perHost.get(candidate.host) || 0
          perHost.set(candidate.host, count + 1)
          return count < 2
        }).slice(0, config.directoryMaxCandidates)
        const checked = await mapLimited(candidates, config.publicProbeConcurrency, async (candidate) => ({
          candidate,
          info: await probe(candidate, config.probeTimeoutMs),
        }))
        const verified = checked.filter(({ info }) => compatiblePublicServer(info)).slice(0, config.publicMaxServers)
        const expiresAt = Date.now() + config.publicTtlMs
        const usedNetIds = new Set(config.servers.map((server) => server.netId))
        const automatic = verified.map(({ candidate, info }) => automaticServer(candidate, info, usedNetIds, expiresAt))

        // 公共目录偶发限流或整批 A2S 丢包时保留尚未过期的上一批，避免列表瞬间清空。
        if (automatic.length === 0 && previous.servers.length > 0 && Date.now() < previous.expiresAt) {
          logger.warn?.('[cs16-relay] 自动目录本轮没有通过校验的服务器，暂时保留上一批')
          publicCache = { ...previous, at: Date.now(), promise: publicCache.promise }
          return previous.servers
        }

        replaceAutomaticServers(automatic)
        const servers = automatic.map((server, index) => publicServer(server, verified[index].info))
        publicCache = { at: Date.now(), expiresAt, promise: publicCache.promise, servers }
        return servers
      } catch (error) {
        logger.warn?.(`[cs16-relay] CS1.6 公共目录刷新失败：${error?.message || error}`)
        if (previous.servers.length > 0 && Date.now() < previous.expiresAt) {
          publicCache = { ...previous, at: Date.now(), promise: publicCache.promise }
          return previous.servers
        }
        replaceAutomaticServers([])
        const failedAt = Date.now()
        // 外部目录宕机时也做短期负缓存，避免公开 GET 接口被拿来持续重试第三方服务。
        publicCache = {
          at: failedAt,
          expiresAt: failedAt + Math.min(config.publicRefreshMs, 60_000),
          promise: publicCache.promise,
          servers: [],
        }
        return []
      }
    })()
    publicCache = { ...publicCache, promise: refresh }
    try {
      return await refresh
    } finally {
      if (publicCache.promise === refresh) publicCache.promise = null
    }
  }

  const listServers = async () => {
    const [configured, automatic] = await Promise.all([listConfiguredServers(), listPublicServers()])
    return [...configured, ...automatic]
  }

  const cleanupDirectServers = () => {
    const now = Date.now()
    const directServers = [...serverById.values()].filter((server) => server.direct)
    // expiresAt 只决定淘汰优先级，不能在玩家加载大资源时硬删目标；真正接入前还会再次 A2S 验真。
    // 只有注册表满了才删过期项，这样慢网首载不会在第 10 分钟突然得到“Unknown server”。
    let needed = Math.max(0, directServers.length - config.directMaxServers + 1)
    for (const server of directServers.sort((left, right) => left.expiresAt - right.expiresAt)) {
      if (needed <= 0 || now < server.expiresAt) break
      if (serverById.get(server.id) === server) serverById.delete(server.id)
      needed -= 1
    }
  }

  router.get('/servers', async (_req, res) => {
    noStore(res)
    const servers = config.enabled ? await listServers() : []
    res.json({
      enabled: config.enabled,
      automatic: config.publicDirectory,
      protocol: 'GoldSrc UDP over WSS',
      relayPath: config.relayPath,
      servers,
    })
  })

  router.post('/servers/resolve', async (req, res) => {
    noStore(res)
    if (!config.directConnect) return res.status(503).json({ error: 'IP 直连当前未开放' })
    // 全站 CORS 可以放开普通读接口，但不能让第三方网页把访客变成本站的公网 UDP 探针。
    if (!originAllowed(req, config.allowedOrigins)) {
      stats.rejected += 1
      return res.status(403).json({ error: '来源网页不允许发起 CS1.6 IP 探测' })
    }
    const ip = ipOf(req) || 'unknown'
    const perIpQuota = take(`cs16-direct:ip:${ip}`, 8, 60_000)
    const globalQuota = take('cs16-direct:global', 240, 60_000)
    if (!perIpQuota.ok || !globalQuota.ok) {
      const retryAfter = Math.max(perIpQuota.retryAfter || 0, globalQuota.retryAfter || 0, 1)
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ error: 'IP 探测太频繁，请稍后再试', retryAfter })
    }
    const candidate = parseDirectAddress(req.body?.address)
    if (!candidate) return res.status(400).json({ error: '请输入公网 IPv4:端口，例如 45.12.34.56:27015' })
    cleanupDirectServers()
    const prospectiveId = `direct-${publicServerIdentity(candidate.host, candidate.port).toString('hex').slice(0, 16)}`
    const directCount = [...serverById.values()].filter((server) => server.direct).length
    if (!serverById.has(prospectiveId) && directCount >= config.directMaxServers) {
      return res.status(503).json({ error: 'IP 直连临时注册已满，请稍后再试' })
    }
    const info = await probe(candidate, config.directProbeTimeoutMs)
    if (!info) return res.status(404).json({ error: '服务器无响应，请确认 IP、端口和防火墙' })
    if (!compatiblePublicServer(info)) {
      const error = info.password
        ? '该服务器需要密码，网页版暂不保存或下发服务器口令'
        : !SUPPORTED_MAPS.has(info.map)
          ? `服务器当前地图 ${text(info.map, 32) || '未知'} 尚未随网页版发布`
          : '目标响应了 UDP，但不是兼容的 Counter-Strike 1.6 服务器'
      return res.status(422).json({ error })
    }
    const id = prospectiveId
    const expiresAt = Date.now() + config.directTtlMs
    // 每次手动连接都续一轮短期注册；目标仍要重新 A2S 验证，旧验证不能无限续命。
    const usedNetIds = new Set([...serverById.values()].filter((entry) => entry.id !== id).map((entry) => entry.netId))
    const server = directServer(candidate, info, usedNetIds, expiresAt)
    serverById.set(server.id, server)
    res.json(publicServer(server, info))
  })

  router.get('/status', (_req, res) => {
    noStore(res)
    res.json({
      enabled: config.enabled,
      servers: serverById.size,
      configuredServers: config.servers.length,
      automaticDirectory: config.publicDirectory,
      directConnect: config.directConnect,
      connections: { active: stats.active, accepted: stats.accepted, rejected: stats.rejected },
      traffic: {
        packetsFromClient: stats.packetsFromClient,
        packetsFromServer: stats.packetsFromServer,
        bytesFromClient: stats.bytesFromClient,
        bytesFromServer: stats.bytesFromServer,
      },
    })
  })

  const attach = (httpServer) => {
    if (attachedServer) return wss
    attachedServer = httpServer
    wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes })
    wss.on('error', (error) => logger.warn?.('[cs16-relay] WebSocket 服务异常：', error.message))

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

    upgradeHandler = (req, socket, head) => {
      const url = requestUrl(req)
      if (url?.pathname !== config.relayPath) return
      if (!config.enabled) {
        stats.rejected += 1
        return rejectUpgrade(socket, '503 Service Unavailable', 'CS1.6 relay is not configured')
      }
      if (!originAllowed(req, config.allowedOrigins)) {
        stats.rejected += 1
        return rejectUpgrade(socket, '403 Forbidden', 'Origin is not allowed')
      }
      const serverId = url.searchParams.get('server') || ''
      const server = serverById.get(serverId)
      // 过期登记不能直接拒绝：玩家可能仍在下载首局资源。自动目标会在 connection 阶段重新 A2S 验真，
      // 因此这里仅拒绝已不在表内或地址本身失去公网属性的目标。
      if (!server || (server.automatic && !isPublicIpv4(server.host))) {
        if (server?.automatic) serverById.delete(serverId)
        stats.rejected += 1
        return rejectUpgrade(socket, '404 Not Found', 'Unknown CS1.6 server')
      }
      const ip = ipOf(req)
      if (stats.active >= config.maxConnections || (ip && (perIp.get(ip) || 0) >= config.maxPerIp)) {
        stats.rejected += 1
        return rejectUpgrade(socket, '429 Too Many Requests', 'CS1.6 relay connection limit reached')
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { ip, server }))
      } catch (error) {
        logger.warn?.('[cs16-relay] upgrade 失败：', error?.message || error)
        socket.destroy()
      }
    }
    httpServer.on('upgrade', upgradeHandler)

    wss.on('connection', (ws, _req, { ip, server }) => {
      stats.active += 1
      stats.accepted += 1
      if (ip) perIp.set(ip, (perIp.get(ip) || 0) + 1)
      ws.cs16Alive = true
      ws.on('pong', () => { ws.cs16Alive = true })

      let udp = null
      let released = false
      let udpReady = false
      const clientRate = { startedAt: Date.now(), packets: 0, bytes: 0 }
      const serverRate = { startedAt: Date.now(), packets: 0, bytes: 0 }
      let idleTimer = null
      let forceCloseTimer = null

      const release = () => {
        if (released) return
        released = true
        clearTimeout(idleTimer)
        clearTimeout(sessionTimer)
        clearTimeout(connectTimer)
        clearTimeout(forceCloseTimer)
        stats.active = Math.max(0, stats.active - 1)
        if (ip) {
          const left = (perIp.get(ip) || 1) - 1
          if (left > 0) perIp.set(ip, left)
          else perIp.delete(ip)
        }
      }
      const closeWs = (code, reason) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(code, reason)
          forceCloseTimer ||= setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
          }, 1000)
          forceCloseTimer.unref?.()
        } else if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
      }
      const closeSession = (code, reason) => {
        closeWs(code, reason)
        try { udp?.close() } catch { /* close 竞争时忽略 */ }
      }
      const armIdle = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => closeSession(1001, 'CS1.6 relay idle timeout'), config.idleTimeoutMs)
        idleTimer.unref?.()
      }
      const withinRate = (window, bytes) => {
        const now = Date.now()
        if (now - window.startedAt >= 1000) {
          window.startedAt = now
          window.packets = 0
          window.bytes = 0
        }
        window.packets += 1
        window.bytes += bytes
        return window.packets <= config.maxPacketsPerSecond && window.bytes <= config.maxBytesPerSecond
      }

      // 自动目标要先做一次 A2S 复检；复检预算不能挤占随后 UDP socket 自己的建连预算。
      const revalidationBudgetMs = server.automatic
        ? (server.direct ? config.directProbeTimeoutMs : config.probeTimeoutMs)
        : 0
      const connectTimer = setTimeout(
        () => closeSession(1013, 'CS1.6 UDP server connection timeout'),
        config.connectTimeoutMs + revalidationBudgetMs,
      )
      connectTimer.unref?.()
      const sessionTimer = setTimeout(() => closeSession(1001, 'CS1.6 relay session limit reached'), config.sessionTimeoutMs)
      sessionTimer.unref?.()
      armIdle()

      ws.on('message', (data, isBinary) => {
        if (!isBinary) return closeSession(1003, 'CS1.6 relay accepts binary datagrams only')
        const message = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (!udpReady) return closeSession(1013, 'CS1.6 UDP server is not ready')
        if (!withinRate(clientRate, message.length)) return closeSession(1008, 'CS1.6 relay client rate limit exceeded')
        armIdle()
        stats.packetsFromClient += 1
        stats.bytesFromClient += message.length
        udp?.send(message, (error) => {
          if (error) closeSession(1013, 'CS1.6 UDP send failed')
        })
      })
      ws.once('error', () => {
        try { udp?.close() } catch { /* close 竞争时忽略 */ }
      })
      ws.once('close', () => {
        try { udp?.close() } catch { /* close 竞争时忽略 */ }
        release()
      })

      const connectVerifiedTarget = async () => {
        if (server.automatic) {
          let info = null
          try {
            info = await probe(server, server.direct ? config.directProbeTimeoutMs : config.probeTimeoutMs)
          } catch { /* 注入实现也必须按不可达处理，不能让异步拒绝打成 unhandledRejection。 */ }
          if (!compatiblePublicServer(info) || info.map !== server.map) {
            if (serverById.get(server.id) === server) serverById.delete(server.id)
            closeSession(1013, 'CS1.6 server changed or failed revalidation')
            return
          }
        }
        if (released || ws.readyState !== WebSocket.OPEN) return
        udp = dgram.createSocket(server.family === 6 ? 'udp6' : 'udp4')
        udp.once('connect', () => {
          udpReady = true
          clearTimeout(connectTimer)
          armIdle()
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready', server: server.id }))
        })
        udp.on('message', (message) => {
          if (released) return
          armIdle()
          // 已验证的游戏服也可能随后被接管或故意泛洪；回包方向必须和上行一样有硬上限。
          if (!withinRate(serverRate, message.length)) return closeSession(1008, 'CS1.6 relay server rate limit exceeded')
          stats.packetsFromServer += 1
          stats.bytesFromServer += message.length
          if (message.length > config.maxFrameBytes) return closeSession(1009, 'CS1.6 UDP packet too large')
          if (ws.readyState !== WebSocket.OPEN) return
          if (ws.bufferedAmount + message.length > config.maxBufferedBytes) return closeSession(1013, 'CS1.6 browser connection congested')
          ws.send(message, { binary: true })
        })
        udp.once('error', (error) => {
          logger.warn?.(`[cs16-relay] ${server.id} UDP 异常：${error.message}`)
          closeSession(1013, 'CS1.6 UDP server unavailable')
        })
        udp.once('close', release)
        udp.connect(server.port, server.host)
      }
      void connectVerifiedTarget()
    })

    for (const warning of config.warnings) logger.warn?.(`[cs16-relay] ${warning}`)
    if (config.publicDirectory) {
      logger.log?.(`[cs16-relay] 已启用自动公共目录与 ${config.servers.length} 个固定服务器，路径 ${config.relayPath}`)
      // 不阻塞进程启动；提前填好缓存，玩家第一次打开 Find Servers 时通常可以直接看到结果。
      directoryWarmupTimer = setTimeout(() => { void listPublicServers() }, 1000)
      directoryWarmupTimer.unref?.()
    } else if (config.enabled) {
      logger.log?.(`[cs16-relay] 已启用 ${config.servers.length} 个固定服务器，路径 ${config.relayPath}`)
    } else {
      logger.log?.('[cs16-relay] 联机目录已关闭：Find Servers 会显示安全的空状态')
    }
    return wss
  }

  const close = () => {
    if (attachedServer && upgradeHandler) attachedServer.off('upgrade', upgradeHandler)
    clearInterval(heartbeatTimer)
    clearTimeout(directoryWarmupTimer)
    heartbeatTimer = null
    directoryWarmupTimer = null
    for (const ws of wss?.clients || []) ws.terminate()
    try { wss?.close() } catch { /* noServer 未接过连接时可以忽略 */ }
    wss = null
    attachedServer = null
    upgradeHandler = null
  }

  return { config, router, stats, listServers, attach, close }
}
