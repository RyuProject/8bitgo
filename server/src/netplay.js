import express from 'express'
import { randomBytes } from 'node:crypto'
import { Server } from 'socket.io'
import { watchPresence, UNKNOWN_PRESENCE } from './presence.js'

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
/**
 * 观众上限。观众不占手柄位，但每人仍是房主那边的一条 WebRTC 上行流 ——
 * 家宽上行大约撑到十来路，所以这里给的是个保守值。
 * 真要做几十上百人的直播，得在中间加 SFU（房主只推一路，服务器转发 N 路）。
 */
const MAX_SPECTATORS = Number(process.env.NETPLAY_MAX_SPECTATORS || 12)
/** 房主掉线后保留房间、等人接手的时间（测试里会调短） */
const HOST_GRACE_MS = Number(process.env.NETPLAY_HOST_GRACE_MS || 30_000)
/**
 * 选中的接班人有多久时间接手，超时就换下一个。
 *
 * 以前只选一个人然后干等到宽限期结束 —— 那个人要是也断网了、切后台被浏览器冻结了、
 * 或者干脆关了页面，房间就白白等死，哪怕屋里还有别人能接。现在轮着问，问到有人接为止。
 */
const CLAIM_MS = Number(process.env.NETPLAY_CLAIM_MS || 8_000)
/** 单份存档上限。NES 约 100KB，N64 / PS1 可能到几 MB */
const MAX_STATE_BYTES = 12 * 1024 * 1024
/** 同时存在的房间上限。信令是公开接口，不设上限的话开房就能把内存刷爆 */
const MAX_ROOMS = Number(process.env.NETPLAY_MAX_ROOMS || 500)
/** 单个连接每秒最多广播几条 data-message（聊天 / 暂停之类），防刷屏 */
const MSG_PER_SEC = 20
/**
 * 服务端保留的控制消息 key。
 * data-message 是房间内广播，原样转发的话任何一个访客都能自己发一条
 * { 'host-migrated': { roomId: '我的房间' } } 把整屋子人骗走，
 * 或者发 { 'host-left': true } 直接把这局搞崩。这几个 key 只能由服务器发出。
 */
const RESERVED_KEYS = new Set(['host-migrating', 'host-migrated', 'host-left'])

/** roomId(sessionid) -> room */
const rooms = new Map()
/** socket.id -> roomId */
const socketRoom = new Map()
/** 旧 roomId -> 新 roomId（房主迁移后，让老邀请链接继续有效） */
const aliases = new Map()
/** SSE 订阅者：{ res, watch }。房间有任何变化就推给他们，取代前端的轮询 */
const watchers = new Set()

/**
 * 房间有变化时推给所有 SSE 订阅者。
 * 前端原来是「房间列表每 6 秒轮询 + 在房间里时每 2.5 秒查自己的房间」——
 * 侧边栏在每个页面都挂着，等于每个在线访客持续打请求。改成推送后平时零请求，
 * 换房主、满员这些变化也立刻可见。同一轮的多次变化会合并成一次推送。
 */
let notifyTimer = null
function notifyRooms() {
  if (notifyTimer || watchers.size === 0) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    const list = [...rooms.values()].map(detailedRoom).sort((a, b) => b.createdAt - a.createdAt)
    const payload = `event: rooms\ndata: ${JSON.stringify(list)}\n\n`
    for (const w of watchers) {
      try {
        w.res.write(payload)
        if (w.watch) w.res.write(roomEvent(w.watch))
      } catch {
        watchers.delete(w)
      }
    }
  }, 120)
  notifyTimer.unref?.()
}

/** 单个房间的 SSE 事件：顺着别名解析，房间没了就发 gone */
function roomEvent(askedId) {
  const room = getRoom(askedId)
  if (!room) return `event: room-gone\ndata: ${JSON.stringify({ roomId: askedId })}\n\n`
  const out = detailedRoom(room)
  if (room.id !== askedId) out.migratedTo = room.id
  return `event: room\ndata: ${JSON.stringify(out)}\n\n`
}

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
    // 这是 EmulatorJS 自带菜单读的结构，current 必须是「占手柄位的人数」，
    // 否则观众一多它就以为房间满了、不让人加入
    room_name: room.roomName,
    current: playerCount(room),
    max: room.maxPlayers,
    hasPassword: Boolean(room.password),
  }
}

/** 侧边栏 / 房间页用的结构（和 cloud-game 的 /api/rooms 对齐，方便合并展示） */
/** 取某个成员当前的名片快照；老连接或者异常情况下退回全未知，不能让列表 500 */
function presenceOf(u) {
  try {
    return typeof u?.presence === 'function' ? u.presence() : UNKNOWN_PRESENCE
  } catch {
    return UNKNOWN_PRESENCE
  }
}

function detailedRoom(room) {
  const users = [...room.users.values()]
  const owner = users.find((u) => u.userid === room.ownerUserId) ?? users[0]
  return {
    roomId: room.id,
    gameId: room.gameId,
    roomName: room.roomName,
    createdAt: room.createdAt,
    host: owner ? { nickname: owner.player_name || 'Player' } : null,
    /** 房主的设备 / 地区 / 网络，房间卡片上那三个格子。见 presence.js */
    presence: owner ? presenceOf(owner) : UNKNOWN_PRESENCE,
    players: playerCount(room),
    max: room.maxPlayers,
    // 观众：只看不操作。房间列表 / 直播列表用它显示「N 人在看」
    spectators: spectatorCount(room),
    maxSpectators: MAX_SPECTATORS,
    hasPassword: Boolean(room.password),
    members: users.map((u) => ({
      nickname: u.player_name || 'Player',
      host: u.userid === room.ownerUserId,
      role: u.role === 'spectator' ? 'spectator' : 'player',
      presence: presenceOf(u),
    })),
    kind: 'p2p',
    // 房主迁移相关：客户端靠这几个字段决定「我要不要接手」「该去哪个新房间」
    awaitingHost: Boolean(room.awaitingHost),
    nextHostUserId: room.nextHostUserId ?? null,
    hasState: Boolean(room.state),
    migratedTo: null,
  }
}

/** 广播给房间成员的用户表。令牌要摘掉——那是各人自己的凭证，不能广播 */
/** 房间里的玩家数（占手柄位的那些）。没标角色的一律算玩家，兼容老客户端 */
function playerCount(room) {
  let n = 0
  for (const [, u] of room.users) if (u.role !== 'spectator') n++
  return n
}

function spectatorCount(room) {
  let n = 0
  for (const [, u] of room.users) if (u.role === 'spectator') n++
  return n
}

/**
 * 广播给房间里每个人的成员表。
 *
 * ⚠️ 顺序有含义：EmulatorJS 的 `getUserIndex()` 就是拿
 * `Object.keys(this.players).indexOf(myId)` 当手柄号用的。
 * 我们放观众进来之后，房间人数会超过 maxPlayers —— 如果按加入顺序排，
 * 「第 3 个进来的人后来上场当玩家」拿到的手柄号就是 2，而双人游戏根本没有 3P，
 * 他的按键会被塞进一个不存在的手柄位。
 *
 * 所以这里**玩家排前面、观众排后面**（各自内部保持加入顺序）：
 * 玩家的下标就永远落在 0..maxPlayers-1 里。
 */
function usersPayload(room) {
  const out = {}
  // presence 也要摘掉：它是个函数（取快照用），塞进 users-updated 只会变成
  // 一个空对象跟着广播给 EmulatorJS，白占带宽；房间列表那边自己会调它
  const strip = (u) => {
    const { token: _t, presence: _p, ...rest } = u
    return rest
  }
  for (const [userid, u] of room.users) if (u.role !== 'spectator') out[userid] = strip(u)
  for (const [userid, u] of room.users) if (u.role === 'spectator') out[userid] = strip(u)
  return out
}

/**
 * 房间令牌。
 * 以前上传存档、接手房主用 `userid` 判断身份，而 userid 是客户端自己填的，
 * 还随 users-updated 广播给房间里每个人 —— 任何访客都能拿房主的 userid 覆盖存档，
 * 或者冒充「被选中的接班人」把房间接走。改成服务端随机发令牌，单独发给本人。
 */
function issueToken(room, userid, socket) {
  const token = randomBytes(24).toString('base64url')
  const u = room.users.get(userid)
  if (u) u.token = token
  socket.emit('room-token', { roomId: room.id, userid, token })
  return token
}

/** 校验令牌属于该房间的某个成员 */
function memberByToken(room, token) {
  if (!token) return null
  for (const [, u] of room.users) if (u.token && u.token === token) return u
  return null
}

function destroyRoom(room) {
  if (room.graceTimer) clearTimeout(room.graceTimer)
  for (const [, u] of room.users) socketRoom.delete(u.socketId)
  rooms.delete(room.id)
  room.state = null
  // 房间彻底没了，指向它的别名也没意义了
  for (const [from, to] of aliases) if (to === room.id || from === room.id) aliases.delete(from)
  notifyRooms()
}

/**
 * 房主掉线：不立刻解散，选出下一位房主并保留 60 秒。
 * 剩下的人靠轮询 /api/netplay/rooms/:id 看到 awaitingHost 与 nextHostUserId。
 */
function beginHostMigration(nsp, room) {
  if (room.users.size === 0) {
    destroyRoom(room)
    return
  }
  room.awaitingHost = true
  room.ownerSocketId = null
  room.migrationStartedAt = Date.now()

  // 候选名单：优先玩家，观众排在最后 —— 观众是主动选择「只看」的，让他接手不合适，
  // 但实在只剩观众了还是要问（总比这局直接散掉强）。同类里按加入顺序（Map 保留插入顺序）。
  const buildCandidates = () => {
    const all = [...room.users.values()]
    return [
      ...all.filter((u) => u.role !== 'spectator'),
      ...all.filter((u) => u.role === 'spectator'),
    ].map((u) => u.userid)
  }
  room.candidates = buildCandidates()

  /**
   * 问下一位接手。
   *
   * 每位有 CLAIM_MS 的时间响应，没动静就顺延给下一位，直到有人接手、名单问完、
   * 或者总时长超过宽限期。这是「游戏不因房主掉线而结束」的关键 ——
   * 只问一个人的话，那个人不在状态整局就没了。
   */
  const offerNext = () => {
    if (rooms.get(room.id) !== room || !room.awaitingHost) return

    // 中途离开房间的人要从名单里剔掉
    while (room.candidates.length && !room.users.has(room.candidates[0])) room.candidates.shift()

    if (Date.now() - room.migrationStartedAt >= HOST_GRACE_MS) {
      // 宽限期到了都没人接，这局才真的结束
      nsp.to(room.id).emit('data-message', { 'host-left': true })
      destroyRoom(room)
      return
    }
    if (!room.candidates.length) {
      // 一轮问下来没人接：只要还在宽限期内就重新问一轮。
      // 接手要下载存档、加载核心，慢的人一轮 CLAIM_MS 未必够 ——
      // 问一遍就散掉的话，只有一个访客的房间反而比不轮询时更容易死。
      room.candidates = buildCandidates()
      if (!room.candidates.length) {
        // 屋里真的一个人都不剩了
        destroyRoom(room)
        return
      }
    }

    room.nextHostUserId = room.candidates[0]
    nsp.to(room.id).emit('data-message', {
      'host-migrating': { roomId: room.id, nextHost: room.nextHostUserId },
    })
    nsp.to(room.id).emit('users-updated', usersPayload(room))
    notifyRooms()

    if (room.graceTimer) clearTimeout(room.graceTimer)
    const left = HOST_GRACE_MS - (Date.now() - room.migrationStartedAt)
    room.graceTimer = setTimeout(() => {
      room.candidates.shift() // 这位没接手，换下一位
      offerNext()
      // 下次问的间隔：正常是 CLAIM_MS，但不能超过剩余的宽限期，
      // 否则宽限期设得很短时（测试里会设成几百毫秒）会拖过头。下限 200ms 防止空转。
    }, Math.max(200, Math.min(CLAIM_MS, left)))
    room.graceTimer.unref?.()
  }

  offerNext()
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
  notifyRooms()
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
    /**
     * 默认 25 秒。心跳的往返时间正好是我们量「房主网络好不好」的尺子
     * （见 presence.js 的 trackRtt），25 秒意味着房间刚开出来的头半分钟
     * 网络格子只能显示未知。10 秒一个来回，一条连接每分钟多六个几十字节的包，
     * 换来的是列表里那个格子几乎一开就是准的。
     * 副作用：掉线判定也跟着变快（pingInterval + pingTimeout，45s → 30s），这是好事。
     */
    pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 10_000),
  })

  const nsp = io.of('/netplay')

  nsp.on('connection', (socket) => {
    /**
     * 握手时就把设备和国家定下来，RTT 交给心跳持续更新。
     * 一条连接建一次就够 —— 同一个人开房、进房、换角色都复用这一张名片。
     */
    socket.data.presence = watchPresence(socket)

    socket.on('open-room', (payload, ack) => {
      const extra = payload?.extra ?? {}
      const roomId = str(extra.sessionid, 64)
      const userid = str(extra.userid, 64)
      if (!roomId || !userid) return ack?.('bad request')
      if (rooms.has(roomId)) return ack?.('room already exists')
      // 一个连接同时只能待在一个房间里，也就只能开一个房，否则一个脚本就能刷满
      if (socketRoom.has(socket.id)) return ack?.('already in a room')
      if (rooms.size >= MAX_ROOMS) return ack?.('server is full')

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
        /** 换房主时还没问过的候选名单（玩家优先、观众靠后） */
        candidates: [],
        /** 这一轮换房主开始的时间，用来卡总的宽限时长 */
        migrationStartedAt: 0,
      }
      // presence 写在 ...extra 后面：extra 整个是客户端给的，它自己塞一个
      // presence 进来就等于自选国旗，必须由服务端的这一份覆盖掉
      room.users.set(userid, { ...extra, socketId: socket.id, role: 'player', presence: socket.data.presence })
      rooms.set(roomId, room)
      socketRoom.set(socket.id, roomId)
      socket.join(roomId)

      ack?.(null)
      issueToken(room, userid, socket)
      nsp.to(roomId).emit('users-updated', usersPayload(room))
      notifyRooms()
    })

    socket.on('join-room', (payload, ack) => {
      const extra = payload?.extra ?? {}
      const room = getRoom(str(extra.sessionid, 64))
      const userid = str(extra.userid, 64)
      if (!room) return ack?.('room not found')
      if (!userid) return ack?.('bad request')
      if (room.password && str(payload?.password, 60) !== room.password) return ack?.('wrong password')
      if (socketRoom.has(socket.id)) return ack?.('already in a room')
      // 正在换房主的房间先别放人进来，不然新来的会连到一个马上要消失的房主
      if (room.awaitingHost) return ack?.('room is changing host')

      // 手柄位满了不再把人拒之门外，改成让他当观众（只看不操作）。
      // 客户端也可以事后调 /role 主动把自己降成观众。
      const asSpectator = playerCount(room) >= room.maxPlayers
      if (asSpectator && spectatorCount(room) >= MAX_SPECTATORS) return ack?.('room is full')

      room.users.set(userid, {
        ...extra,
        socketId: socket.id,
        role: asSpectator ? 'spectator' : 'player',
        presence: socket.data.presence, // 同 open-room：不能让 extra 覆盖它
      })
      socketRoom.set(socket.id, room.id)
      socket.join(room.id)

      ack?.(null, usersPayload(room))
      issueToken(room, userid, socket)
      nsp.to(room.id).emit('users-updated', usersPayload(room))
      notifyRooms()
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
    let msgWindow = 0
    let msgCount = 0
    socket.on('data-message', (d) => {
      const roomId = socketRoom.get(socket.id)
      if (!roomId) return

      const now = Date.now()
      if (now - msgWindow > 1000) {
        msgWindow = now
        msgCount = 0
      }
      if (++msgCount > MSG_PER_SEC) return

      // 服务端保留的控制 key 一律摘掉，见 RESERVED_KEYS 的说明
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        let dirty = false
        for (const k of Object.keys(d)) {
          if (RESERVED_KEYS.has(k)) {
            delete d[k]
            dirty = true
          }
        }
        if (dirty && Object.keys(d).length === 0) return
      }
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
      if (playerCount(room) >= room.maxPlayers) continue
      out[id] = publicRoom(room)
    }
    res.json(out)
  })

  /**
   * 房间变化的事件流（SSE）。取代前端的两处轮询。
   *   ?watch=<roomId>  额外订阅某个房间（顺着别名解析，换过房主也跟得上）
   * 用 SSE 不用 WebSocket：单向推送够用，浏览器自带断线重连，也不用再引依赖。
   */
  app.get('/api/netplay/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx 默认缓冲响应，缓冲住 SSE 就完全不推了
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()

    const watch = str(req.query.watch, 64)
    const w = { res, watch }
    watchers.add(w)

    const list = [...rooms.values()].map(detailedRoom).sort((a, b) => b.createdAt - a.createdAt)
    res.write(`event: rooms\ndata: ${JSON.stringify(list)}\n\n`)
    if (watch) res.write(roomEvent(watch))

    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(beat)
        watchers.delete(w)
      }
    }, 25_000)
    beat.unref?.()

    req.on('close', () => {
      clearInterval(beat)
      watchers.delete(w)
    })
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
      // 优先认房间令牌；没带令牌时退回旧的 userid（兼容还没升级的前端）
      const token = str(req.get('x-netplay-token'), 64)
      const me = token ? memberByToken(room, token) : null
      const user = me ? me.userid : str(req.get('x-netplay-user'), 64)
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
    // 存档是别人游戏进度的完整快照，只有房间成员能取（老前端没带令牌时放行，
    // 升级完可以把下面这行的 `|| !token` 去掉，变成强制）
    const token = str(req.get('x-netplay-token'), 64) || str(req.query.t, 64)
    if (token && !memberByToken(room, token)) return res.status(403).json({ error: 'not a member' })
    res.set('Cache-Control', 'no-store')
    res.set('Content-Type', 'application/octet-stream')
    res.set('X-State-Age', String(Date.now() - room.stateAt))
    res.send(room.state)
  })

  /**
   * 接手：新房主已经用新的 roomId 开好房，这里把新旧接上。
   * 旧 id 变成别名（老邀请链接继续有效），存档也一并转移过去。
   */
  /**
   * 切换自己的角色。observer ↔ player。
   * 用成员令牌鉴权 —— 和上传存档同一套，别人改不了你的角色，你也改不了别人的。
   */
  app.post('/api/netplay/rooms/:roomId/role', express.json(), (req, res) => {
    const room = getRoom(req.params.roomId)
    if (!room) return res.status(404).json({ error: 'room not found' })
    const me = memberByToken(room, str(req.get('x-netplay-token'), 64) || str(req.body?.token, 64))
    if (!me) return res.status(403).json({ error: 'not a member' })

    const want = req.body?.role === 'spectator' ? 'spectator' : 'player'
    if (want === me.role) return res.json({ ok: true, role: want })

    if (want === 'player') {
      // 想上场：得有空手柄位
      if (playerCount(room) >= room.maxPlayers) return res.status(409).json({ error: 'no free player slot' })
    } else {
      // 想下场看：房主不能把自己变成观众 —— 游戏就跑在他机器上
      if (me.userid === room.ownerUserId) return res.status(409).json({ error: 'the host cannot spectate' })
      if (spectatorCount(room) >= MAX_SPECTATORS) return res.status(409).json({ error: 'too many spectators' })
    }

    me.role = want
    nsp.to(room.id).emit('users-updated', usersPayload(room))
    notifyRooms()
    res.json({ ok: true, role: want })
  })

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

    notifyRooms()
    res.json({ ok: true, roomId: newRoomId })
  })

  return io
}
