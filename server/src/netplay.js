import express from 'express'
import { Server } from 'socket.io'

/**
 * P2P 联机信令服务器（EmulatorJS netplay）+ 房主迁移。
 *
 * 这是「默认联机方案」的服务端全部内容 —— 只转发几个 SDP / ICE 包，
 * **画面和声音完全不经过这里**：房主的浏览器跑游戏，用 WebRTC 直推给其他玩家。
 *
 *   浏览器(房主) ──WebRTC 音视频──► 浏览器(访客)
 *          └──── 只有握手信息经过这里 ────┘
 *
 * 协议不是我们定的，是照着 EmulatorJS 的 data/src/netplay.js 实现的，事件名和字段必须一致：
 *
 *   socket.io 命名空间 /netplay
 *     open-room    {extra, maxPlayers, password} + ack(err)
 *     join-room    {extra, password}             + ack(err, users)
 *     leave-room
 *     users-updated  ← 服务端推送 { [userid]: {...extra, socketId} }
 *     webrtc-signal  双向，{target: socketId, offer|answer|candidate|requestRenegotiate}
 *                    转发时加上 sender: <发送方 socketId>
 *     data-message   双向，房间内广播（聊天、暂停、重开等）
 *
 *   GET /netplay/list?domain=&game_id=   → { [roomId]: {room_name, current, max, hasPassword} }
 *        这个路径和返回结构也是 netplay.js 里写死的（getOpenRooms）
 *
 * ── 房主迁移 ──────────────────────────────────────────────
 * 游戏跑在房主的浏览器里，房主一走这局本来就没了。为了不让大家白玩：
 *
 *   1. 房主每隔一段时间把压缩过的存档 POST 上来（只存最新一份，不向访客广播）
 *   2. 房主掉线时房间不立刻解散，而是进入「等待新房主」状态，保留 60 秒，
 *      并按加入顺序选出最早的那位访客当新房主
 *   3. 新房主加载存档、重新开房，然后调 /migrate 把新旧房间接上；
 *      旧房间 id 变成别名，**原来的邀请链接继续有效**
 *   4. 60 秒内没人接手就真的解散
 *
 * 存档只在内存里，跟着房间一起消失。多实例部署时改成 Redis + 对象存储。
 */

const MAX_PLAYERS = 4
/** 房主掉线后保留房间、等人接手的时间（测试里会调短） */
const HOST_GRACE_MS = Number(process.env.NETPLAY_HOST_GRACE_MS || 60_000)
/** 单份存档上限。NES 约 100KB，N64 / PS1 可能到几 MB */
const MAX_STATE_BYTES = 12 * 1024 * 1024

/** roomId(sessionid) -> room */
const rooms = new Map()
/** socket.id -> roomId */
const socketRoom = new Map()
/** 旧 roomId -> 新 roomId（房主迁移后，让老邀请链接继续有效） */
const aliases = new Map()

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** 顺着别名链找到房间当前真正的 id */
export function resolveRoomId(roomId, depth = 0) {
  const next = aliases.get(roomId)
  if (!next || depth > 8) return roomId
  return resolveRoomId(next, depth + 1)
}

function getRoom(roomId) {
  return rooms.get(resolveRoomId(roomId))
}

function publicRoom(room) {
  return {
    room_name: room.roomName,
    current: room.users.size,
    max: room.maxPlayers,
    hasPassword: Boolean(room.password),
  }
}

/** 侧边栏 / 房间页用的结构（和 cloud-game 的 /api/rooms 对齐，方便合并展示） */
function detailedRoom(room) {
  const users = [...room.users.values()]
  const owner = users.find((u) => u.userid === room.ownerUserId) ?? users[0]
  return {
    roomId: room.id,
    gameId: room.gameId,
    roomName: room.roomName,
    createdAt: room.createdAt,
    host: owner ? { nickname: owner.player_name || 'Player' } : null,
    players: room.users.size,
    max: room.maxPlayers,
    hasPassword: Boolean(room.password),
    members: users.map((u) => ({ nickname: u.player_name || 'Player', host: u.userid === room.ownerUserId })),
    kind: 'p2p',
    // 房主迁移相关：客户端靠这几个字段决定「我要不要接手」「该去哪个新房间」
    awaitingHost: Boolean(room.awaitingHost),
    nextHostUserId: room.nextHostUserId ?? null,
    hasState: Boolean(room.state),
    migratedTo: null,
  }
}

function usersPayload(room) {
  const out = {}
  for (const [userid, u] of room.users) out[userid] = u
  return out
}

function destroyRoom(room) {
  if (room.graceTimer) clearTimeout(room.graceTimer)
  for (const [, u] of room.users) socketRoom.delete(u.socketId)
  rooms.delete(room.id)
  room.state = null
  // 房间彻底没了，指向它的别名也没意义了
  for (const [from, to] of aliases) if (to === room.id || from === room.id) aliases.delete(from)
}

/**
 * 房主掉线：不立刻解散，选出下一位房主并保留 60 秒。
 * 剩下的人靠轮询 /api/netplay/rooms/:id 看到 awaitingHost 与 nextHostUserId。
 */
function beginHostMigration(nsp, room) {
  const remaining = [...room.users.values()]
  if (remaining.length === 0) {
    destroyRoom(room)
    return
  }
  room.awaitingHost = true
  room.ownerSocketId = null
  // 按加入顺序选：Map 保留插入顺序，最早进来的那位接手
  room.nextHostUserId = remaining[0].userid

  nsp.to(room.id).emit('data-message', { 'host-migrating': { roomId: room.id, nextHost: room.nextHostUserId } })
  nsp.to(room.id).emit('users-updated', usersPayload(room))

  if (room.graceTimer) clearTimeout(room.graceTimer)
  room.graceTimer = setTimeout(() => {
    // 没人接手，这局就真的结束了
    if (rooms.get(room.id) === room && room.awaitingHost) {
      nsp.to(room.id).emit('data-message', { 'host-left': true })
      destroyRoom(room)
    }
  }, HOST_GRACE_MS)
  room.graceTimer.unref?.()
}

function removeSocket(socket, nsp) {
  const roomId = socketRoom.get(socket.id)
  if (!roomId) return
  socketRoom.delete(socket.id)
  const room = rooms.get(roomId)
  if (!room) return

  const wasHost = room.ownerSocketId === socket.id
  for (const [userid, u] of room.users) {
    if (u.socketId === socket.id) room.users.delete(userid)
  }
  socket.leave(roomId)

  if (room.users.size === 0) {
    destroyRoom(room)
    return
  }
  if (wasHost) {
    beginHostMigration(nsp, room)
    return
  }
  nsp.to(roomId).emit('users-updated', usersPayload(room))
}

/**
 * 挂到已有的 http server 与 express app 上。
 * @param httpServer node http server（app.listen 返回的那个不行，要用 createServer(app)）
 * @param app express app
 * @param origins CORS 白名单，与主服务保持一致
 */
export function attachNetplay(httpServer, app, origins = ['*']) {
  const io = new Server(httpServer, {
    // EmulatorJS 客户端用默认的 /socket.io 路径连接，并把 URL 里的 /netplay 当命名空间
    cors: {
      origin: origins.includes('*') ? true : origins,
      methods: ['GET', 'POST'],
    },
    // 顺带把 socket.io 客户端脚本也发出去：模拟器 iframe 需要全局的 io()
    serveClient: true,
  })

  const nsp = io.of('/netplay')

  nsp.on('connection', (socket) => {
    socket.on('open-room', (payload, ack) => {
      const extra = payload?.extra ?? {}
      const roomId = str(extra.sessionid, 64)
      const userid = str(extra.userid, 64)
      if (!roomId || !userid) return ack?.('bad request')
      if (rooms.has(roomId)) return ack?.('room already exists')

      const room = {
        id: roomId,
        gameId: extra.game_id ?? null,
        domain: str(extra.domain, 200),
        roomName: str(extra.room_name, 60) || 'Room',
        maxPlayers: Math.max(2, Math.min(MAX_PLAYERS, Number(payload?.maxPlayers) || 2)),
        password: str(payload?.password, 60),
        ownerUserId: userid,
        ownerSocketId: socket.id,
        createdAt: Date.now(),
        users: new Map(),
        state: null,
        stateAt: 0,
        awaitingHost: false,
        nextHostUserId: null,
        graceTimer: null,
      }
      room.users.set(userid, { ...extra, socketId: socket.id })
      rooms.set(roomId, room)
      socketRoom.set(socket.id, roomId)
      socket.join(roomId)

      ack?.(null)
      nsp.to(roomId).emit('users-updated', usersPayload(room))
    })

    socket.on('join-room', (payload, ack) => {
      const extra = payload?.extra ?? {}
      const room = getRoom(str(extra.sessionid, 64))
      const userid = str(extra.userid, 64)
      if (!room) return ack?.('room not found')
      if (!userid) return ack?.('bad request')
      if (room.password && str(payload?.password, 60) !== room.password) return ack?.('wrong password')
      if (room.users.size >= room.maxPlayers) return ack?.('room is full')

      room.users.set(userid, { ...extra, socketId: socket.id })
      socketRoom.set(socket.id, room.id)
      socket.join(room.id)

      ack?.(null, usersPayload(room))
      nsp.to(room.id).emit('users-updated', usersPayload(room))
    })

    socket.on('leave-room', () => removeSocket(socket, nsp))
    socket.on('disconnect', () => removeSocket(socket, nsp))

    // 纯转发：把握手信息送给指定的那个 socket，并告诉对方是谁发的
    socket.on('webrtc-signal', (data) => {
      const target = str(data?.target, 64)
      if (!target) return
      const roomId = socketRoom.get(socket.id)
      if (!roomId || socketRoom.get(target) !== roomId) return // 不允许跨房间发信令
      nsp.to(target).emit('webrtc-signal', { ...data, sender: socket.id })
    })

    // 聊天 / 暂停 / 重开等：房间内广播
    socket.on('data-message', (d) => {
      const roomId = socketRoom.get(socket.id)
      if (!roomId) return
      socket.to(roomId).emit('data-message', d)
    })
  })

  /** EmulatorJS 的房间列表接口（路径与返回结构由 netplay.js 的 getOpenRooms 决定，不能改） */
  app.get('/netplay/list', (req, res) => {
    const { domain, game_id: gameId } = req.query
    const out = {}
    for (const [id, room] of rooms) {
      if (room.awaitingHost) continue // 正在换房主，先别让人进来
      if (domain && room.domain && room.domain !== domain) continue
      if (gameId !== undefined && String(room.gameId) !== String(gameId)) continue
      if (room.users.size >= room.maxPlayers) continue
      out[id] = publicRoom(room)
    }
    res.json(out)
  })

  /** 本站自己的房间列表（不按游戏过滤，侧边栏要显示所有正在玩的房间） */
  app.get('/api/netplay/rooms', (_req, res) => {
    res.json([...rooms.values()].map(detailedRoom).sort((a, b) => b.createdAt - a.createdAt))
  })

  /**
   * 单个房间。顺着别名走，所以房主迁移之后老邀请链接依然能查到房间；
   * 查到的房间 id 变了就在 migratedTo 里告诉客户端，让它跟过去。
   */
  app.get('/api/netplay/rooms/:roomId', (req, res) => {
    const asked = req.params.roomId
    const room = getRoom(asked)
    if (!room) return res.status(404).json({ error: 'room not found' })
    const out = detailedRoom(room)
    if (room.id !== asked) out.migratedTo = room.id
    res.json(out)
  })

  /** 房主上传最新存档（只留一份）。房主掉线时交给新房主，让游戏能接着玩 */
  app.post(
    '/api/netplay/rooms/:roomId/state',
    express.raw({ type: () => true, limit: MAX_STATE_BYTES }),
    (req, res) => {
      const room = getRoom(req.params.roomId)
      if (!room) return res.status(404).json({ error: 'room not found' })
      const user = str(req.get('x-netplay-user'), 64)
      if (!user || user !== room.ownerUserId) return res.status(403).json({ error: 'not the host' })
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty state' })
      room.state = req.body
      room.stateAt = Date.now()
      res.json({ ok: true, bytes: room.state.length })
    },
  )

  /** 新房主取存档 */
  app.get('/api/netplay/rooms/:roomId/state', (req, res) => {
    const room = getRoom(req.params.roomId)
    if (!room?.state) return res.status(404).json({ error: 'no state' })
    res.set('Content-Type', 'application/octet-stream')
    res.set('X-State-Age', String(Date.now() - room.stateAt))
    res.send(room.state)
  })

  /**
   * 接手：新房主已经用新的 roomId 开好房，这里把新旧接上。
   * 旧 id 变成别名（老邀请链接继续有效），存档也一并转移过去。
   */
  app.post('/api/netplay/rooms/:roomId/migrate', express.json(), (req, res) => {
    const oldRoom = rooms.get(resolveRoomId(req.params.roomId))
    const newRoomId = str(req.body?.newRoomId, 64)
    const userId = str(req.body?.userId, 64)
    const newRoom = rooms.get(newRoomId)

    if (!oldRoom || !oldRoom.awaitingHost) return res.status(409).json({ error: 'room is not awaiting a host' })
    if (!newRoom) return res.status(404).json({ error: 'new room not found' })
    if (oldRoom.nextHostUserId !== userId) return res.status(403).json({ error: 'not the elected host' })
    if (newRoom.ownerUserId !== userId) return res.status(403).json({ error: 'not the owner of the new room' })

    // 存档跟着走，方便下一次再迁移
    if (!newRoom.state && oldRoom.state) {
      newRoom.state = oldRoom.state
      newRoom.stateAt = oldRoom.stateAt
    }
    newRoom.createdAt = oldRoom.createdAt

    if (oldRoom.graceTimer) clearTimeout(oldRoom.graceTimer)
    // 告诉还留在旧房间里的人去哪儿
    nsp.to(oldRoom.id).emit('data-message', { 'host-migrated': { roomId: newRoomId } })
    for (const [, u] of oldRoom.users) socketRoom.delete(u.socketId)
    rooms.delete(oldRoom.id)
    aliases.set(oldRoom.id, newRoomId)
    // 旧的别名也一起指过来，链子不要越接越长
    for (const [from, to] of aliases) if (to === oldRoom.id) aliases.set(from, newRoomId)

    res.json({ ok: true, roomId: newRoomId })
  })

  return io
}
