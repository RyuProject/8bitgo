import { Net } from './engine/dist/index.js'

const MAX_WEBSOCKET_BUFFER = 512 * 1024
const ROOM_HOST_IP_PREFIX = [101, 101]
const ROOM_GUEST_IP_PREFIX = [101, 102]
const ROOM_GUEST_PORT_BASE = 30_000

function prepareNet(net) {
  const upstreamRecvfrom = net.recvfrom.bind(net)
  net.recvfrom = (...args) => {
    if (!net.incoming.isEmpty()) return upstreamRecvfrom(...args)
    /*
     * xash3d-fwgs@1.2.2 的 ErrNoLocation() 错把「errno 当前值」当成「errno 指针」返回，
     * 空队列时原实现会 setValue(0, EWOULDBLOCK)，直接写坏 WASM 地址 0。联机每帧都会轮询空队列，
     * 这不是偶发边角；在适配层用真实导出指针兜住，等升级引擎后由检查脚本提醒重新取证。
     */
    const errnoPtr = net.em?.Module?.ccall?.('getErrnoLocation', 'number', [], []) || 0
    if (errnoPtr) net.em.setValue(errnoPtr, 73, 'i32')
    return -1
  }
  // Emscripten 导入名是 sendto_batch，而 npm 包只实现了驼峰方法；不补别名时批量包会静默返回 -1。
  net.sendto_batch = net.sendtoBatch.bind(net)
  return net
}

function eventBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return data.arrayBuffer().then((buffer) => new Uint8Array(buffer))
}

function relayUrl(server, locationObject) {
  // 路径固定在本站 API；目录只能选择后端注册的短 ID，不能把客户端返回值变成任意 WebSocket 目标。
  const url = new URL('/api/cs16/relay', locationObject.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('server', server.id)
  return url.href
}

export function validRelayServer(server) {
  return !!server && typeof server === 'object' &&
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(server.id) &&
    Number.isInteger(server.netId) && server.netId >= 1 && server.netId <= 65535 &&
    Number.isInteger(server.port) && server.port >= 1 && server.port <= 65535
}

/**
 * 把浏览器 WebSocket 数据报接到 Xash 的虚拟 UDP Net。
 * Net 必须在 xash.init() 前挂上，但 WSS 要等大资源写完后才连接，否则慢首载会在开局前耗尽空闲超时。
 */
export function createCs16RelayNet(server, {
  WebSocketImpl = WebSocket,
  locationObject = location,
  timeoutMs = 15_000,
  onDisconnect = () => {},
} = {}) {
  if (!validRelayServer(server)) throw new Error('The server directory returned an invalid connection identifier')
  const virtualIp = [101, 101, server.netId & 0xff, (server.netId >> 8) & 0xff]
  let socket = null
  let connectPromise = null
  let closedByClient = false
  let ready = false

  const sender = {
    sendto(packet) {
      // Xash 的 Net 用虚拟地址区分已验证目标。即使引擎或页面被注入了别的目标，也不能借现有 WSS 绕行。
      if (packet.port !== server.port || packet.ip.some((octet, index) => octet !== virtualIp[index])) return
      if (!socket || socket.readyState !== WebSocketImpl.OPEN || socket.bufferedAmount > MAX_WEBSOCKET_BUFFER) return
      // packet.data 是 WASM HEAP 的视图，下一帧可能被覆盖；WebSocket 异步发送前必须复制。
      socket.send(new Uint8Array(packet.data).slice())
    },
  }
  const net = prepareNet(new Net(sender, { hostname: 'webxash3d', hostID: 3000, maxPackets: 512 }))

  const connect = () => {
    if (connectPromise) return connectPromise
    connectPromise = new Promise((resolve, reject) => {
      socket = new WebSocketImpl(relayUrl(server, locationObject))
      socket.binaryType = 'arraybuffer'
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.close() } catch { /* 构造成功但还没 open 时也允许直接收尾 */ }
        reject(new Error('The online gateway did not become ready within 15 seconds'))
      }, timeoutMs)

      socket.addEventListener('message', async (event) => {
        if (typeof event.data === 'string') {
          let control
          try { control = JSON.parse(event.data) } catch { return }
          if (!settled && control?.type === 'ready' && control.server === server.id) {
            settled = true
            ready = true
            clearTimeout(timer)
            resolve()
          }
          return
        }
        try {
          const found = eventBytes(event.data)
          const data = found instanceof Uint8Array ? found : await found
          net.incoming.push({ data, ip: virtualIp, port: server.port })
        } catch {
          // 单个损坏帧按 UDP 丢包处理；不能让 message Promise 变成未处理拒绝并打断整局。
        }
      })
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('Unable to connect to the CS1.6 online gateway'))
        }
      })
      socket.addEventListener('close', (event) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new Error(`The online gateway closed before it was ready (${event.code || 'no status code'})`))
        } else if (ready && !closedByClient) {
          onDisconnect(`The connection to the server was lost (${event.reason || event.code || 'network interruption'})`)
        }
        ready = false
      })
    })
    return connectPromise
  }

  const close = () => {
    closedByClient = true
    ready = false
    try { socket?.close(1000, 'page closed') } catch { /* 页面卸载时浏览器可能已经销毁网络栈 */ }
  }

  return { net, connect, close, virtualIp }
}

export function validRoomDescriptor(room) {
  return !!room && typeof room === 'object' &&
    /^[A-HJ-NP-Z2-9]{6}$/.test(room.code) &&
    room.server && Number.isInteger(room.server.netId) && room.server.netId >= 1 && room.server.netId <= 65535 &&
    Number.isInteger(room.server.port) && room.server.port >= 1 && room.server.port <= 65535
}

export function roomConnectTimeoutMs(room, role, override) {
  if (Number.isFinite(override) && override > 0) return override
  if (role !== 'guest') return 15_000
  const remaining = Number(room?.hostWaitMsRemaining)
  if (Number.isFinite(remaining) && remaining >= 0) {
    // 加 15 秒覆盖房主上线通知与一次网络抖动；上限防止伪造接口把定时器拖成永久等待。
    return Math.max(30_000, Math.min(31 * 60_000, remaining + 15_000))
  }
  // 兼容滚动发布时尚未返回剩余时间的旧后端；房主首次加载通常明显超过两分钟。
  return 16 * 60_000
}

function roomUrl(room, role, locationObject) {
  const url = new URL('/api/cs16/room', locationObject.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('room', room.code)
  url.searchParams.set('role', role)
  if (role === 'host') url.searchParams.set('token', room.hostToken)
  return url.href
}

function roomHostIp(room) {
  return [ROOM_HOST_IP_PREFIX[0], ROOM_HOST_IP_PREFIX[1], room.server.netId & 0xff, (room.server.netId >> 8) & 0xff]
}

function roomGuestIp(peerId) {
  return [ROOM_GUEST_IP_PREFIX[0], ROOM_GUEST_IP_PREFIX[1], peerId & 0xff, (peerId >> 8) & 0xff]
}

function sameIp(left, right) {
  return left.length === right.length && left.every((octet, index) => octet === right[index])
}

/**
 * 房主浏览器里的监听服收发真实 GoldSrc 数据报；服务端只负责按 peerId 把包送到同房间玩家。
 * 虚拟 IP 仅用于让 Xash 把不同访客识别为不同客户端，不会离开浏览器/本站 WSS。
 */
export function createCs16RoomNet(room, role, {
  WebSocketImpl = WebSocket,
  locationObject = location,
  timeoutMs,
  onDisconnect = () => {},
  onStatus = () => {},
} = {}) {
  if (!validRoomDescriptor(room) || !['host', 'guest'].includes(role)) throw new Error('Invalid room connection settings')
  if (role === 'host' && !/^[A-Za-z0-9_-]{24,128}$/.test(String(room.hostToken || ''))) {
    throw new Error('Invalid host credentials')
  }
  const hostIp = roomHostIp(room)
  const connectionTimeoutMs = roomConnectTimeoutMs(room, role, timeoutMs)
  let socket = null
  let connectPromise = null
  let closedByClient = false
  let ready = false
  let peerId = 0

  const sender = {
    sendto(packet) {
      if (!socket || socket.readyState !== WebSocketImpl.OPEN || socket.bufferedAmount > MAX_WEBSOCKET_BUFFER) return
      const payload = new Uint8Array(packet.data).slice()
      if (role === 'guest') {
        if (packet.port !== room.server.port || !sameIp(packet.ip, hostIp)) return
        socket.send(payload)
        return
      }
      if (packet.ip[0] !== ROOM_GUEST_IP_PREFIX[0] || packet.ip[1] !== ROOM_GUEST_IP_PREFIX[1]) return
      const targetId = packet.ip[2] | (packet.ip[3] << 8)
      if (!targetId || packet.port !== ROOM_GUEST_PORT_BASE + ((targetId - 1) % 30_000)) return
      const envelope = new Uint8Array(payload.length + 2)
      envelope[0] = (targetId >> 8) & 0xff
      envelope[1] = targetId & 0xff
      envelope.set(payload, 2)
      socket.send(envelope)
    },
  }
  const net = prepareNet(new Net(sender, {
    hostname: 'webxash3d',
    hostID: role === 'host' ? room.server.netId : 3000,
    maxPackets: 1024,
  }))

  const connect = () => {
    if (connectPromise) return connectPromise
    connectPromise = new Promise((resolve, reject) => {
      socket = new WebSocketImpl(roomUrl(room, role, locationObject))
      socket.binaryType = 'arraybuffer'
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.close() } catch { /* CONNECTING 状态也允许直接收尾 */ }
        reject(new Error(role === 'host' ? 'The temporary server did not become ready' : 'Timed out waiting for the host. Make sure the host has started the game.'))
      }, connectionTimeoutMs)

      socket.addEventListener('message', async (event) => {
        if (typeof event.data === 'string') {
          let control
          try { control = JSON.parse(event.data) } catch { return }
          if (control?.type === 'room-waiting') {
            onStatus('The host is still loading. Waiting for the temporary server…')
            return
          }
          if (!settled && control?.type === 'room-ready' && control.code === room.code && control.role === role) {
            if (role === 'guest' && (!Number.isInteger(control.peerId) || control.peerId < 1 || control.peerId > 65535)) {
              settled = true
              clearTimeout(timer)
              reject(new Error('The room returned an invalid player ID'))
              return
            }
            peerId = role === 'guest' ? control.peerId : 0
            settled = true
            ready = true
            clearTimeout(timer)
            resolve(control)
          }
          return
        }
        if (!ready) return
        try {
          const found = eventBytes(event.data)
          const data = found instanceof Uint8Array ? found : await found
          if (role === 'host') {
            if (data.length < 3) return
            const sourceId = (data[0] << 8) | data[1]
            net.incoming.push({
              data: data.slice(2),
              ip: roomGuestIp(sourceId),
              port: ROOM_GUEST_PORT_BASE + ((sourceId - 1) % 30_000),
            })
          } else {
            net.incoming.push({ data: data.slice(), ip: hostIp, port: room.server.port })
          }
        } catch {
          // 房间沿用 UDP 丢包语义：一帧损坏不能把整局变成未处理 Promise 拒绝。
        }
      })
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('Unable to connect to the temporary server gateway'))
        }
      })
      socket.addEventListener('close', (event) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new Error(`The temporary server closed before it was ready (${event.reason || event.code || 'network interruption'})`))
        } else if (ready && !closedByClient) {
          onDisconnect(role === 'host'
            ? 'The temporary server connection was lost and the room has ended'
            : `The host left or the room connection was lost (${event.reason || event.code || 'network interruption'})`)
        }
        ready = false
      })
    })
    return connectPromise
  }

  const close = () => {
    closedByClient = true
    ready = false
    try { socket?.close(1000, 'page closed') } catch { /* 页面卸载时忽略 */ }
  }

  return { net, connect, close, hostIp, get peerId() { return peerId } }
}
