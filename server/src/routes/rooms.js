import { Router } from 'express'
import { optionalUser } from '../auth.js'

/**
 * 联机房间注册表（内存版）。
 *
 * cloud-game 本身不对外暴露「有哪些房间」，所以前端在联机时定期向这里心跳，
 * 侧边栏「联机玩」就从这里读房间列表。
 *
 *   POST   /api/rooms/heartbeat   { roomId, gameSlug, memberId, nickname, playerIndex, host }
 *   DELETE /api/rooms/:roomId/members/:memberId   离开
 *   GET    /api/rooms             在线房间列表
 *
 * 成员超过 MEMBER_TTL 没心跳视为掉线；房间没有成员即消失。
 * 只在内存里，重启后清空（房间本来就是临时的）。多实例部署时请改成 Redis。
 */
export const roomsRouter = Router()

const MEMBER_TTL = 30_000
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
    players: members.length,
    playerIndexes: members.map((m) => m.playerIndex),
    members: members.map((m) => ({ nickname: m.nickname, playerIndex: m.playerIndex, host: Boolean(m.host) })),
  }
}

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

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

roomsRouter.post('/heartbeat', optionalUser, (req, res) => {
  const roomId = str(req.body.roomId, 200)
  const gameSlug = str(req.body.gameSlug)
  const memberId = str(req.body.memberId, 64)
  if (!roomId || !gameSlug || !memberId) return res.status(400).json({ error: 'roomId, gameSlug, memberId required' })

  const playerIndex = Math.max(0, Math.min(3, Number(req.body.playerIndex) || 0))
  const nickname = str(req.body.nickname, 32) || (req.user?.nickname ?? 'Guest')
  const now = Date.now()

  let room = rooms.get(roomId)
  if (!room) {
    room = { roomId, gameSlug, createdAt: now, members: new Map() }
    rooms.set(roomId, room)
  }
  const existing = room.members.get(memberId)
  // 第一个进来的就是 host；后来者即使自称 host 也不算
  const host = existing ? existing.host : room.members.size === 0 || Boolean(req.body.host && ![...room.members.values()].some((m) => m.host))
  room.members.set(memberId, { memberId, nickname, playerIndex, host, userId: req.user?.id ?? null, seenAt: now })
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
