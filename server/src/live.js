import { randomBytes } from 'node:crypto'
import { watchPresence, clientIpFrom, UNKNOWN_PRESENCE } from './presence.js'

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
 *   go-live      {gameSlug, gameName, title, platform}  + ack(err, {roomId, token})
 *   resume-live  {roomId, token}                        + ack(err, {roomId, viewers: [id]})
 *                主播断线重连后接回原来的房间（见下面「主播掉线」）
 *   watch        {roomId}                               + ack(err, {hostId, hostAway, ...})
 *                同一个观众对同一个房间再发一次 = 「请主播重新给我发 offer」
 *   signal       {target, data}   → 转发给 target，附上 from
 *                观众发的一律转给**当前**主播，target 只是摆设（主播重连后 id 会变）
 *   stop-live                                           主播主动下播
 *   ← viewer-joined  {viewerId}      发给主播，让它建一条新的 PeerConnection
 *   ← viewer-left    {viewerId}
 *   ← viewers        {count}         主播和观众都收
 *   ← host-away                      发给观众：主播断线了，房间先留着
 *   ← host-back      {hostId}        发给观众：主播回来了，socket id 换了
 *   ← live-ended     {reason}        发给观众
 *
 * ── 主播掉线 ──────────────────────────────────────────────
 * 以前是「主播 socket 一断房间立刻散」。结果切个 WiFi、地铁过个隧道，观看链接就死了，
 * 而 WebRTC 画面本身其实还在点对点地流。所以**有观众的时候**断线后房间保留
 * RESUME_GRACE_MS，主播拿着开播时发的 token 发 resume-live 就能接回来 ——
 * 观众不用换链接。
 *
 * 但**席位是空的时候不留**：宽限期保护的是观众手里那条链接，没有观众就没有要保护的东西，
 * 留下的只是大厅里一张挂着「主播不在」的卡片 —— 玩家关掉页面之后它还要在那儿杵一分钟，
 * 谁点进去都看不到画面。同理，主播不在期间最后一个观众也走了，房间立刻散。
 *
 * 允许**接管**：重连的新 socket 到达时，旧 socket 往往还没到 ping 超时、在服务器眼里
 * 仍然「在线」。token 对得上就把房间交给新 socket，旧的那份 membership 直接作废。
 */

/** 同时在播的房间上限：信令是公开接口，不设上限开播就能刷爆内存 */
const MAX_ROOMS = Number(process.env.LIVE_MAX_ROOMS || 200)
/** 单个 IP 同时能开的房间数。MAX_ROOMS 只防内存，防不了一个人开满整站 */
const MAX_ROOMS_PER_IP = Number(process.env.LIVE_MAX_ROOMS_PER_IP || 3)
/** 单场直播的观众上限，见上面关于上行带宽的说明 */
const MAX_VIEWERS = Number(process.env.LIVE_MAX_VIEWERS || 12)
/**
 * 主播断线后房间保留多久。socket.io 判掉线本身要 pingInterval + pingTimeout（约 30 秒），
 * 这个数是在那之后再等的。太长会让大厅挂着一堆「主播不在」的房间，太短又护不住一次 4G 切换。
 */
const RESUME_GRACE_MS = Number(process.env.LIVE_RESUME_GRACE_MS || 60_000)

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
    /** 主播断线、房间在宽限期里等它回来 */
    hostAway: room.hostSocketId === null,
    /**
     * 配对的联机房号（主播点了「联机」之后自己报上来的）。
     *
     * 有它意味着「这个直播间同时也是一个联机房」：直播照推、观众一帧不掉，
     * 大厅那边把这两张卡**合成一张**（见 src/services/allRooms.ts），
     * 手柄位还空着就挂个 👋，谁都能点进去坐下一起玩。
     *
     * 为什么要过服务端：主播自己的浏览器当然知道两个房号，但**别人的大厅不知道** ——
     * 靠昵称 + 游戏名去猜配对太脆，一个人开两台机器就串了。
     */
    netplayRoomId: room.netplayRoomId ?? null,
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

function hostIp(socket) {
  try {
    return clientIpFrom(socket?.handshake?.address, socket?.handshake?.headers || {})
  } catch {
    return ''
  }
}

/** 广播人数给房间里所有人（主播 + 观众） */
function notifyViewers(nsp, room) {
  nsp.to(room.id).emit('viewers', { roomId: room.id, count: room.viewers.size })
}

function closeRoom(nsp, room, reason) {
  if (room.awayTimer) clearTimeout(room.awayTimer)
  room.awayTimer = null
  nsp.to(room.id).emit('live-ended', { roomId: room.id, reason })
  for (const viewerId of room.viewers) membership.delete(viewerId)
  if (room.hostSocketId) membership.delete(room.hostSocketId)
  rooms.delete(room.id)
}

/** 主播的 socket 没了：房间先留着等它回来，到点没回来再散 */
function hostAway(nsp, room) {
  room.hostSocketId = null
  /**
   * 配对的联机房跟着作废。
   * EmulatorJS 的 netplay 在 socket disconnect 里直接 leaveRoom()，主播这边一断，
   * 那个联机房要么已经散了、要么正在换房主 —— 留着房号只会让大厅挂一个
   * 点进去进不去的「联机中」。主播接回来会重新报一次。
   */
  const hadNetplay = room.netplayRoomId !== null && room.netplayRoomId !== undefined
  room.netplayRoomId = null
  /**
   * ⚠️ 光在服务端清掉不够，**得把观众手里那个入口一起收回来**。
   * 不通知的话，正在看的人那个「加入联机」按钮还亮着 —— 点下去是离开一场
   * 还活着的直播（宽限期内主播随时可能回来），去连一个已经不存在的房间：
   * 直播没了，联机也没进去，两头空。
   */
  if (hadNetplay) nsp.to(room.id).emit('netplay-linked', { roomId: null })
  room.awaySince = Date.now()
  if (room.awayTimer) clearTimeout(room.awayTimer)
  room.awayTimer = setTimeout(() => {
    // 期间可能已经被接回去又再断开，或者被 stop-live 关掉 —— 只有还是「不在」才散场
    const cur = rooms.get(room.id)
    if (cur && cur.hostSocketId === null) closeRoom(nsp, cur, 'host-left')
  }, RESUME_GRACE_MS)
  nsp.to(room.id).emit('host-away', { roomId: room.id })
}

/** 把房间交给一个（新的）主播 socket */
function bindHost(nsp, room, socket) {
  if (room.awayTimer) clearTimeout(room.awayTimer)
  room.awayTimer = null
  room.awaySince = null
  room.hostSocketId = socket.id
  room.hostIp = hostIp(socket)
  // RTT 追踪是绑在具体 socket 上的，换了 socket 就得重新挂
  room.presence = watchPresence(socket)
  membership.set(socket.id, { roomId: room.id, role: 'host' })
  socket.join(room.id)
}

function leave(nsp, socket) {
  const info = membership.get(socket.id)
  if (!info) return
  membership.delete(socket.id)
  const room = rooms.get(info.roomId)
  if (!room) return

  if (info.role === 'host') {
    // 已经被另一个 socket 接管（旧连接迟到的 disconnect）：什么都不用做
    if (room.hostSocketId !== socket.id) return
    /**
     * 没人在看 -> 直接散场，不走宽限期。
     *
     * 宽限期保护的是**观众手里的那条链接**：画面走 WebRTC 点对点，主播的信令抖一下
     * 观众其实还在看，这时候散场纯属自伤。但一个人在玩、席位空着的时候这条理由不存在 ——
     * 玩家一关页面，大厅里就多一张「主播不在」的卡片杵满一分钟，点进去什么也没有。
     */
    if (room.viewers.size === 0) {
      closeRoom(nsp, room, 'host-left')
      return
    }
    // 有人在看：画面来自主播的浏览器，没人能接手 —— 但它自己很可能马上就回来，先等等
    hostAway(nsp, room)
    return
  }
  room.viewers.delete(socket.id)
  // 告诉主播可以把这条 PeerConnection 拆了，别留着占上行
  if (room.hostSocketId) {
    nsp.to(room.hostSocketId).emit('viewer-left', { viewerId: socket.id })
  } else if (room.viewers.size === 0) {
    // 主播不在、最后一个观众也走了：这房间已经没有任何人需要它，别再占着宽限期
    closeRoom(nsp, room, 'host-left')
    return
  }
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
      const ip = hostIp(socket)
      if (ip && MAX_ROOMS_PER_IP > 0) {
        let mine = 0
        for (const r of rooms.values()) if (r.hostIp === ip) mine++
        if (mine >= MAX_ROOMS_PER_IP) return ack?.('too many rooms')
      }

      const id = randomBytes(9).toString('base64url')
      const room = {
        id,
        // 续播凭证：主播断线重连后凭它 resume-live。观众看不到（publicRoom 不带它）
        token: randomBytes(24).toString('base64url'),
        title: str(payload?.title, 80) || str(payload?.gameName, 80) || 'Live',
        gameSlug: str(payload?.gameSlug, 120),
        gameName: str(payload?.gameName, 120),
        platform: str(payload?.platform, 40),
        hostName: str(payload?.hostName, 40),
        startedAt: Date.now(),
        viewers: new Set(),
        awayTimer: null,
        awaySince: null,
        // hostSocketId / hostIp / presence 由 bindHost 填：主播重连时也走它，只写一处
        hostSocketId: null,
        hostIp: '',
        /**
         * 主播的名片。设备和国家在绑定那一刻就定死了，RTT 由 socket.io 的心跳
         * 持续刷新，所以存的是个取快照的函数而不是一份数据。
         */
        presence: null,
      }
      rooms.set(id, room)
      bindHost(nsp, room, socket)
      ack?.(null, { roomId: id, token: room.token })
    })

    socket.on('resume-live', (payload, ack) => {
      if (membership.has(socket.id)) return ack?.('already in a room')
      const room = rooms.get(str(payload?.roomId, 64))
      if (!room) return ack?.('not found')
      const token = str(payload?.token, 64)
      if (!token || token !== room.token) return ack?.('forbidden')

      // 接管：旧 socket 还挂着（没到 ping 超时）的话，把它从房间里请出去
      const old = room.hostSocketId
      if (old && old !== socket.id) {
        membership.delete(old)
        nsp.sockets.get(old)?.leave(room.id)
      }
      bindHost(nsp, room, socket)
      // 观众要知道主播的新 id（它们的 signal 其实由服务端路由，但 from 过滤用得上）
      socket.to(room.id).emit('host-back', { roomId: room.id, hostId: socket.id })
      // 把当前观众名单交给主播：哪条 PeerConnection 还活着它自己知道，死了的重新 offer
      ack?.(null, { roomId: room.id, viewers: Array.from(room.viewers) })
    })

    socket.on('watch', (payload, ack) => {
      const room = rooms.get(str(payload?.roomId, 64))
      if (!room) return ack?.('not found')
      const info = membership.get(socket.id)
      const again = info?.role === 'viewer' && info.roomId === room.id
      if (info && !again) return ack?.('already in a room')
      if (!again && room.viewers.size >= MAX_VIEWERS) return ack?.('full')

      if (!again) {
        room.viewers.add(socket.id)
        membership.set(socket.id, { roomId: room.id, role: 'viewer' })
        socket.join(room.id)
      }
      ack?.(null, { ...publicRoom(room), hostId: room.hostSocketId })
      // 由主播发起 offer：它才知道自己有几条轨、什么编码。
      // 主播不在就先不发，它 resume 回来时会拿到观众名单自己补
      if (room.hostSocketId) nsp.to(room.hostSocketId).emit('viewer-joined', { viewerId: socket.id })
      if (!again) notifyViewers(nsp, room)
    })

    /**
     * 转发握手包。只在同一个房间内、且只在「主播 ↔ 观众」之间转 ——
     * 不加这层校验的话，任何人都能拿别人的 socketId 往里塞 SDP。
     * 观众发的一律送给当前主播：主播重连后 id 变了，观众手里的旧 id 不算数。
     */
    socket.on('signal', (payload) => {
      const info = membership.get(socket.id)
      if (!info) return
      const room = rooms.get(info.roomId)
      if (!room) return
      let target
      if (info.role === 'host') {
        target = str(payload?.target, 64)
        if (!target || !room.viewers.has(target)) return
      } else {
        target = room.hostSocketId
        if (!target) return
      }
      nsp.to(target).emit('signal', { from: socket.id, data: payload?.data })
    })

    /**
     * 主播报告：这一局同时开了个联机房（或者刚把它关了）。
     *
     * 只有房主能报，而且只能报自己那间 —— 不然任何观众都能把别人的直播间
     * 标成「联机中」，把人骗进一个不存在的房间。
     * 传空 / null 就是解绑（结束联机、回到一个人玩）。
     */
    socket.on('link-netplay', (payload) => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return
      const room = rooms.get(info.roomId)
      if (!room || room.hostSocketId !== socket.id) return
      const next = str(payload?.roomId, 64) || null
      // 大厅是轮询 /api/live/rooms 的（不像 netplay 那边有 SSE），改完等下一轮就看得到
      room.netplayRoomId = next
      /**
       * 但**正在看的人不能等**：他们已经在房间里了，不会再去刷大厅。
       * 主播一点「联机」，观众那边就该立刻多出一个「加入联机」的入口 ——
       * 这正是「看着看着就能上场」这件事成立的前提。
       * 后进来的观众不用管，watch 的 ack 里带着 publicRoom，本来就有这个字段。
       */
      nsp.to(room.id).emit('netplay-linked', { roomId: next })
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
