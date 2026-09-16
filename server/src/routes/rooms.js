import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { verifyToken } from '../auth.js'
import { queryOne } from '../db.js'
import { presenceFromRequest, UNKNOWN_PRESENCE } from '../presence.js'
import { resolveGameRoomPolicy } from '../netplay-game-policy.js'
import { NETPLAY_MAX_PLAYERS, normalizeGamePlayers } from '../../../shared/netplay-players.js'

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
 * 房间人数必须查 games.players：这会让开房依赖数据库，但能避免客户端伪造四人房绕过后台。
 */
const MEMBER_TTL = 30_000
/** 房间数上限。心跳是公开接口，roomId 客户端随便填 —— 不设上限的话一个循环就能把内存刷爆 */
const MAX_ROOMS = Number(process.env.ROOMS_MAX || 1000)

/**
 * 成员令牌。
 *
 * memberId 是客户端自己生成的，而 roomId 在 GET /api/rooms 上是公开的 ——
 * 没有令牌的话：
 *   · 谁都能拿别人的 memberId 调 DELETE 把人从列表里删掉（房间只剩 0 人还会整个消失）；
 *   · 谁都能用别人的 memberId 心跳，把他的昵称、手柄位、host 标记改成任意值。
 * 所以第一次心跳时发一张令牌**只回给他本人**，之后认令牌不认 memberId。
 *
 * 和 netplay 的房间令牌是同一套做法（server/src/netplay.js 的 issueToken），
 * 令牌同样从头到尾不进任何列表接口的返回值。
 */
const newToken = () => randomBytes(24).toString('base64url')
/** 令牌可以走请求头，也可以放在 body 里 —— 前端的 api 助手不支持自定义头 */
const tokenOf = (req) => str(req.get('x-room-token'), 64) || str(req.body?.token, 64)
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
    max: room.maxPlayers,
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

export function createRoomsRouter({ resolveGamePolicy = resolveGameRoomPolicy } = {}) {
  const router = Router()

  router.get('/', (_req, res) => {
    prune()
    const list = [...rooms.values()].map(publicRoom).sort((a, b) => b.createdAt - a.createdAt)
    res.json(list)
  })

  router.get('/:roomId', (req, res) => {
    prune()
    const room = rooms.get(req.params.roomId)
    if (!room) return res.status(404).json({ error: 'room not found' })
    res.json(publicRoom(room))
  })

  router.post('/heartbeat', softUser, async (req, res) => {
    const roomId = str(req.body.roomId, 200)
    const gameSlug = str(req.body.gameSlug)
    const memberId = str(req.body.memberId, 64)
    if (!roomId || !gameSlug || !memberId) return res.status(400).json({ error: 'roomId, gameSlug, memberId required' })

    const playerIndex = Number(req.body.playerIndex)
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= NETPLAY_MAX_PLAYERS) {
      return res.status(400).json({ error: 'invalid player index' })
    }
    const nickname = str(req.body.nickname, 32) || (req.user?.nickname ?? 'Guest')
    const now = Date.now()

    let gamePolicy
    try {
      // 每次心跳都重新核对，后台把 4 人调成 2 人后不用等房间重建才生效。
      gamePolicy = await resolveGamePolicy({ gameSlug })
    } catch (error) {
      console.error('[rooms] 读取游戏最大玩家数失败：', error)
      return res.status(503).json({ error: 'game lookup failed' })
    }
    const authoritativeMax = normalizeGamePlayers(gamePolicy?.maxPlayers)
    if (!gamePolicy || authoritativeMax < 2) return res.status(409).json({ error: 'game does not support multiplayer' })
    if (playerIndex >= authoritativeMax) return res.status(409).json({ error: 'player slot is disabled' })

    let room = rooms.get(roomId)
    if (!room) {
      if (rooms.size >= MAX_ROOMS) {
        prune(now)
        if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'too many rooms' })
      }
      // resolveGamePolicy 上面有 await；回来后要重取一次，防止两次并发心跳各建一间同名房。
      room = rooms.get(roomId)
    }
    if (!room) {
      room = { roomId, gameSlug: gamePolicy.gameSlug || gameSlug, maxPlayers: authoritativeMax, createdAt: now, members: new Map() }
      rooms.set(roomId, room)
    }
    if (room.gameSlug !== gameSlug) return res.status(409).json({ error: 'room belongs to another game' })
    room.maxPlayers = authoritativeMax
    const existing = room.members.get(memberId)

    /**
     * 认令牌不认 memberId：第一次心跳发一张，之后每次都要带对。
     * 不这么做的话，任何人拿到别人的 memberId 就能把他的昵称 / 手柄位 / host 标记改掉。
     */
    if (existing && existing.token !== tokenOf(req)) {
      return res.status(403).json({ error: 'not your member id' })
    }
    if (!existing && room.members.size >= room.maxPlayers) {
      return res.status(409).json({ error: 'room is full' })
    }
    const occupied = [...room.members.values()].some((member) => member.memberId !== memberId && member.playerIndex === playerIndex)
    if (occupied) return res.status(409).json({ error: 'player slot is occupied' })

    /**
     * host 只认「开这个房间的那个人」。
     *
     * 以前还有一条 `req.body.host && 当前没人是 host` 的自荐路径 —— 房主的心跳晚了一拍
     * （TTL 30 秒，网络抖一下就够）就会被别人顶掉 host 的显示。房主记录真的过期了也不用抢：
     * publicRoom 里的 `?? members[0]` 会按 playerIndex 兜底，不需要给一个能被利用的入口。
     */
    const host = existing ? existing.host : room.members.size === 0
    const token = existing ? existing.token : newToken()
    /**
     * 名片每次心跳重算一遍，网络那一格才跟得上变化。
     *
     * 云端房间和另外两种不一样：它没有一条常驻的 socket，服务端量不到往返延迟，
     * 只能收下浏览器自己测的那个数（客户端拿上一次心跳请求的耗时，见 services/rooms.ts）。
     * 这一项因此是「客户端说了算」的，presenceFromRequest 里会钳范围；
     * 设备和国家仍然是服务端从 UA 和 IP 自己看的，报不了假。
     */
    const presence = presenceFromRequest(req, req.body.rtt)
    room.members.set(memberId, { memberId, nickname, playerIndex, host, token, userId: req.user?.id ?? null, seenAt: now, presence })
    // 令牌只回给他本人。publicRoom 不带 token，列表接口也就不会把它漏出去
    res.json({ ...publicRoom(room), memberToken: token })
  })

  /**
   * 离开房间。要带自己的成员令牌 —— 这个接口原来完全没有鉴权，
   * 知道 roomId 和某人的 memberId 就能把他从列表里删掉，删到最后一个人房间整个消失。
   */
  router.delete('/:roomId/members/:memberId', (req, res) => {
    const room = rooms.get(req.params.roomId)
    if (!room) return res.json({ ok: true }) // 已经没了就当成功，重复调用不该报错
    const member = room.members.get(req.params.memberId)
    if (!member) return res.json({ ok: true })
    if (member.token !== tokenOf(req)) return res.status(403).json({ error: 'not your member id' })
    room.members.delete(req.params.memberId)
    if (room.members.size === 0) rooms.delete(room.roomId)
    res.json({ ok: true })
  })

  return router
}

export const roomsRouter = createRoomsRouter()
