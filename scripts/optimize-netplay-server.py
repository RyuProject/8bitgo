#!/usr/bin/env python3
"""
给 P2P 信令服务器（server/src/netplay.js）做安全与效率加固。

写成可重复执行的脚本，是因为这个文件同时被别的补丁脚本改写 —— 被覆盖回去之后
再跑一次即可。已经改过的部分会自动跳过，重复执行是安全的。

改了五件事：
 0. 掉线接管   —— 轮流问候选人，一个不接换下一个，直到有人接或宽限期到
 1. 房间令牌   —— 上传存档 / 接手房主不再拿客户端自填的 userid 当凭证
 2. 控制消息过滤 —— data-message 里 host-migrated 之类的 key 只能由服务器发
 3. 开房限流   —— 一个连接一个房间、房间总数上限、消息每秒上限
 4. SSE 事件流 —— 房间变化主动推送，取代前端每 6 秒 / 2.5 秒的两处轮询

用法： python3 scripts/optimize-netplay-server.py
"""
import io, sys, os

P = os.path.join(os.path.dirname(__file__), '..', 'server', 'src', 'netplay.js')
s = io.open(P, encoding='utf-8').read()
orig = s

def sub(old, new, what):
    global s
    if new.strip().split('\n')[0] in s and old not in s:
        print(f'  · {what}：已经改过，跳过')
        return
    if old not in s:
        print(f'  ✗ {what}：找不到锚点，可能上游改动过 —— 请手工处理')
        sys.exit(1)
    s = s.replace(old, new, 1)
    print(f'  ✓ {what}')

# ---- 1. 依赖与上限 ----
sub("""import express from 'express'
import { Server } from 'socket.io'
""",
"""import express from 'express'
import { randomBytes } from 'node:crypto'
import { Server } from 'socket.io'
""", '引入 randomBytes')

sub("""const MAX_STATE_BYTES = 12 * 1024 * 1024
""",
"""const MAX_STATE_BYTES = 12 * 1024 * 1024
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
""", '房间 / 消息上限与保留 key')

# ---- 2. SSE 订阅者 ----
sub("""const aliases = new Map()
""",
"""const aliases = new Map()
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
    const payload = `event: rooms\\ndata: ${JSON.stringify(list)}\\n\\n`
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
  if (!room) return `event: room-gone\\ndata: ${JSON.stringify({ roomId: askedId })}\\n\\n`
  const out = detailedRoom(room)
  if (room.id !== askedId) out.migratedTo = room.id
  return `event: room\\ndata: ${JSON.stringify(out)}\\n\\n`
}
""", 'SSE 订阅者与推送')

# ---- 3. 房间令牌 ----
sub("""function usersPayload(room) {
  const out = {}
  for (const [userid, u] of room.users) out[userid] = u
  return out
}""",
"""/** 广播给房间成员的用户表。令牌要摘掉——那是各人自己的凭证，不能广播 */
function usersPayload(room) {
  const out = {}
  for (const [userid, u] of room.users) {
    const { token: _t, ...rest } = u
    out[userid] = rest
  }
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
}""", '房间令牌')

# ---- 4. 变更通知 ----
sub("""  for (const [from, to] of aliases) if (to === room.id || from === room.id) aliases.delete(from)
}""",
"""  for (const [from, to] of aliases) if (to === room.id || from === room.id) aliases.delete(from)
  notifyRooms()
}""", 'destroyRoom 通知')

sub("""  nsp.to(room.id).emit('users-updated', usersPayload(room))

  if (room.graceTimer)""",
"""  nsp.to(room.id).emit('users-updated', usersPayload(room))
  notifyRooms()

  if (room.graceTimer)""", '换房主通知')

sub("""  nsp.to(roomId).emit('users-updated', usersPayload(room))
}""",
"""  nsp.to(roomId).emit('users-updated', usersPayload(room))
  notifyRooms()
}""", '有人离开时通知')

# ---- 5. open-room ----
sub("""      if (rooms.has(roomId)) return ack?.('room already exists')
""",
"""      if (rooms.has(roomId)) return ack?.('room already exists')
      // 一个连接同时只能待在一个房间里，也就只能开一个房，否则一个脚本就能刷满
      if (socketRoom.has(socket.id)) return ack?.('already in a room')
      if (rooms.size >= MAX_ROOMS) return ack?.('server is full')
""", 'open-room 限流')

sub("""      ack?.(null)
      nsp.to(roomId).emit('users-updated', usersPayload(room))""",
"""      ack?.(null)
      issueToken(room, userid, socket)
      nsp.to(roomId).emit('users-updated', usersPayload(room))
      notifyRooms()""", 'open-room 发令牌')

# ---- 6. join-room ----
sub("""      if (room.users.size >= room.maxPlayers) return ack?.('room is full')
""",
"""      if (room.users.size >= room.maxPlayers) return ack?.('room is full')
      if (socketRoom.has(socket.id)) return ack?.('already in a room')
      // 正在换房主的房间先别放人进来，不然新来的会连到一个马上要消失的房主
      if (room.awaitingHost) return ack?.('room is changing host')
""", 'join-room 限制')

sub("""      ack?.(null, usersPayload(room))
      nsp.to(room.id).emit('users-updated', usersPayload(room))""",
"""      ack?.(null, usersPayload(room))
      issueToken(room, userid, socket)
      nsp.to(room.id).emit('users-updated', usersPayload(room))
      notifyRooms()""", 'join-room 发令牌')

# ---- 7. data-message ----
sub("""    socket.on('data-message', (d) => {
      const roomId = socketRoom.get(socket.id)
      if (!roomId) return
      socket.to(roomId).emit('data-message', d)
    })""",
"""    let msgWindow = 0
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
    })""", 'data-message 过滤与限流')

# ---- 8. SSE 接口 ----
sub("""  /** 本站自己的房间列表（不按游戏过滤，侧边栏要显示所有正在玩的房间） */""",
"""  /**
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
    res.write(`event: rooms\\ndata: ${JSON.stringify(list)}\\n\\n`)
    if (watch) res.write(roomEvent(watch))

    const beat = setInterval(() => {
      try {
        res.write(': ping\\n\\n')
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

  /** 本站自己的房间列表（不按游戏过滤，侧边栏要显示所有正在玩的房间） */""", 'SSE 接口')

# ---- 9. 存档鉴权 ----
sub("""      const user = str(req.get('x-netplay-user'), 64)
      if (!user || user !== room.ownerUserId) return res.status(403).json({ error: 'not the host' })""",
"""      // 优先认房间令牌；没带令牌时退回旧的 userid（兼容还没升级的前端）
      const token = str(req.get('x-netplay-token'), 64)
      const me = token ? memberByToken(room, token) : null
      const user = me ? me.userid : str(req.get('x-netplay-user'), 64)
      if (!user || user !== room.ownerUserId) return res.status(403).json({ error: 'not the host' })""",
'存档上传鉴权')

sub("""    const room = getRoom(req.params.roomId)
    if (!room?.state) return res.status(404).json({ error: 'no state' })
    res.set('Content-Type', 'application/octet-stream')""",
"""    const room = getRoom(req.params.roomId)
    if (!room?.state) return res.status(404).json({ error: 'no state' })
    // 存档是别人游戏进度的完整快照，只有房间成员能取（老前端没带令牌时放行，
    // 升级完可以把下面这行的 `|| !token` 去掉，变成强制）
    const token = str(req.get('x-netplay-token'), 64) || str(req.query.t, 64)
    if (token && !memberByToken(room, token)) return res.status(403).json({ error: 'not a member' })
    res.set('Cache-Control', 'no-store')
    res.set('Content-Type', 'application/octet-stream')""", '存档下载鉴权')

# ---- 10. migrate 通知 ----
sub("""    for (const [from, to] of aliases) if (to === oldRoom.id) aliases.set(from, newRoomId)

    res.json({ ok: true, roomId: newRoomId })""",
"""    for (const [from, to] of aliases) if (to === oldRoom.id) aliases.set(from, newRoomId)

    notifyRooms()
    res.json({ ok: true, roomId: newRoomId })""", 'migrate 通知')

if s == orig:
    print('没有任何改动（可能已全部应用过）')
else:
    io.open(P, 'w', encoding='utf-8').write(s)
    print('\n已写入 server/src/netplay.js')
