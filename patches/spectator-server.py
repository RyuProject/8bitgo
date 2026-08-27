#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 P2P 房间加「观众」角色（直播第一步）。就地改 server/src/netplay.js，幂等。

    python3 patches/spectator-server.py [项目路径]

为什么需要角色：
  房主那一侧本来就是「captureStream 抓画面 → WebRTC 推给每个加入的人」——
  这已经是一套推流系统了。要变成直播，只差把「加入的人」分成两类：
    player    占手柄位、能操作（上限仍是 4，这是模拟器的手柄数）
    spectator 只看不操作（另算上限，因为不占手柄位）

  满员时不再把人拒之门外，而是自动转成观众 —— 对「想看别人玩」的场景更自然。
"""
import sys, os

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
P = os.path.join(ROOT, 'server/src/netplay.js')

s = open(P, encoding='utf-8').read()
orig = s


def edit(old, new, why='', done=None):
    """逐条幂等。

    done 给「这条已经不用打了」另留一个判断依据：有些地方后来被人改写过
    （比如房主迁移的候选名单被重构成了 buildCandidates），锚点和结果都对不上，
    但要做的事早就做了 —— 这种就用 done 认出来跳过，而不是报错。
    """
    global s
    if (done or new) in s:
        return
    assert old in s, f'找不到锚点（{why}）：{old[:70]!r}'
    s = s.replace(old, new, 1)


# 1. 常量
edit(
    "const MAX_PLAYERS = 4",
    """const MAX_PLAYERS = 4
/**
 * 观众上限。观众不占手柄位，但每人仍是房主那边的一条 WebRTC 上行流 ——
 * 家宽上行大约撑到十来路，所以这里给的是个保守值。
 * 真要做几十上百人的直播，得在中间加 SFU（房主只推一路，服务器转发 N 路）。
 */
const MAX_SPECTATORS = Number(process.env.NETPLAY_MAX_SPECTATORS || 12)""",
    '常量',
)

# 2. 计数辅助
edit(
    "function usersPayload(room) {",
    """/** 房间里的玩家数（占手柄位的那些）。没标角色的一律算玩家，兼容老客户端 */
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

function usersPayload(room) {""",
    '计数辅助',
    done='function playerCount(room) {',
)

# 3. detailedRoom 暴露两个数字
edit(
    """    players: room.users.size,
    max: room.maxPlayers,
    hasPassword: Boolean(room.password),
    members: users.map((u) => ({ nickname: u.player_name || 'Player', host: u.userid === room.ownerUserId })),""",
    """    players: playerCount(room),
    max: room.maxPlayers,
    // 观众：只看不操作。房间列表 / 直播列表用它显示「N 人在看」
    spectators: spectatorCount(room),
    maxSpectators: MAX_SPECTATORS,
    hasPassword: Boolean(room.password),
    members: users.map((u) => ({
      nickname: u.player_name || 'Player',
      host: u.userid === room.ownerUserId,
      role: u.role === 'spectator' ? 'spectator' : 'player',
    })),""",
    'detailedRoom',
)

# 4. join-room：满员转观众，而不是拒绝
edit(
    """      if (room.users.size >= room.maxPlayers) return ack?.('room is full')
      if (socketRoom.has(socket.id)) return ack?.('already in a room')
      // 正在换房主的房间先别放人进来，不然新来的会连到一个马上要消失的房主
      if (room.awaitingHost) return ack?.('room is changing host')

      room.users.set(userid, { ...extra, socketId: socket.id })""",
    """      if (socketRoom.has(socket.id)) return ack?.('already in a room')
      // 正在换房主的房间先别放人进来，不然新来的会连到一个马上要消失的房主
      if (room.awaitingHost) return ack?.('room is changing host')

      // 手柄位满了不再把人拒之门外，改成让他当观众（只看不操作）。
      // 客户端也可以事后调 /role 主动把自己降成观众。
      const asSpectator = playerCount(room) >= room.maxPlayers
      if (asSpectator && spectatorCount(room) >= MAX_SPECTATORS) return ack?.('room is full')

      room.users.set(userid, { ...extra, socketId: socket.id, role: asSpectator ? 'spectator' : 'player' })""",
    'join-room 满员转观众',
)

# 5. 换房主优先选玩家；没有玩家了再从观众里挑
edit(
    """  // 按加入顺序选：Map 保留插入顺序，最早进来的那位接手
  room.nextHostUserId = remaining[0].userid""",
    """  // 按加入顺序选，但优先玩家：观众是主动选择「只看」的，让他接手不合适。
  // 实在只剩观众了才从观众里挑（总比这局直接散掉强）。
  const players = remaining.filter((u) => u.role !== 'spectator')
  room.nextHostUserId = (players[0] ?? remaining[0]).userid""",
    '换房主优先玩家',
    done="filter((u) => u.role !== 'spectator')",
)

# 6. /netplay/list 的 current 要用玩家数（EmulatorJS 自己的菜单靠它判断满没满）
edit(
    """function publicRoom(room) {
  return {
    room_name: room.roomName,
    current: room.users.size,""",
    """function publicRoom(room) {
  return {
    // 这是 EmulatorJS 自带菜单读的结构，current 必须是「占手柄位的人数」，
    // 否则观众一多它就以为房间满了、不让人加入
    room_name: room.roomName,
    current: playerCount(room),""",
    'publicRoom',
)

# 7. 改角色的接口（用他们已有的 token 鉴权，保持一致）
edit(
    "  app.post('/api/netplay/rooms/:roomId/migrate', express.json(), (req, res) => {",
    """  /**
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

  app.post('/api/netplay/rooms/:roomId/migrate', express.json(), (req, res) => {""",
    'role 接口',
)

# 8. 房主自己也要标成 player。
#    不标的话 users-updated 里房主的 role 是 undefined，前端判断「谁是观众」时要多写一层兜底。
edit(
    "      room.users.set(userid, { ...extra, socketId: socket.id })",
    "      room.users.set(userid, { ...extra, socketId: socket.id, role: 'player' })",
    '房主标成 player',
)

# 9. EmulatorJS 自带的房间列表：判断满员要看手柄位，不能看总人数。
#    否则「1 个玩家 + 2 个观众」的双人房会被当成满员藏起来，后来的人连玩都玩不了。
edit(
    "      if (room.users.size >= room.maxPlayers) continue",
    "      if (playerCount(room) >= room.maxPlayers) continue",
    '列表按手柄位判断满员',
)

# 10. users-updated 的顺序：玩家在前、观众在后。
#     EmulatorJS 的 getUserIndex() 拿 Object.keys(players).indexOf(自己) 当手柄号，
#     房间人数一旦超过 maxPlayers（观众进来了），后来上场的人就会拿到不存在的手柄位。
edit(
    """function usersPayload(room) {
  const out = {}
  for (const [userid, u] of room.users) {
    const { token: _t, ...rest } = u
    out[userid] = rest
  }
  return out
}""",
    """/**
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
  const strip = (u) => {
    const { token: _t, ...rest } = u
    return rest
  }
  for (const [userid, u] of room.users) if (u.role !== 'spectator') out[userid] = strip(u)
  for (const [userid, u] of room.users) if (u.role === 'spectator') out[userid] = strip(u)
  return out
}""",
    'usersPayload 顺序',
    done="if (u.role !== 'spectator') out[userid] = strip(u)",
)

if s == orig:
    print('已经打过了，跳过')
else:
    open(P, 'w', encoding='utf-8').write(s)
    print(f'✅ 已给 {os.path.relpath(P, ROOT)} 加上观众角色（{len(s) - len(orig):+d} 字符）')
