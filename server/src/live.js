import { randomBytes } from 'node:crypto'
import { watchPresence, UNKNOWN_PRESENCE } from './presence.js'

/**
 * 直播信令（一人玩、多人看）。
 *
 * 和 netplay.js 是两回事，别混：
 *   netplay  = 大家一起玩，输入同步，人人都是玩家
 *   live     = 一个人玩，其他人只看画面听声音，不参与输入
 *
 * 为什么单独开一套而不是复用 netplay 的观众位：netplay 依赖 EmulatorJS
 * 4.3.0-pre 才有的那套 netplay 协议，而直播只需要「房主的画布 + 声音」，
 * 任何引擎都拿得到（见 emulator/types.ts 的 captureSources）。
 * 所以 GBA、DOS、Flash、J2ME 这些没有联机能力的引擎，一样能开播。
 *
 * 画面和声音**不经过服务器**，这里只转发 SDP / ICE：
 *
 *   浏览器(主播) ──WebRTC 音视频──► 浏览器(观众) × N
 *          └──── 只有握手信息经过这里 ────┘
 *
 * 代价是主播要给每个观众各推一份，上行 = 单路码率 × 人数。
 * 家宽上行大概到十来路就满了，所以有 MAX_VIEWERS 兜着。
 * 要做几十上百人得在中间加 SFU（主播只推一路，服务器扇出）。
 *
 * ── socket.io 命名空间 /live ──────────────────────────────
 *   go-live   {gameSlug, gameName, title, platform}  + ack(err, {roomId, token})
 *   watch     {roomId}                               + ack(err, {hostId, title, ...})
 *   signal    {target, data}   → 转发给 target，附上 from
 *   stop-live                                        主播主动下播
 *   ← viewer-joined  {viewerId}      发给主播，让它建一条新的 PeerConnection
 *   ← viewer-left    {viewerId}
 *   ← viewers        {count}         主播和观众都收
 *   ← live-ended     {reason}        发给观众
 */

/** 同时在播的房间上限：信令是公开接口，不设上限开播就能刷爆内存 */
const MAX_ROOMS = Number(process.env.LIVE_MAX_ROOMS || 200)
/** 单场直播的观众上限，见上面关于上行带宽的说明 */
const MAX_VIEWERS = Number(process.env.LIVE_MAX_VIEWERS || 12)

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** roomId -> room */
const rooms = new Map()
/** socket.id -> {roomId, role} */
const membership = new Map()

function publicRoom(room) {
  return {
    roomId: room.id,
    title: room.title,
    gameSlug: room.gameSlug,
    gameName: room.gameName,
    platform: room.platform,
    hostName: room.hostName,
    viewers: room.viewers.size,
    maxViewers: MAX_VIEWERS,
    startedAt: room.startedAt,
    /**
     * 主播的设备 / 地区 / 网络（见 presence.js）。全部是服务端从握手信息里看出来的，
     * 主播报不了假；RTT 是它到本站服务器的，不是到观众的 —— 画面走 WebRTC 直连，
     * 那条路我们量不到。
     */
    presence: presenceOf(room),
  }
}

/** 取主播的名片快照。房间是老结构（没有 presence）或者取快照出错时退回全未知 */
function presenceOf(room) {
  try {
    return typeof room?.presence === 'function' ? room.presence() : UNKNOWN_PRESENCE
  } catch {
    return UNKNOWN_PRESENCE
  }
}

/** 广播人数给房间里所有人（主播 + 观众） */
function notifyViewers(nsp, room) {
  nsp.to(room.id).emit('viewers', { roomId: room.id, count: room.viewers.size })
}

function closeRoom(nsp, room, reason) {
  nsp.to(room.id).emit('live-ended', { roomId: room.id, reason })
  for (const viewerId of room.viewers) membership.delete(viewerId)
  membership.delete(room.hostSocketId)
  rooms.delete(room.id)
}

function leave(nsp, socket) {
  const info = membership.get(socket.id)
  if (!info) return
  membership.delete(socket.id)
  const room = rooms.get(info.roomId)
  if (!room) return

  if (info.role === 'host') {
    // 主播走了就是散场：画面本来就来自它的浏览器，没有可接手的东西
    closeRoom(nsp, room, 'host-left')
    return
  }
  room.viewers.delete(socket.id)
  // 告诉主播可以把这条 PeerConnection 拆了，别留着占上行
  nsp.to(room.hostSocketId).emit('viewer-left', { viewerId: socket.id })
  notifyViewers(nsp, room)
}

/**
 * 挂到已有的 socket.io Server 上。
 * @param {import('socket.io').Server} io
 * @returns {{nsp: import('socket.io').Namespace, list: () => object[]}}
 */
export function attachLive(io) {
  const nsp = io.of('/live')

  nsp.on('connection', (socket) => {
    socket.on('go-live', (payload, ack) => {
      if (membership.has(socket.id)) return ack?.('already in a room')
      if (rooms.size >= MAX_ROOMS) return ack?.('server is full')

      const id = randomBytes(9).toString('base64url')
      const room = {
        id,
        // 令牌暂时只用于将来的下播 / 改标题接口，观众看不到
        token: randomBytes(24).toString('base64url'),
        title: str(payload?.title, 80) || str(payload?.gameName, 80) || 'Live',
        gameSlug: str(payload?.gameSlug, 120),
        gameName: str(payload?.gameName, 120),
        platform: str(payload?.platform, 40),
        hostName: str(payload?.hostName, 40),
        hostSocketId: socket.id,
        startedAt: Date.now(),
        viewers: new Set(),
        /**
         * 主播的名片。设备和国家在这一刻就定死了，RTT 由 socket.io 的心跳
         * 持续刷新，所以存的是个取快照的函数而不是一份数据。
         */
        presence: watchPresence(socket),
      }
      rooms.set(id, room)
      membership.set(socket.id, { roomId: id, role: 'host' })
      socket.join(id)
      ack?.(null, { roomId: id, token: room.token })
    })

    socket.on('watch', (payload, ack) => {
      const room = rooms.get(str(payload?.roomId, 64))
      if (!room) return ack?.('not found')
      if (membership.has(socket.id)) return ack?.('already in a room')
      if (room.viewers.size >= MAX_VIEWERS) return ack?.('full')

      room.viewers.add(socket.id)
      membership.set(socket.id, { roomId: room.id, role: 'viewer' })
      socket.join(room.id)
      ack?.(null, { ...publicRoom(room), hostId: room.hostSocketId })
      // 由主播发起 offer：它才知道自己有几条轨、什么编码
      nsp.to(room.hostSocketId).emit('viewer-joined', { viewerId: socket.id })
      notifyViewers(nsp, room)
    })

    /**
     * 转发握手包。只在同一个房间内、且只在「主播 ↔ 自己」之间转 ——
     * 不加这层校验的话，任何人都能拿别人的 socketId 往里塞 SDP。
     */
    socket.on('signal', (payload) => {
      const info = membership.get(socket.id)
      if (!info) return
      const room = rooms.get(info.roomId)
      if (!room) return
      const target = str(payload?.target, 64)
      if (!target) return
      if (info.role === 'host') {
        if (!room.viewers.has(target)) return
      } else if (target !== room.hostSocketId) {
        return
      }
      nsp.to(target).emit('signal', { from: socket.id, data: payload?.data })
    })

    socket.on('stop-live', () => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return
      const room = rooms.get(info.roomId)
      if (room) closeRoom(nsp, room, 'stopped')
    })

    socket.on('leave', () => leave(nsp, socket))
    socket.on('disconnect', () => leave(nsp, socket))
  })

  return { nsp, list: () => Array.from(rooms.values()).map(publicRoom) }
}

/** 给 REST 用：当前在播的房间 */
export function liveRooms({ gameSlug } = {}) {
  const all = Array.from(rooms.values())
  const picked = gameSlug ? all.filter((r) => r.gameSlug === gameSlug) : all
  return picked.sort((a, b) => b.viewers.size - a.viewers.size || a.startedAt - b.startedAt).map(publicRoom)
}

export function liveRoom(roomId) {
  const room = rooms.get(String(roomId || ''))
  return room ? publicRoom(room) : null
}
