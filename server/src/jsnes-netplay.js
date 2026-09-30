import { WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'

/**
 * jsnes 的 P2P 联机信令（与 EmulatorJS netplay **完全独立**的一条路）。
 *
 * 为什么另起一套：
 *   EmulatorJS 的联机是引擎自己在 iframe 里跑 WebRTC，服务端只转发它那套
 *   `open-room` / `join-room` / `webrtc-signal` 协议（见 netplay.js）。jsnes 是纯 JS、
 *   跑在主文档里，没有内置 netplay，得由我们自己建 RTCPeerConnection、交换输入。
 *   两条路共用同一个 httpServer，但走**不同的 path / 命名空间**，互不干扰 ——
 *   EmulatorJS 的协议、房主迁移、观众逻辑一概不动，这里只管「把两个 jsnes 浏览器连起来」。
 *
 * 协议（浏览器原生 WebSocket，路径 /jsnes-netplay）：
 *   客户端 → 服务端：
 *     {type:'host'}                         开房，服务端回房间号
 *     {type:'join', roomId}                 进房（房主必须已在）
 *     {type:'signal', to, data}             转发 WebRTC 握手（SDP / ICE）给 to 指定的连接
 *     {type:'leave'}                        离开
 *   服务端 → 客户端：
 *     {type:'room', roomId, you, seat}      房主拿到房间号（seat=0）
 *     {type:'joined', you, roomId, host, seat}  访客进房成功（seat=1）
 *     {type:'peer-joined', guest}           房主得知有访客，开始发 offer
 *     {type:'signal', from, data}           转发握手
 *     {type:'peer-left'}                    对端走了
 *     {type:'error', reason}                开/进房失败
 *
 * 人数：固定两人（NES 双人）。房主 seat=0（1P），访客 seat=1（2P）。
 * 信令里不传任何游戏内容 —— 输入走 WebRTC 数据通道，画面更不会过服务器。
 */

const MAX_ROOMS = Number(process.env.JSNES_NETPLAY_MAX_ROOMS || 500)
/** 单个连接每秒最多转发几条 signal，防刷 */
const SIGNALS_PER_SEC = 60

function makeRoomId() {
  // 6 位十六进制（Node 的 Buffer.toString 不支持 base36，用 hex 最稳），
  // 足够随机，又不至于在邀请链接里太长
  return randomBytes(4).toString('hex').slice(0, 6)
}

export function attachJsnesNetplay(httpServer, app, _origins = ['*']) {
  // maxPayload：ws 默认 100 MiB，信令最大也就几 KB 的 SDP，给 64 KB 足够
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

  /** roomId -> { hostId, players: Map<connId, {seat}>, createdAt } */
  const rooms = new Map()
  /**
   * connId -> ws。ws 8 的 wss.clients 是 **Set**（元素就是连接本身），不是 Map ——
   * 以前写成 `for (const [id, sock] of wss.clients)`，访客一进房就抛 “is not iterable”，
   * 这个异常发生在 ws 的 message 监听里没人接，直接打挂整个 Node 进程。
   */
  const conns = new Map()

  // 只接管 /jsnes-netplay 的 upgrade，其余（socket.io / IPX / SFS）一律放过
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      return
    }
    if (pathname !== '/jsnes-netplay') return
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } catch (e) {
      console.warn('[jsnes-netplay] upgrade 失败：', e?.message || e)
      socket.destroy()
    }
  })

  const send = (ws, obj) => {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
    } catch {
      /* 连接已断，忽略 */
    }
  }

  const roomPlayers = (room) => room.players.size

  wss.on('connection', (ws) => {
    ws.id = randomBytes(9).toString('hex')
    ws.roomId = null
    ws.sigWindow = 0
    ws.sigCount = 0
    conns.set(ws.id, ws)

    ws.on('message', (raw) => {
      // 任何异常都不能冒出 ws 的监听器：那里没人 catch，会直接变成 uncaughtException
      try {
        onMessage(raw)
      } catch (e) {
        console.warn('[jsnes-netplay] 处理消息失败：', e?.message || e)
      }
    })

    function onMessage(raw) {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'host') {
        // 先退出旧房间：否则同一条连接连发 host 就能把 MAX_ROOMS 占满
        if (ws.roomId) leave(ws)
        if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', reason: 'server is full' })
        let roomId = makeRoomId()
        while (rooms.has(roomId)) roomId = makeRoomId()
        const room = { hostId: ws.id, players: new Map(), createdAt: Date.now() }
        room.players.set(ws.id, { seat: 0 })
        rooms.set(roomId, room)
        ws.roomId = roomId
        send(ws, { type: 'room', roomId, you: ws.id, seat: 0 })
        return
      }

      if (msg.type === 'join') {
        // 房间号统一转小写：链接里是十六进制小写，进房时查表不会因为大小写不一致而查不到
        const roomId = typeof msg.roomId === 'string' ? msg.roomId.toLowerCase() : ''
        const room = rooms.get(roomId)
        if (!room) return send(ws, { type: 'error', reason: 'room not found' })
        if (!room.hostId) return send(ws, { type: 'error', reason: 'room not found' })
        if (ws.roomId === roomId) return
        if (room.players.size >= 2) return send(ws, { type: 'error', reason: 'room is full' })
        if (ws.roomId) leave(ws)
        room.players.set(ws.id, { seat: 1 })
        ws.roomId = roomId
        // 通知房主：有人来了，可以开始协商
        const host = conns.get(room.hostId)
        if (host) send(host, { type: 'peer-joined', guest: ws.id })
        send(ws, { type: 'joined', you: ws.id, roomId, host: room.hostId, seat: 1 })
        return
      }

      if (msg.type === 'signal') {
        if (typeof msg.to !== 'string' || !msg.data || typeof msg.data !== 'object') return
        const now = Date.now()
        if (now - ws.sigWindow > 1000) {
          ws.sigWindow = now
          ws.sigCount = 0
        }
        if (++ws.sigCount > SIGNALS_PER_SEC) return
        // 只转发给同一房间的对端，不能拿信令去骚扰任意连接
        const peer = conns.get(msg.to)
        if (peer && ws.roomId && peer.roomId === ws.roomId) {
          send(peer, { type: 'signal', from: ws.id, data: msg.data })
        }
        return
      }

      if (msg.type === 'leave') {
        leave(ws)
        return
      }
    }

    const onGone = () => {
      try {
        leave(ws)
      } catch (e) {
        console.warn('[jsnes-netplay] 清理连接失败：', e?.message || e)
      }
      conns.delete(ws.id)
    }
    ws.on('close', onGone)
    ws.on('error', onGone)
  })

  function leave(ws) {
    const roomId = ws.roomId
    if (!roomId) return
    ws.roomId = null
    const room = rooms.get(roomId)
    if (!room) return
    const wasHost = room.hostId === ws.id
    room.players.delete(ws.id)
    if (room.players.size === 0) {
      rooms.delete(roomId)
      return
    }
    // 通知剩下的那个人：对端走了
    for (const id of room.players.keys()) {
      const sock = conns.get(id)
      if (sock) send(sock, { type: 'peer-left' })
    }
    if (wasHost) {
      // 房主走了，房间直接散（jsnes 没有 EmulatorJS 那样的「房主迁移」需求：
      // 输入是逐帧锁步，接手的人状态对不上反而更乱）
      rooms.delete(roomId)
      for (const sock of conns.values()) {
        if (sock.roomId === roomId) {
          sock.roomId = null
          send(sock, { type: 'peer-left' })
        }
      }
    }
  }

  // 让本站房间列表也能看见 jsnes 联机（可选；不影响 EmulatorJS 那条）
  app.get('/api/jsnes-netplay/rooms', (_req, res) => {
    res.json(
      [...rooms.entries()].map(([roomId, room]) => ({
        roomId,
        players: roomPlayers(room),
        createdAt: room.createdAt,
      })),
    )
  })
  app.get('/api/jsnes-netplay/rooms/:roomId', (req, res) => {
    const room = rooms.get(String(req.params.roomId))
    if (!room) return res.status(404).json({ error: 'room not found' })
    res.json({ exists: true, players: roomPlayers(room) })
  })

  return wss
}
