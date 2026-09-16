import { randomBytes } from 'node:crypto'
import { watchPresence, clientIpFrom, isPrivateIp, UNKNOWN_PRESENCE } from './presence.js'
import { verifyToken, tokenVersionOf } from './auth.js'
import { queryOne } from './db.js'
import { isNetplayPlayer, resolveRoomId } from './netplay.js'
import { openConfig } from './open/config.js'
import { verifyLivePublisherToken } from './open/live-publisher.js'
import { dateOnly, dbFlag } from './mappers.js'
import { isAdultByBirthDate } from '../../shared/age.js'
import {
  CHAT_ACK_EMPTY,
  CHAT_ACK_FAILED,
  CHAT_ACK_NOT_FOUND,
  CHAT_ACK_NO_ROOM,
  CHAT_ACK_TOO_FAST,
  CHAT_BURST,
  CHAT_HISTORY_SIZE,
  CHAT_MIN_INTERVAL_MS,
  sanitizeChatText,
} from '../../shared/live-chat.js'

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
 *   外部设备主播握手 auth.publisherToken = `POST /api/open/v1/live/publish-token` 返回的专用票。
 *   网页端的普通游戏匿名「玩即播」不带这一格，继续兼容；成人游戏是例外，站内 JWT 也要验年龄。
 *   一旦带了 publisherToken，验不过绝不降级成匿名。
 *   go-live      {gameSlug, gameName, title, platform}  + ack(err, {roomId, token})
 *   resume-live  {roomId, token}                        + ack(err, {roomId, viewers: [id]})
 *                主播断线重连后接回原来的房间（见下面「主播掉线」）
 *   watch        {roomId, key?, reoffer?}                + ack(err, {hostId, hostAway, ...})
 *                同一个观众对同一个房间再发一次 = 「请主播重新给我发 offer」
 *                key 是观众自己生成的随机串，一次观看不变：信令重连后 socket.id 换了，
 *                凭它认出「还是刚才那个人」（见下面「观众换了 socket」）
 *                reoffer=true 表示观众的画面已经断了、明确要一轮新 offer
 *   signal       {target, data}   → 转发给 target，附上 from
 *                观众发的一律转给**当前**主播，target 只是摆设（主播重连后 id 会变）
 *   coop-state   {open, taken}                          主播报「这一局有没有 2P 位、有没有人坐着」
 *                只有主播能发。服务器不参与授权（那件事只可能在主播浏览器里守，
 *                见 src/emulator/coopSeat.ts），这一条纯粹是为了**让别人的大厅看得见**
 *   stop-live                                           主播主动下播
 *   chat         {text}                                 + ack(err, {id})
 *                弹幕。房主、观众和联机玩家都能发；房间号取自 membership，**不看 payload**，
 *                名字和「是不是房主」也一律由服务端判（见 chatIdentity）
 *   ← chat           {id, at, name?, guest?, host, text}   广播给房间里所有人（含发的人自己）
 *   ← viewer-joined  {viewerId, replaces?}  发给主播，让它建一条新的 PeerConnection
 *                      replaces = 这个人上一条连接用的 socket.id，那条可以直接拆
 *   ← viewer-rebound {from, to}      发给主播：同一个观众换了 socket.id，画面没断，
 *                                    把 PeerConnection 换个名字就行，**别重建**
 *   ← viewer-left    {viewerId}
 *   ← viewer-name    {viewerId, name?, guest?}  发给主播：这个观众叫什么。
 *                      **单独一条、异步发**，不并进 viewer-joined —— 名字要查库，
 *                      而 viewer-joined 是 offer 的发令枪，不能为一个显示用的字段等 I/O
 *   ← viewers        {count, list}   主播和观众都收。list = 观众名单，每项 {name?} / {guest?} / {}
 *                      ⚠️ **名单里没有 socket.id**：观众端只拿它显示，而 id 发给房间里
 *                      所有人等于把「谁是谁」的句柄散出去。名字还没解析完的占一个空位 {}。
 *                      ⚠️ 这意味着**每个观众的昵称对房间里所有人可见**（2026-09-11 站长拍板，
 *                      在此之前只有发过弹幕的人才露名）。
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
 *
 * ── 观众换了 socket ───────────────────────────────────────
 * 观众的信令抖一下重连，socket.io 会给它一个**新的** socket.id。以前服务端只认 id：
 * 新 id = 新观众 → 主播收到 viewer-joined 重建整条 PeerConnection（观众画面黑一下），
 * 旧 id 还挂在名单里直到 ping 超时 → 人数多算一个、满房时这个人会被自己的幽灵挤出去
 * （watch 回 full，观众端只能报错退出）。
 * 现在观众每次 watch 都带一个自己生成的 key：同一个 key 换了 socket，就把名单里的旧 id
 * 换成新的、发 viewer-rebound 让主播把那条还活着的 PeerConnection 换个名字，画面一帧不掉。
 * 观众明说画面断了（reoffer）时才走 viewer-joined 重建。
 */

/** 同时在播的房间上限：信令是公开接口，不设上限开播就能刷爆内存 */
const MAX_ROOMS = Number(process.env.LIVE_MAX_ROOMS || 200)
/**
 * 单个 IP 同时能开的房间数。MAX_ROOMS 只防内存，防不了一个人开满整站。
 *
 * ⚠️ 这个站是「玩就是播」——**每一个玩家都在开房**，所以这条闸拦的不只是刷子，
 * 还有所有共用一个出口 IP 的正常玩家：运营商级 NAT（手机网络几乎全是）、学校、公司。
 * 以前默认 3：同一个 NAT 后面第四个开始玩的人，自动开播会静默失败（只在控制台留一行）。
 * 现在放到 20；单个 IP 想刷满 200 间仍然做不到，想再收紧用环境变量。
 *
 * 内网 / 回环地址**不计数**：那不是访客的 IP，是反代没把 X-Forwarded-For 传进来
 * （deploy/live/README.md 里那行）。以前这种配置错误的后果是全站所有主播共用同一个额度 ——
 * **整个站同时只能开 3 间直播**，而且没有任何报错。配置错了该是名片上的国旗变 ❓，
 * 不该是直播开不出来；所以这里只在日志里提醒一次，放行。
 */
const MAX_ROOMS_PER_IP = Number(process.env.LIVE_MAX_ROOMS_PER_IP || 20)
let warnedPrivateIp = false
/** 单场直播的观众上限，见上面关于上行带宽的说明 */
const MAX_VIEWERS = Number(process.env.LIVE_MAX_VIEWERS || 12)
/**
 * 主播断线后房间保留多久。socket.io 判掉线本身要 pingInterval + pingTimeout（约 30 秒），
 * 这个数是在那之后再等的。太长会让大厅挂着一堆「主播不在」的房间，太短又护不住一次 4G 切换。
 */
const RESUME_GRACE_MS = Number(process.env.LIVE_RESUME_GRACE_MS || 60_000)
/**
 * 主播切到后台多久之后，这间房从大厅列表里**摘掉**（房还在，直链能进，进去会看到「主播切后台了」）。
 *
 * 2026-09-06 线上：一位匿名主播的房在大厅挂了一个半小时，画面一直不出（人早走了、标签页没关），
 * 谁点进去都是黑屏或者等 75 秒的超时。浏览器不给后台页出帧是改不了的，能做的是别把这种房
 * 摆在大厅里骗人进来。90 秒：切个标签页查个东西再回来的常见时长以内不动它。
 */
const FROZEN_HIDE_MS = Number(process.env.LIVE_FROZEN_HIDE_MS || 90_000)
/**
 * 主播切到后台、且**一个观众都没有**持续多久，直接收房（reason = host-idle）。
 * 有观众时不收：他们手里那条画面（哪怕冻着）是主播回来就能续上的。
 * 主播的 broadcast.ts 收到 live-ended 会进入休眠，回到前台自动重开一间。
 */
const FROZEN_CLOSE_MS = Number(process.env.LIVE_FROZEN_CLOSE_MS || 10 * 60_000)

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * 外部设备只在这个显式字段里放发布凭证。不能顺手复用 auth.token：那一格是站内 HS256
 * 登录令牌，混用会让两套原本隔离的信任边界重新粘在一起。
 */
function publisherTokenOf(socket) {
  return str(socket.handshake?.auth?.publisherToken, 8_192)
}

function publisherAuthError(message, code) {
  const error = new Error(message)
  error.data = { code }
  return error
}

/**
 * 成人直播沿用游戏播放器同一条年龄线：必须是有效注册账号、填过出生日期、且当前已满 18 岁。
 *
 * 这里同时给 HTTP 房间列表和 Socket.IO 进房使用，不能只在前端把按钮藏起来：直播房号和
 * 信令事件都能被脚本直接调用，前端遮罩不是权限边界。
 */
export function adultLiveAccessError(user) {
  if (!user || user.status === 'banned') return 'adult login required'
  const birthDate = user.birth_date ? dateOnly(user.birth_date) : ''
  if (!birthDate) return 'adult birth date required'
  if (!isAdultByBirthDate(birthDate)) return 'adult age restricted'
  return ''
}

/** HTTP 列表只需要一个布尔结论；具体拒绝原因留给游戏页现有的年龄门展示。 */
export function canAccessAdultLive(user) {
  return !adultLiveAccessError(user)
}

/**
 * 从直播 socket 的两种身份里取账号：
 *   - Linux / 其它客户端：专用 publisherToken 里的 userId
 *   - 网页端：站内 JWT 里的 uid，并核对 token_version
 *
 * 结果短暂缓存 30 秒，避免每次断线重试 / 重复 watch 都查库；到期后重新确认封号、退出所有设备
 * 和出生日期变更。成人房不能退化成游客身份，验不过就返回 null。
 */
async function liveAccount(socket, findUser) {
  const publisher = socket.data?.livePublisher
  const siteToken = str(socket.handshake?.auth?.token, 512)
  const cacheKey = publisher ? `publisher:${publisher.userId}` : `site:${siteToken}`
  if (
    socket.data?.liveAccountKey === cacheKey &&
    Date.now() - (socket.data.liveAccountAt || 0) < 30_000
  ) {
    return socket.data.liveAccount || null
  }

  let row = null
  if (publisher?.userId) {
    row = await findUser(
      'SELECT id, nickname, status, birth_date, token_version FROM users WHERE id = ?',
      [publisher.userId],
    )
  } else if (siteToken) {
    const payload = verifyToken(siteToken)
    if (payload?.uid) {
      const found = await findUser(
        'SELECT id, nickname, status, birth_date, token_version FROM users WHERE id = ?',
        [String(payload.uid)],
      )
      if (found && found.status !== 'banned' && (Number(payload.tv) || 0) === tokenVersionOf(found)) row = found
    }
  }

  if (row?.status === 'banned') row = null
  if (socket.data) {
    socket.data.liveAccountKey = cacheKey
    socket.data.liveAccount = row
    socket.data.liveAccountAt = Date.now()
  }
  return row
}

/**
 * 普通直播的信令命名空间不要求登录；成人房在 go-live / watch / resume-live 单独验账号和年龄。
 * 若原样转发任意对象或无限量 ICE，
 * 一人就能让主播的 pending 候选和 socket 写队列持续涨；格式不对的 SDP 还可能在主播回调里抛错。
 */
function validSignal(data, role) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  if (Object.keys(data).some((key) => !['sdp', 'candidate', 'error', 'gen'].includes(key))) return false
  if (data.gen !== undefined && (!Number.isSafeInteger(data.gen) || data.gen < 0)) return false
  const count = Number(data.sdp !== undefined) + Number(data.candidate !== undefined) + Number(data.error !== undefined)
  if (count !== 1) return false
  if (data.sdp !== undefined) {
    const sdp = data.sdp
    if (!sdp || typeof sdp !== 'object' || Array.isArray(sdp) || sdp.type !== (role === 'host' ? 'offer' : 'answer')) return false
    if (Object.keys(sdp).some((key) => key !== 'type' && key !== 'sdp')) return false
    if (typeof sdp.sdp !== 'string' || !sdp.sdp || sdp.sdp.length > 128_000) return false
  } else if (data.candidate !== undefined) {
    const c = data.candidate
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.candidate !== 'string' || c.candidate.length > 4_096) return false
    if (Object.keys(c).some((key) => !['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key))) return false
    if (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64)) return false
    if (c.sdpMLineIndex != null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 32)) return false
    if (c.usernameFragment != null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256)) return false
  } else if (role !== 'host' || data.error !== 'no-source') return false
  try {
    return JSON.stringify(data).length <= 140_000
  } catch {
    return false
  }
}

/**
 * 观众一次只连主播，可用小桶；主播要同时给最多 12 人各发一轮 SDP + ICE，
 * 用观众那份额度会把满房时后几个人的 offer 丢掉，造成黑屏。
 */
function takeSignalToken(socket, data, role) {
  const now = Date.now()
  const host = role === 'host'
  const cap = host ? 256 : 64
  const rate = host ? 128 : 32
  const bucket = socket.data?.signalBucket ?? { tokens: cap, at: now }
  bucket.tokens = Math.min(cap, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000)
  bucket.at = now
  const cost = data.sdp ? (host ? 8 : 16) : 1
  if (bucket.tokens < cost) {
    if (socket.data) socket.data.signalBucket = bucket
    return false
  }
  bucket.tokens -= cost
  if (socket.data) socket.data.signalBucket = bucket
  return true
}

/**
 * 发弹幕的人是谁 —— **服务端说了算，绝不采信客户端报的名字**。
 *
 * /live 的网页入口允许匿名；正式外部设备主播则带专用发布凭证，名字在开房时按账号查库。
 * 弹幕不能沿用那套：它是实时广播、没有历史、事后删不掉，
 * 名字可伪造意味着任何人都能挂着房主或者别人的名字说话。
 *
 * 所以：设备主播用开房时已确认的账号昵称；网页握手带站内 JWT 就验签取昵称；
 * 两者都没有才发一个从 socket.id 派生的游客号。
 * 游客号跟着连接走，同一场直播里同一个人前后是同一个号，但他改不了它。
 *
 * 没带令牌的游客身份缓存在 socket.data；带令牌的账号每 30 秒重新查一次。
 * 否则管理员被封、改密码或退出所有设备后，只要旧 socket 没断，仍能一直挂着身份环发弹幕。
 */
export async function chatIdentity(socket, findUser = queryOne) {
  const token = str(socket.handshake?.auth?.token, 512)
  const cached = socket.data?.chatIdentity
  if (cached && (!token || Date.now() - (socket.data.chatIdentityAt || 0) < 30_000)) return cached

  /** 游客号：socket.id 的尾巴。够短能显示，也够区分同一场里的不同人 */
  const guest = String(socket.id || '').slice(-4).toLowerCase() || 'anon'
  let identity = { guest }

  const publisherName = str(socket.data?.livePublisherName, 40)
  if (publisherName) {
    // 外部设备的名字在开房时已经按用户 id 查库，不能再信它握手或 payload 里自报的名字。
    identity = { name: publisherName }
  } else if (token) {
    try {
      const payload = verifyToken(token)
      const userId = payload?.uid
      if (userId) {
        const row = await findUser('SELECT nickname, role, status, token_version FROM users WHERE id = ?', [String(userId)])
        // 登录中间件也比 tv、也挡封号；直播弹幕若漏了这两道，旧令牌就能冒充已作废的身份。
        if (row && row.status !== 'banned' && (Number(payload.tv) || 0) === tokenVersionOf(row)) {
          const nickname = str(row.nickname, 40)
          const role = str(row.role, 20)
          if (nickname) identity = { name: nickname }
          // 只带非普通角色：游客 / 普通玩家不需要额外标记，而 admin/volunteer 要给前端画身份环
          if (nickname && (role === 'admin' || role === 'volunteer')) identity.role = role
        }
      }
    } catch {
      // 验不过（过期、伪造、密钥换了）就当游客，不报错也不拒绝 ——
      // 登录态过期不该表现成「弹幕发不出去」，那没人猜得到要去重新登录
    }
  }

  if (socket.data) {
    socket.data.chatIdentity = identity
    socket.data.chatIdentityAt = Date.now()
  }
  return identity
}

/**
 * 令牌桶限流。只卡间隔的话，攒够时间一次性倒出来照样是刷屏；
 * 只卡总量则正常聊天会被误伤。两个一起才拦得住又不碍事。
 */
function takeChatToken(socket) {
  const now = Date.now()
  const bucket = socket.data?.chatBucket ?? { tokens: CHAT_BURST, at: now }
  const refill = ((now - bucket.at) / CHAT_MIN_INTERVAL_MS) | 0
  if (refill > 0) {
    bucket.tokens = Math.min(CHAT_BURST, bucket.tokens + refill)
    bucket.at = now
  }
  if (bucket.tokens <= 0) {
    if (socket.data) socket.data.chatBucket = bucket
    return false
  }
  bucket.tokens -= 1
  if (socket.data) socket.data.chatBucket = bucket
  return true
}

/**
 * **房间级**洪水闸。takeChatToken 之外还要这一道，因为那个桶挂在 `socket.data` 上 ——
 * **断线就没了**。于是一条脚本只要「连上 → 发满 4 条 → 断开 → 再连」，就能把整套限流
 * 绕干净（一次往返 ~200ms，也就是 20 条/秒），而弹幕的令牌桶本来就是为了防这个存在的。
 *
 * ## 为什么不改成按 IP 计
 *
 * 试过的方向，但**风险更大**：反代少配一个 XFF 头时所有人看起来是同一个 IP ——
 * 这个仓库为此出过事故（每 IP 房间上限让全站只能开 3 间，见 live_audit3 那份记录）。
 * 那种情况下任何按 IP 的限流都会退化成「整站共用一个桶」，一个人打字全站发不出弹幕。
 * 房间级的桶没有这个失效模式：它只按房间算，最坏情况也只影响正在被灌的那一间。
 *
 * ## 数值
 *
 * 6 条/秒、攒到 12 条。单个连接本来就被 takeChatToken 限在 ~0.83 条/秒，
 * 所以这道闸要到**七八个人同时连着刷**才会碰到 —— 正常聊天离它很远，
 * 而画面上同时也只飘 8 条（见 LiveChatLane 的 FLYING_MAX），再多没人读得了。
 *
 * ⚠️ **房主豁免**：一屋子人刷屏时，最该说得上话的那个人正是他（「别刷了」/「我要换游戏了」）。
 * 他自己那一份照旧受 takeChatToken 管，灌不了自己的房间。
 */
const ROOM_CHAT_PER_SEC = 6
const ROOM_CHAT_BURST = 12

function takeRoomChatToken(room) {
  const now = Date.now()
  const bucket = room.chatFlood ?? { tokens: ROOM_CHAT_BURST, at: now }
  const refill = ((now - bucket.at) * ROOM_CHAT_PER_SEC) / 1000
  if (refill >= 1) {
    bucket.tokens = Math.min(ROOM_CHAT_BURST, bucket.tokens + Math.floor(refill))
    bucket.at = now
  }
  room.chatFlood = bucket
  if (bucket.tokens <= 0) return false
  bucket.tokens -= 1
  return true
}

/** roomId -> room */
const rooms = new Map()
/** 没有同步开播的联机房也能聊天；最后一位玩家离开时连历史一起清掉。 */
const matchChats = new Map()
/** socket.id -> {roomId, role} */
const membership = new Map()

const matchChatKey = (roomId) => `match:${roomId}`

function linkedLiveRoom(netplayRoomId) {
  for (const room of rooms.values()) {
    if (room.netplayRoomId && resolveRoomId(room.netplayRoomId) === netplayRoomId) return room
  }
  return null
}

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
     * 主播切到后台了：画面**冻着**，不是断了（见 host-visibility）。
     *
     * ⚠️ 以前只在切换的那一刻推 `host-frozen` 事件，快照里不带 —— 于是**在主播已经切后台
     * 之后才进来的观众**永远收不到那条推送：他等不到任何一帧，界面也没有一个字解释，
     * 只能对着黑屏，最后拿到一句甩锅给他自己网络的错误。中途进来的人必须能从 ack 里读到。
     */
    hostFrozen: Boolean(room.hostFrozen),
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
     * 「这一局能不能让观众上场当 2P」（同屏双打的 Flash 游戏，见
     * src/emulator/coopSeat.ts）以及「位子有没有人坐着」。两格都是主播报上来的。
     *
     * 为什么要过服务端：授权和输入全在主播浏览器里（服务器看不见那条 DataChannel），
     * 但**别人的大厅需要知道这房还差一个人** —— 不然这个功能只有已经在看直播的人
     * 才发现得了，没人会为了找一个 2P 位去把每个直播间都点开一遍。
     * 和上面 netplayRoomId 是同一个道理、同一套做法。
     *
     * 老版本的主播不发 coop-state，两格就都是 false —— 大厅什么都不显示，
     * 正好是安全的那一边。
     */
    coopOpen: Boolean(room.coopOpen),
    coopTaken: Boolean(room.coopTaken),
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

/**
 * 这一房间当前的观众名单。
 *
 * ⚠️ **不带 socket.id**。观众端只拿它显示，不需要 id；而 id 一旦发给房间里所有人，
 * 就等于把「谁是谁」的句柄散出去了。名字本身是服务端派生的（JWT → 昵称，否则游客号），
 * 客户端自报的一律不认 —— 同 chatIdentity。
 *
 * ⚠️ 名字是**异步**解析的（可能查一次库），所以刚进来的那一位可能还没有名字，
 * 这里就只占一个空位 `{}`。观众端按「还没拿到名字」画占位，不要显示成空白行。
 */
function viewerList(room) {
  const out = []
  for (const id of room.viewers) {
    const who = room.viewerNames.get(id)
    if (who?.name) out.push({ name: who.name, role: who.role })
    else if (who?.guest) out.push({ guest: who.guest })
    else out.push({})
  }
  return out
}

/**
 * 解析一位观众的署名，落进 `room.viewerNames`，然后把名单重新广播一遍。
 *
 * 名字由服务端派生（JWT → 昵称，否则游客号），**不收客户端自报的** ——
 * 自报就是冒名的口子，弹幕那边同理（见 chatIdentity）。
 *
 * ⚠️ 解析是异步的，这几十毫秒里房间可能已经散了、这位观众可能已经走了、
 * 甚至已经换过一次 socket。所以落库前必须重新确认「这个 id 还在这个房间的名单里」——
 * 不确认的话会把已经走掉的人重新写回 viewerNames，而那份 Map 再没有别的地方会清它。
 */
function resolveViewerName(nsp, room, socket) {
  const viewerId = socket.id
  void chatIdentity(socket)
    .then((identity) => {
      if (rooms.get(room.id) !== room || !room.viewers.has(viewerId)) return
      room.viewerNames.set(viewerId, identity)
      // 名单变了，房间里所有人重新拿一份
      notifyViewers(nsp, room)
      // 主播那边额外要 viewerId → 名字的映射，「XX 想上场当 2P」那句话用（见 coopSeat.ts）
      if (room.hostSocketId) nsp.to(room.hostSocketId).emit('viewer-name', { viewerId, ...identity })
    })
    .catch(() => {
      /* 取不到名字就留个空位：名单上是「观众」，主播那边退回「有人想上场」 */
    })
}

/** 广播人数**和名单**给房间里所有人（主播 + 观众） */
function notifyViewers(nsp, room) {
  // count 保持原样单独给：观众席徽章只要这一个数，不该为了它去数数组
  nsp.to(room.id).emit('viewers', { roomId: room.id, count: room.viewers.size, list: viewerList(room) })
  // 人数变了 = 大厅那张卡片上的「N 人在看」也变了
  notifyRoomList()
}

/* ---------------- 大厅列表的事件流（SSE） ---------------- */

/**
 * 订阅「正在直播的房间列表」的连接。
 *
 * 以前大厅是每 8 秒轮询一次 /api/live/rooms —— 而侧边栏挂在每个页面上，
 * 等于每个在线访客都在持续打请求，绝大多数时候列表根本没变。
 * netplay 那边早就换成 SSE 了（见 netplay.js 的 /api/netplay/events），
 * 这里补上同一套：平时零请求，开播 / 下播 / 人数变化立刻可见。
 */
const listWatchers = new Set()
let listTimer = null

/** 房间列表有变化就推给订阅者。同一轮的多次变化合并成一次；合并完内容还和上次一样就一个字都不发 */
function notifyRoomList() {
  if (listTimer || listWatchers.size === 0) return
  listTimer = setTimeout(() => {
    listTimer = null
    // 成人房只能推给通过年龄校验的订阅者。不能先推完整列表再让前端过滤：标题、游戏名、
    // 主播名在那一步之前已经泄露。两份快照只各算一次，再按订阅者权限选择。
    const publicJson = JSON.stringify(liveRooms())
    const adultJson = JSON.stringify(liveRooms({ includeAdult: true }))
    for (const watcher of listWatchers) {
      const json = watcher.includeAdult ? adultJson : publicJson
      // 常见的「没变」：成人房人数变化对游客不可见、主播回前台但房本来就没被摘掉……
      if (json === watcher.lastJson) continue
      watcher.lastJson = json
      try {
        watcher.res.write(`event: rooms\ndata: ${json}\n\n`)
      } catch {
        listWatchers.delete(watcher)
      }
    }
  }, 120)
  listTimer.unref?.()
}

/**
 * 挂一个 SSE 订阅者。返回取消订阅的函数。
 * 路由写在 index.js 里（那边才有 app），这里只管数据。
 */
export function subscribeLiveRooms(res, { includeAdult = false } = {}) {
  const json = JSON.stringify(liveRooms({ includeAdult }))
  const watcher = { res, includeAdult: Boolean(includeAdult), lastJson: json }
  listWatchers.add(watcher)
  try {
    res.write(`event: rooms\ndata: ${json}\n\n`)
  } catch {
    listWatchers.delete(watcher)
  }
  return () => listWatchers.delete(watcher)
}

/** 这间房该不该出现在大厅列表里：主播切后台超过 FROZEN_HIDE_MS 就不该 */
function listed(room) {
  if (!room.hostFrozen || room.frozenSince === null) return true
  return Date.now() - room.frozenSince < FROZEN_HIDE_MS
}

/**
 * 主播切后台 + 零观众 → 到点收房。观众进出、主播回前台都要重新算一次：
 * 这里先清再按当前状态决定要不要重新上闹钟，调用方不用管之前有没有。
 */
function scheduleFrozenClose(nsp, room) {
  if (room.frozenTimer) clearTimeout(room.frozenTimer)
  room.frozenTimer = null
  if (!room.hostFrozen || room.viewers.size > 0 || !room.hostSocketId) return
  room.frozenTimer = setTimeout(() => {
    room.frozenTimer = null
    // 期间可能有人进来了、主播回前台了、或者房已经被别的原因关掉 —— 只有状态没变才收
    const cur = rooms.get(room.id)
    if (cur === room && room.hostFrozen && room.viewers.size === 0 && room.hostSocketId) closeRoom(nsp, room, 'host-idle')
  }, FROZEN_CLOSE_MS)
}

/** 主播切到后台了：记时间、到点通知大厅把它摘掉、零观众就上收房的闹钟 */
function armFrozen(nsp, room) {
  if (room.frozenSince === null) room.frozenSince = Date.now()
  if (!room.hideTimer) {
    room.hideTimer = setTimeout(() => {
      room.hideTimer = null
      // 列表是按 listed() 现算的，这里只是叫大厅刷一次
      if (rooms.get(room.id) === room) notifyRoomList()
    }, FROZEN_HIDE_MS)
  }
  scheduleFrozenClose(nsp, room)
}

function clearFrozenTimers(room) {
  if (room.hideTimer) clearTimeout(room.hideTimer)
  if (room.frozenTimer) clearTimeout(room.frozenTimer)
  room.hideTimer = null
  room.frozenTimer = null
  room.frozenSince = null
}

function closeRoom(nsp, room, reason) {
  if (room.awayTimer) clearTimeout(room.awayTimer)
  room.awayTimer = null
  clearFrozenTimers(room)
  nsp.to(room.id).emit('live-ended', { roomId: room.id, reason })
  for (const viewerId of room.viewers) {
    membership.delete(viewerId)
    nsp.sockets.get(viewerId)?.leave(room.id)
  }
  if (room.hostSocketId) {
    membership.delete(room.hostSocketId)
    nsp.sockets.get(room.hostSocketId)?.leave(room.id)
  }
  for (const id of room.matchPlayers) {
    membership.delete(id)
    nsp.sockets.get(id)?.leave(room.id)
  }
  rooms.delete(room.id)
  notifyRoomList()
}

/** 主播的 socket 没了：房间先留着等它回来，到点没回来再散 */
function hostAway(nsp, room) {
  room.hostSocketId = null
  // 主播的 socket 都没了，「切后台」这个状态没有意义了，交给宽限期那套去管
  room.hostFrozen = false
  clearFrozenTimers(room)
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
  notifyRoomList()
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
  notifyRoomList()
}

function leave(nsp, socket) {
  const info = membership.get(socket.id)
  if (!info) return
  membership.delete(socket.id)
  const room = rooms.get(info.roomId)
  if (info.role === 'match') {
    socket.leave(info.roomId)
    if (room) room.matchPlayers.delete(socket.id)
    else {
      const match = matchChats.get(info.roomId)
      match?.players.delete(socket.id)
      if (match?.players.size === 0) matchChats.delete(info.roomId)
    }
    return
  }
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
  room.viewerKeys.delete(socket.id)
  room.viewerNames.delete(socket.id)
  // 告诉主播可以把这条 PeerConnection 拆了，别留着占上行
  if (room.hostSocketId) {
    nsp.to(room.hostSocketId).emit('viewer-left', { viewerId: socket.id })
    // 最后一个观众走了、主播还在后台：上收房的闹钟
    if (room.hostFrozen) scheduleFrozenClose(nsp, room)
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
 * @param {{
 *   findUser?:(sql:string, params?:unknown[])=>Promise<object|null>,
 *   findGame?:(slug:string)=>Promise<object|null>
 * }} [options]
 * @returns {{nsp: import('socket.io').Namespace, list: () => object[]}}
 */
export function attachLive(io, options = {}) {
  const findUser = options.findUser || queryOne
  const findGame = options.findGame || ((slug) => queryOne('SELECT adult FROM games WHERE slug = ? LIMIT 1', [slug]))
  const nsp = io.of('/live')

  /**
   * 不带 publisherToken 的网页主播和普通观众保持原样；带了就必须验过，不能失败后悄悄
   * 降级成匿名主播。正式设备客户端据 connect_error.data.code 区分过期和服务未配置。
   */
  nsp.use((socket, next) => {
    const token = publisherTokenOf(socket)
    if (!token) return next()
    const cfg = openConfig()
    if (!cfg) return next(publisherAuthError('publisher authorization unavailable', 'publisher_auth_unavailable'))
    const claims = verifyLivePublisherToken(token, { publicKey: cfg.publicKey, issuer: cfg.issuer })
    if (!claims) return next(publisherAuthError('invalid or expired publisher token', 'invalid_publisher_token'))
    socket.data.livePublisher = claims
    next()
  })

  nsp.on('connection', (socket) => {
    socket.on('go-live', async (payload, ack) => {
      if (membership.has(socket.id)) return ack?.('already in a room')
      if (socket.data.liveOpening) return ack?.('already opening a room')
      socket.data.liveOpening = true
      try {
        const gameSlug = str(payload?.gameSlug, 120)
        // 本地 ROM / 尚未入库的游戏查不到，沿用既有的普通直播；库里明确标成成人的必须走年龄门。
        // 不能采信 payload.adult —— 客户端自己报「不是成人」就能绕过，等于没有校验。
        const game = gameSlug ? await findGame(gameSlug) : null
        const adult = dbFlag(game?.adult)
        let publisher = null
        const claims = socket.data.livePublisher
        if (claims) {
          // 令牌在 Socket.IO 首连时验过；用户状态再查一次，封禁账号不能拿旧票继续新开房。
          const row = await liveAccount(socket, findUser)
          if (!row) return ack?.('publisher account unavailable')
          publisher = {
            appId: claims.appId,
            userId: claims.userId,
            hostName: str(row.nickname, 40) || 'Device player',
          }
          socket.data.livePublisherName = publisher.hostName
        }

        if (adult) {
          const account = await liveAccount(socket, findUser)
          const accessError = adultLiveAccessError(account)
          if (accessError) return ack?.(accessError)
        }

        // 查用户期间同一条连接可能被别的事件放进房间；await 后必须再确认一次。
        if (membership.has(socket.id)) return ack?.('already in a room')
        if (rooms.size >= MAX_ROOMS) return ack?.('server is full')
        const ip = hostIp(socket)
        if (ip && isPrivateIp(ip)) {
          if (!warnedPrivateIp) {
            warnedPrivateIp = true
            console.warn(
              `[live] 主播的 IP 是内网地址 ${ip}：反代没有把 X-Forwarded-For 传进来（/socket.io/ 那个 location 也要加）。` +
                '每 IP 房间上限对这种地址不生效，否则全站会共用同一个额度。',
            )
          }
        } else if (ip && MAX_ROOMS_PER_IP > 0) {
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
          gameSlug,
          /** 内部权限位，不进 publicRoom；列表和详情在序列化之前按它过滤。 */
          adult,
          gameName: str(payload?.gameName, 120),
          platform: str(payload?.platform, 40),
          // 正式设备主播的显示名只能来自用户表；网页匿名直播保持现有自报名行为。
          hostName: publisher?.hostName || str(payload?.hostName, 40),
          publisher: publisher ? { appId: publisher.appId, userId: publisher.userId } : null,
          startedAt: Date.now(),
          viewers: new Set(),
          /**
           * 观众 socket.id → 观众自己带的 key。信令重连后 socket.id 会换，凭 key 认出
           * 「还是这个人」，把旧 id 换掉而不是当新观众（见文件头「观众换了 socket」）。
           */
          viewerKeys: new Map(),
          /**
           * 观众 socket.id → 服务端派生的署名（`{name}` 或 `{guest}`，同 chatIdentity）。
           *
           * 和 `viewers` 分开存而不是把 Set 换成 Map：`viewers` 有十来处在用
           * `for...of` / `Array.from` / `.has()` 的集合语义（resume-live 的 ack 直接
           * `Array.from(room.viewers)`），换成 Map 会让那些地方悄悄拿到 [k,v] 对。
           * ⚠️ 代价是这两份要手动保持同步 —— 每一处 `viewers.delete` 旁边都必须有一条
           * `viewerNames.delete`，server/scripts/test-live.mjs 有断言盯着。
           */
          viewerNames: new Map(),
          /** 联机玩家只进弹幕通道，不占观众席，也不触发视频 offer。 */
          matchPlayers: new Set(),
          awayTimer: null,
          awaySince: null,
          /** 主播是不是切到后台了（画面冻着）。见 host-visibility */
          hostFrozen: false,
          /** 切到后台是什么时候。大厅过滤（FROZEN_HIDE_MS）按它算 */
          frozenSince: null,
          /** 到点把房从列表里摘掉时要通知大厅一次 */
          hideTimer: null,
          /** 后台 + 零观众到点收房 */
          frozenTimer: null,
          /** 2P 位：主播报上来的（coop-state）。开播那一刻还不知道，先当没有 */
          coopOpen: false,
          coopTaken: false,
          // hostSocketId / hostIp / presence 由 bindHost 填：主播重连时也走它，只写一处
          hostSocketId: null,
          hostIp: '',
          /**
           * 主播的名片。设备和国家在绑定那一刻就定死了，RTT 由 socket.io 的心跳
           * 持续刷新，所以存的是个取快照的函数而不是一份数据。
           */
          presence: null,
          /**
           * 最近几条弹幕。中途进来的观众从 watch 的 ack 里拿到，不至于面对一片空白。
           *
           * 只在内存里，不落库：弹幕是「当下」的东西，房间散了就该跟着没。
           * 存下来就得再配一套删除、举报、审核 —— 那是评论该干的事，不是弹幕。
           */
          chat: [],
          /** 房间级洪水闸的桶（见 takeRoomChatToken）。跟着房间散场一起没，不需要清理 */
          chatFlood: null,
        }
        rooms.set(id, room)
        bindHost(nsp, room, socket)
        ack?.(null, { roomId: id, token: room.token })
      } catch (e) {
        console.warn('[live] 开播权限检查失败：', e)
        ack?.('failed')
      } finally {
        socket.data.liveOpening = false
      }
    })

    socket.on('resume-live', async (payload, ack) => {
      if (membership.has(socket.id)) return ack?.('already in a room')
      if (socket.data.liveResuming) return ack?.('already resuming')
      socket.data.liveResuming = true
      try {
        const room = rooms.get(str(payload?.roomId, 64))
        if (!room) return ack?.('not found')
        const token = str(payload?.token, 64)
        if (!token || token !== room.token) return ack?.('forbidden')
        if (room.publisher) {
          const claims = socket.data.livePublisher
          if (!claims || claims.appId !== room.publisher.appId || claims.userId !== room.publisher.userId) {
            return ack?.('publisher authorization required')
          }
          socket.data.livePublisherName = room.hostName
        }
        if (room.adult) {
          const accessError = adultLiveAccessError(await liveAccount(socket, findUser))
          if (accessError) return ack?.(accessError)
        }

        // 查账号期间房间可能已经到期散场；不能把一个已删除的对象重新绑回 socket。
        if (rooms.get(room.id) !== room) return ack?.('not found')
        if (membership.has(socket.id)) return ack?.('already in a room')

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
      } catch (e) {
        console.warn('[live] 续播权限检查失败：', e)
        ack?.('failed')
      } finally {
        socket.data.liveResuming = false
      }
    })

    socket.on('watch', async (payload, ack) => {
      if (socket.data.liveWatching) return ack?.('already watching')
      socket.data.liveWatching = true
      try {
        const room = rooms.get(str(payload?.roomId, 64))
        if (!room) return ack?.('not found')
        if (room.adult) {
          const accessError = adultLiveAccessError(await liveAccount(socket, findUser))
          if (accessError) return ack?.(accessError)
        }
        // 查账号期间主播可能已经下播；后面的 join 不能把人放进一个不存在的 socket.io 房。
        if (rooms.get(room.id) !== room) return ack?.('not found')
        const info = membership.get(socket.id)
        const again = info?.role === 'viewer' && info.roomId === room.id
        if (info && !again) return ack?.('already in a room')

      /**
       * 同一个观众换了 socket（信令重连）：名单里还挂着它上一条连接的 id。
       * 那个 id 不是别人，是它自己的幽灵 —— 不该占人数，更不该让它把自己挤出满员的房间。
       * key 是观众自己生成的随机串，别人猜不到，所以拿着 key 来的就是同一个人。
       */
      const key = str(payload?.key, 64)
      let previous = null
      if (!again && key) {
        for (const [id, k] of room.viewerKeys) {
          if (k === key && id !== socket.id) {
            previous = id
            break
          }
        }
      }
      if (!again && !previous && room.viewers.size >= MAX_VIEWERS) return ack?.('full')

      if (previous) {
        room.viewers.delete(previous)
        room.viewerKeys.delete(previous)
        room.viewerNames.delete(previous)
        membership.delete(previous)
        nsp.sockets.get(previous)?.leave(room.id)
      }
      if (!again) {
        room.viewers.add(socket.id)
        if (key) room.viewerKeys.set(socket.id, key)
        membership.set(socket.id, { roomId: room.id, role: 'viewer' })
        socket.join(room.id)
        // 有人来看了：后台 + 零观众那把收房的闹钟得撤
        if (room.hostFrozen) scheduleFrozenClose(nsp, room)
      }
      // 带上最近几条弹幕：中途进来的观众不该面对一片空白。
      // 只在 watch 的 ack 里给，不进 publicRoom —— 那个是大厅列表用的，
      // 每张卡片都驮着 30 条弹幕纯属白费流量
      ack?.(null, { ...publicRoom(room), hostId: room.hostSocketId, chat: room.chat, rebound: Boolean(previous) })
      // 由主播发起 offer：它才知道自己有几条轨、什么编码。
      // 主播不在就先不发，它 resume 回来时会拿到观众名单自己补
      if (room.hostSocketId) {
        const reoffer = Boolean(payload?.reoffer)
        if (previous && !reoffer) {
          // 画面还连着，只是 socket 换了：主播把那条 PeerConnection 换个名字就行，别重建
          nsp.to(room.hostSocketId).emit('viewer-rebound', { from: previous, to: socket.id })
        } else {
          nsp.to(room.hostSocketId).emit('viewer-joined', { viewerId: socket.id, ...(previous ? { replaces: previous } : {}) })
        }
        /*
          名字**不在这条里**，单独异步发，见下面 resolveViewerName。
        */
      }
      /*
        名字**单独解析、异步发**，不挡 viewer-joined。

        viewer-joined 是 offer 的发令枪，而 chatIdentity 可能要查一次库 ——
        让发令枪等一次 I/O 会把第一帧往后推，为一个显示字段付这个代价不值得。

        ⚠️ 这一段以前嵌在 `if (room.hostSocketId)` 里，也就是**主播不在时根本不解析名字**。
        那时候名字只服务于主播那句「XX 想上场当 2P」，没主播确实不需要。现在它还要供
        观众端的名单用（房间里所有人都看得到），主播在不在都得解析。
      */
        if (!again) resolveViewerName(nsp, room, socket)
        // 换 socket 不算人数变化：一个人还是一个人。
        // （换 socket 那一路的名单由 resolveViewerName 解析完再广播）
        if (!again && !previous) notifyViewers(nsp, room)
      } catch (e) {
        console.warn('[live] 观看权限检查失败：', e)
        ack?.('failed')
      } finally {
        socket.data.liveWatching = false
      }
    })

    socket.on('join-match-chat', async (payload, ack) => {
      if (socket.data.matchChatJoining) return ack?.('already joining')
      socket.data.matchChatJoining = true
      try {
        const asked = str(payload?.netplayRoomId, 64)
        const netplayRoomId = resolveRoomId(asked)
        const token = str(payload?.token, 64)
        if (!netplayRoomId || !isNetplayPlayer(netplayRoomId, token)) return ack?.('not a player')
        const live = linkedLiveRoom(netplayRoomId)
        if (live?.adult) {
          const accessError = adultLiveAccessError(await liveAccount(socket, findUser))
          if (accessError) return ack?.(accessError)
        }
        if (!isNetplayPlayer(netplayRoomId, token)) return ack?.('not a player')
        if (live && rooms.get(live.id) !== live) return ack?.('not found')
        const prior = membership.get(socket.id)
        if (prior && prior.role !== 'match') return ack?.('already in a room')
        if (prior) leave(nsp, socket)

        const key = live?.id ?? matchChatKey(netplayRoomId)
        let match = null
        if (!live) {
          match = matchChats.get(key)
          if (!match) {
            match = { id: key, players: new Set(), chat: [], chatFlood: null }
            matchChats.set(key, match)
          }
          match.players.add(socket.id)
        } else live.matchPlayers.add(socket.id)
        membership.set(socket.id, { roomId: key, role: 'match', netplayRoomId, token })
        socket.join(key)
        ack?.(null, { chat: live?.chat ?? match.chat, live: Boolean(live) })
      } catch (e) {
        console.warn('[live] 联机弹幕权限检查失败：', e)
        ack?.('failed')
      } finally {
        socket.data.matchChatJoining = false
      }
    })

    /**
     * 转发握手包。只在同一个房间内、且只在「主播 ↔ 观众」之间转 ——
     * 不加这层校验的话，任何人都能拿别人的 socketId 往里塞 SDP。
     * 观众发的一律送给当前主播：主播重连后 id 变了，观众手里的旧 id 不算数。
     */
    socket.on('signal', (payload) => {
      const info = membership.get(socket.id)
      if (!info || info.role === 'match') return
      const room = rooms.get(info.roomId)
      if (!room) return
      const data = payload?.data
      if (!validSignal(data, info.role) || !takeSignalToken(socket, data, info.role)) return
      let target
      if (info.role === 'host') {
        target = str(payload?.target, 64)
        if (!target || !room.viewers.has(target)) return
      } else {
        target = room.hostSocketId
        if (!target) return
      }
      nsp.to(target).emit('signal', { from: socket.id, data })
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
      const previous = room.netplayRoomId
      room.netplayRoomId = next
      // 已在纯联机弹幕房的人要换到直播弹幕流；结束联机时则反向退回。
      if (previous) nsp.to(room.id).emit('match-chat-moved')
      if (next) nsp.to(matchChatKey(resolveRoomId(next))).emit('match-chat-moved')
      /**
       * 但**正在看的人不能等**：他们已经在房间里了，不会再去刷大厅。
       * 主播一点「联机」，观众那边就该立刻多出一个「加入联机」的入口 ——
       * 这正是「看着看着就能上场」这件事成立的前提。
       * 后进来的观众不用管，watch 的 ack 里带着 publicRoom，本来就有这个字段。
       */
      nsp.to(room.id).emit('netplay-linked', { roomId: next })
      notifyRoomList()
    })

    /**
     * 主播报「2P 位」的状态。**只有主播能发** —— 观众能改的话，谁都能把别人的
     * 直播间标成「还差一个人」，把人骗进一个压根不能上场的房间（和 link-netplay
     * 那条一模一样的理由，那边也有对应的测试）。
     *
     * 服务器只存不判：座位给谁、按键放不放行，全在主播浏览器里守
     * （见 src/emulator/coopSeat.ts 的文件头）。这里存的只是给大厅看的两个布尔。
     */
    socket.on('coop-state', (payload) => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return
      const room = rooms.get(info.roomId)
      if (!room || room.hostSocketId !== socket.id) return
      const open = Boolean(payload?.open)
      const taken = Boolean(payload?.taken)
      // 没变就别惊动大厅：主播那边是在 5 秒一轮的统计循环里顺手报的，绝大多数轮次没变化
      if (room.coopOpen === open && room.coopTaken === taken) return
      room.coopOpen = open
      room.coopTaken = taken
      notifyRoomList()
    })

    socket.on('stop-live', () => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return
      const room = rooms.get(info.roomId)
      if (room) closeRoom(nsp, room, 'stopped')
    })

    /**
     * 主播切到后台了（或切回来了）。
     *
     * 浏览器不给后台标签页出帧 —— `canvas.captureStream` 直接停住，观众那边画面**冻结**。
     * 这是浏览器行为，改不了。但以前观众看到的是一张凝固的画面、没有任何解释：
     * 他分不清是自己网断了、主播卡了、还是游戏暂停了，于是刷新、退出、再进来，
     * 白白折腾一圈。告诉他一句就够了。
     *
     * 只有房主能报、而且只能报自己那间 —— 不然任何观众都能把别人的直播标成「已冻结」。
     */
    socket.on('host-visibility', (payload) => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return
      const room = rooms.get(info.roomId)
      if (!room || room.hostSocketId !== socket.id) return
      const frozen = Boolean(payload?.hidden)
      if (room.hostFrozen === frozen) return // 状态没变就不用惊动所有人
      room.hostFrozen = frozen
      if (frozen) armFrozen(nsp, room)
      else clearFrozenTimers(room)
      socket.to(room.id).emit('host-frozen', { roomId: room.id, frozen })
      // 回前台的房要重新出现在大厅里；刚切后台的还不摘（到点 hideTimer 会叫）
      if (!frozen) notifyRoomList()
    })

    /**
     * 发一条弹幕。房主、观众和联机玩家都能发，发完广播给这个房间里的**所有人**（含发的人自己 ——
     * 本地不做乐观回显，这样每个人看到的顺序都是服务端定的那一个）。
     *
     * ⚠️ 房间号**只从 membership 里取，绝不采信 payload**。
     * 让客户端指定 roomId 等于开了个跨房间注入的口子：不在任何房间里的人
     * 也能往任意直播间广播，而这是 netplay 那边已经踩过的坑（见 netplay 加固那一份）。
     *
     * ⚠️ 名字同理，由 chatIdentity 从 JWT 或 socket.id 派生，客户端说什么都不算数。
     * host 这个标记也是服务端比对 hostSocketId 得出的 —— 冒充房主说话是弹幕里
     * 破坏力最大的一种，不能留给客户端自觉。
     */
    socket.on('chat', (payload, ack) => {
      const info = membership.get(socket.id)
      if (!info) return ack?.(CHAT_ACK_NO_ROOM)
      const room = rooms.get(info.roomId) ?? matchChats.get(info.roomId)
      if (!room) return ack?.(CHAT_ACK_NOT_FOUND)
      if (info.role === 'match' &&
          (!isNetplayPlayer(info.netplayRoomId, info.token) ||
            (rooms.has(info.roomId) && resolveRoomId(room.netplayRoomId) !== info.netplayRoomId))) {
        return ack?.(CHAT_ACK_NO_ROOM)
      }

      const text = sanitizeChatText(payload?.text)
      if (!text) return ack?.(CHAT_ACK_EMPTY)
      if (!takeChatToken(socket)) return ack?.(CHAT_ACK_TOO_FAST)
      // 房间级的那一道。房主豁免，理由见 takeRoomChatToken
      const isHost = room.hostSocketId === socket.id
      if (!isHost && !takeRoomChatToken(room)) return ack?.(CHAT_ACK_TOO_FAST)

      /*
        ⚠️ 必须有 .catch()。这不是洁癖：Node 22 对未处理的 rejection 是**直接杀进程**，
        而这个 .then() 的回调里做的是 emit + ack + 数组操作 —— 任何一个抛出来，
        整台服务器（SSR、socket.io、所有房间）跟着一起没。
        chatIdentity 自己内部有 try/catch，所以这一条现在拦的是**回调**里的意外。
      */
      void chatIdentity(socket).then((identity) => {
        // 异步取身份的这几毫秒里房间可能已经散了 / 人已经走了，再确认一次
        if ((rooms.get(room.id) !== room && matchChats.get(room.id) !== room) || membership.get(socket.id)?.roomId !== room.id) return
        if (info.role === 'match' && !isNetplayPlayer(info.netplayRoomId, info.token)) return ack?.(CHAT_ACK_NO_ROOM)
        const msg = {
          id: randomBytes(8).toString('base64url'),
          at: Date.now(),
          ...identity,
          host: room.hostSocketId === socket.id,
          text,
        }
        room.chat.push(msg)
        if (room.chat.length > CHAT_HISTORY_SIZE) room.chat.splice(0, room.chat.length - CHAT_HISTORY_SIZE)
        nsp.to(room.id).emit('chat', msg)
        ack?.(null, { id: msg.id })
      }).catch((e) => {
        console.warn('[live] 弹幕广播失败：', e)
        ack?.(CHAT_ACK_FAILED)
      })
    })

    socket.on('leave', () => leave(nsp, socket))
    socket.on('disconnect', () => leave(nsp, socket))
  })

  return { nsp, list: () => liveRooms() }
}

/**
 * 给 REST / SSE 用：当前在播的房间。
 *
 * 默认永远不返回成人房；只有 HTTP 层已经核实账号年龄后才能显式传 includeAdult。
 * 这样开放平台、TV、爬虫以及任何后来新增但忘了鉴权的调用方都会落在安全默认值上。
 */
export function liveRooms({ gameSlug, includeAdult = false } = {}) {
  // 主播切后台太久的房不上列表（有权限的人用直链 liveRoom() 仍能查到 —— 那是人家发出去的链接）
  const all = Array.from(rooms.values()).filter((room) => listed(room) && (includeAdult || !room.adult))
  const picked = gameSlug ? all.filter((r) => r.gameSlug === gameSlug) : all
  return picked.sort((a, b) => b.viewers.size - a.viewers.size || a.startedAt - b.startedAt).map(publicRoom)
}

/**
 * 给自动开播做的轻量预检。
 *
 * 这里必须看 rooms.size，不能拿 liveRooms().length 代替：主播切到后台太久后，房间会从大厅
 * 隐藏，但仍然占着服务端席位；若把隐藏房漏掉，客户端会误以为还有空位，白做一次抓屏和信令连接。
 * 这只是提前避开已满状态；并发争最后一个席位时仍由 go-live 里的同一条上限做最终裁决。
 */
export function liveCapacity() {
  const used = rooms.size
  return {
    used,
    max: MAX_ROOMS,
    remaining: Math.max(0, MAX_ROOMS - used),
    available: used < MAX_ROOMS,
  }
}

export function liveRoom(roomId, { includeAdult = false } = {}) {
  const room = rooms.get(String(roomId || ''))
  return room && (includeAdult || !room.adult) ? publicRoom(room) : null
}
