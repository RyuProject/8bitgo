import { Router } from 'express'
import { verifyToken } from '../auth.js'
import { queryOne } from '../db.js'
import { presenceFromRequest, UNKNOWN_PRESENCE } from '../presence.js'

/**
 * 联机房间注册表（内存版）。
 *
 * cloud-game 本身不对外暴露「有哪些房间」，所以前端在联机时定期向这里心跳，
 * 侧边栏「联机玩」就从这里读房间列表。
 *
 *   POST   /api/rooms/heartbeat   { roomId, gameSlug, memberId, nickname, playerIndex, host, rtt }
 *   DELETE /api/rooms/:roomId/members/:memberId   离开
 *   GET    /api/rooms             在线房间列表
 *
 * 成员超过 MEMBER_TTL 没心跳视为掉线；房间没有成员即消失。
 * 只在内存里，重启后清空（房间本来就是临时的）。多实例部署时请改成 Redis。
 *
 * 刻意不依赖数据库：只想跑联机、还没配 MySQL 时，把这个后端起起来房间列表就能用。
 */
export const roomsRouter = Router()

const MEMBER_TTL = 30_000
/** 房间数上限。心跳是公开接口，roomId 客户端随便填 —— 不设上限的话一个循环就能把内存刷爆 */
const MAX_ROOMS = Number(process.env.ROOMS_MAX || 1000)
const rooms = new Map() // roomId -> { roomId, gameSlug, createdAt, members: Map<memberId, member> }

function prune(now = Date.now()) {
  for (const [id, room] of rooms) {
    for (const [mid, m] of room.members) {
      if (now - m.seenAt > MEMBER_TTL) room.members.delete(mid)
    }
    if (room.members.size === 0) rooms.delete(id)
  }
}
setInterval(prune, 10_000).unref()

function publicRoom(room) {
  const members = [...room.members.values()].sort((a, b) => a.playerIndex - b.playerIndex)
  const host = members.find((m) => m.host) ?? members[0]
  return {
    roomId: room.roomId,
    gameSlug: room.gameSlug,
    createdAt: room.createdAt,
    host: host ? { nickname: host.nickname, userId: host.userId } : null,
    /** 房主的设备 / 地区 / 网络，房间卡片上那三个格子。见 presence.js */
    presence: host?.presence ?? UNKNOWN_PRESENCE,
    players: members.length,
    playerIndexes: members.map((m) => m.playerIndex),
    members: members.map((m) => ({
      nickname: m.nickname,
      playerIndex: m.playerIndex,
      host: Boolean(m.host),
      presence: m.presence ?? UNKNOWN_PRESENCE,
    })),
  }
}

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * 可选登录：认得出用户就用他的真实昵称，认不出（没登录、令牌过期、数据库没起来）
 * 就当游客放行。房间是纯内存功能，不能被数据库拖住。
 */
async function softUser(req, _res, next) {
  try {
    const h = req.headers.authorization || ''
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
    const payload = token ? verifyToken(token) : null
    if (payload?.uid) req.user = await queryOne('SELECT id, nickname FROM users WHERE id = ?', [payload.uid])
  } catch {
    /* 数据库不可用等情况：当作游客，不影响联机 */
  }
  next()
}

roomsRouter.get('/', (_req, res) => {
  prune()
  const list = [...rooms.values()].map(publicRoom).sort((a, b) => b.createdAt - a.createdAt)
  res.json(list)
})

roomsRouter.get('/:roomId', (req, res) => {
  prune()
  const room = rooms.get(req.params.roomId)
  if (!room) return res.status(404).json({ error: 'room not found' })
  res.json(publicRoom(room))
})

roomsRouter.post('/heartbeat', softUser, (req, res) => {
  const roomId = str(req.body.roomId, 200)
  const gameSlug = str(req.body.gameSlug)
  const memberId = str(req.body.memberId, 64)
  if (!roomId || !gameSlug || !memberId) return res.status(400).json({ error: 'roomId, gameSlug, memberId required' })

  const playerIndex = Math.max(0, Math.min(3, Number(req.body.playerIndex) || 0))
  const nickname = str(req.body.nickname, 32) || (req.user?.nickname ?? 'Guest')
  const now = Date.now()

  let room = rooms.get(roomId)
  if (!room) {
    if (rooms.size >= MAX_ROOMS) {
      prune(now)
      if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'too many rooms' })
    }
    room = { roomId, gameSlug, createdAt: now, members: new Map() }
    rooms.set(roomId, room)
  }
  const existing = room.members.get(memberId)
  // 第一个进来的就是 host；后来者即使自称 host 也不算
  const host = existing ? existing.host : room.members.size === 0 || Boolean(req.body.host && ![...room.members.values()].some((m) => m.host))
  /**
   * 名片每次心跳重算一遍，网络那一格才跟得上变化。
   *
   * 云端房间和另外两种不一样：它没有一条常驻的 socket，服务端量不到往返延迟，
   * 只能收下浏览器自己测的那个数（客户端拿上一次心跳请求的耗时，见 services/rooms.ts）。
   * 这一项因此是「客户端说了算」的，presenceFromRequest 里会钳范围；
   * 设备和国家仍然是服务端从 UA 和 IP 自己看的，报不了假。
   */
  const presence = presenceFromRequest(req, req.body.rtt)
  room.members.set(memberId, { memberId, nickname, playerIndex, host, userId: req.user?.id ?? null, seenAt: now, presence })
  res.json(publicRoom(room))
})

roomsRouter.delete('/:roomId/members/:memberId', (req, res) => {
  const room = rooms.get(req.params.roomId)
  if (room) {
    room.members.delete(req.params.memberId)
    if (room.members.size === 0) rooms.delete(room.roomId)
  }
  res.json({ ok: true })
})
