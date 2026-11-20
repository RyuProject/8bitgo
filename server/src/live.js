import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { watchPresence, clientIpFrom, isPrivateIp, UNKNOWN_PRESENCE } from './presence.js'
import { verifyToken, tokenVersionOf } from './auth.js'
import { queryOne } from './db.js'
import { isNetplayPlayer, resolveRoomId } from './netplay.js'
import { openConfig } from './open/config.js'
import * as livePublisherModule from './open/live-publisher.js'
import { dateOnly, dbFlag } from './mappers.js'
import { isAdultByBirthDate } from '../../shared/age.js'
import { guardSocketArgs } from './socket-guard.js'
import { admitSse, sseWrite, SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_MS } from './sseGuard.js'
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
 * 房间控制仍走本服务的 Socket.IO。SRS 房间把音视频交给独立 SFU，旧房间继续兼容 P2P：
 *
 *   P2P：浏览器(主播) ──WebRTC 音视频──► 浏览器(观众) × N
 *   SRS：浏览器(主播) ──一路 WebRTC──► SRS ──转发──► 浏览器(观众) × N
 *
 * SRS API 只由服务端通过 loopback 访问，短时签名票同时约束房间、流名和发布 / 播放角色。
 * 观众 2P 输入仍经主播与观众之间的独立 DataChannel，不让按键依赖媒体转发。
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
/**
 * 同一条 socket 开播 / 续播的频率上限（令牌桶：容量 OPEN_BURST，每 OPEN_REFILL_MS 补一枚）。
 *
 * 每 IP 房间上限只管「同时有几间」，管不了「一条连接每秒 go-live → stop-live 几千次」：
 * 每一轮都要查库（findGame / liveAccount）、建房、通知大厅，脚本一条 socket 就能把 10 连接的
 * MySQL 池和大厅 SSE 推送一起压住。正常客户端开播最多补试 3 次、续播按秒级退避，
 * 容量 10 / 每 6 秒一枚绰绰有余。和联机 open-room 的 netplayOpening 一样挡在查库之前；
 * 「已经是这间房的主播」那条补回原结果的捷径不消耗令牌（它不查库，也是 ack 丢失后的正规重试）。
 */
const OPEN_BURST = Number(process.env.LIVE_OPEN_BURST || 10)
const OPEN_REFILL_MS = Number(process.env.LIVE_OPEN_REFILL_MS || 6_000)
function takeOpenToken(socket) {
  if (!(OPEN_BURST > 0)) return true
  const now = Date.now()
  const bucket = socket.data?.liveOpenBucket ?? { tokens: OPEN_BURST, at: now }
  bucket.tokens = Math.min(OPEN_BURST, bucket.tokens + Math.max(0, now - bucket.at) / Math.max(1, OPEN_REFILL_MS))
  bucket.at = now
  if (socket.data) socket.data.liveOpenBucket = bucket
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}
/** P2P 单场上限；SRS 使用独立上限，但仍需考虑每位观众的协作 DataChannel。 */
const MAX_VIEWERS = Number(process.env.LIVE_MAX_VIEWERS || 12)
/** SRS 把一路上行扇出给观众；上限仍保守设置，避免观众数反过来压垮信令和协作通道。 */
const configuredSrsViewers = Number(process.env.LIVE_SRS_MAX_VIEWERS || 100)
const MAX_SRS_VIEWERS = Number.isSafeInteger(configuredSrsViewers) && configuredSrsViewers > 0
  ? Math.min(configuredSrsViewers, 500)
  : 100
/** 单房上限挡不住多房间同时挤满；全局观众预算用来保护 SRS 出口带宽与会话数。 */
const configuredSrsTotalViewers = Number(process.env.LIVE_SRS_MAX_TOTAL_VIEWERS || 50)
const MAX_SRS_TOTAL_VIEWERS = Number.isSafeInteger(configuredSrsTotalViewers) && configuredSrsTotalViewers > 0
  // SRS 的 max_connections=1000 还要容纳每间活跃房的一条发布连接，故应用层总观众最多 400。
  ? Math.min(configuredSrsTotalViewers, 400)
  : 50
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
/**
 * 「主播 socket 已经不在了、房间却还挂着他」的扫描间隔。
 *
 * 这是**兜底**，不是主路径：正常断线由 `leave()` 收干净、`bindHost` 也不会让一个 socket
 * 同时挂两间房。但 2026-09-20 线上出现过一间这样的房：主播**整个浏览器关掉**之后，
 * 它在大厅里挂着 `viewers: 0` 而 `hostAway: false`（服务端以为人还在），
 * 点进去什么都没有，而且不会自己消失。事后没能把产生它的那条路径钉死 ——
 * 房间的清理全靠 `membership`（每个 socket 只有一条）这一件事本身就很脆：
 * 只要有一处让它和 `rooms` 漂开，那间房就永远收不到任何清理。
 *
 * 所以这里不假设「漂移不会再发生」，而是每 30 秒按**事实**核一遍：
 * 房间记着的 hostSocketId 还在不在 nsp.sockets 里。不在就按主播离开处理
 * （有人看走宽限期、没人看直接散）——最坏情况下大厅最多多挂 30 秒。
 */
const GHOST_SWEEP_MS = Number(process.env.LIVE_GHOST_SWEEP_MS || 30_000)

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
    const found = await findUser(
      'SELECT id, nickname, status, birth_date, token_version FROM users WHERE id = ?',
      [publisher.userId],
    )
    if (found && found.status !== 'banned' && (await publisherStillValid(publisher, found, findUser))) row = found
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
 * 设备发布凭证签出去之后是否还算数（凭证最长 24 小时，必须能被撤销）。
 *
 *   · 用户「退出所有设备」/ 改密码会把 users.token_version +1：凭证里的 tv 对不上就作废，
 *     和网页 JWT 同一条规则（§2.14）。没带 tv 的旧凭证按 0 处理 —— 只有从没轮换过版本的账号能继续用，
 *     轮换过的账号要重新换一张；
 *   · 签发凭证的开放平台应用被停用（oauth_apps.status = 'suspended'）或已删除：它签出去的直播凭证
 *     一并失效，否则停用应用只挡得住新授权、挡不住已经在播的设备。
 * 优先用 open/live-publisher.js 导出的同名校验（与签发方放在一起维护）；还没有时用这里的同等实现。
 */
async function publisherStillValid(claims, userRow, findUser) {
  if (typeof livePublisherModule.publisherClaimsStillValid === 'function') {
    return Boolean(await livePublisherModule.publisherClaimsStillValid(claims, userRow))
  }
  if ((Number(claims?.tv) || 0) !== tokenVersionOf(userRow)) return false
  if (claims?.appId) {
    const app = await findUser('SELECT status FROM oauth_apps WHERE id = ?', [String(claims.appId)])
    if (!app || app.status === 'suspended') return false
  }
  return true
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
/**
 * 没有同步开播的联机房也能聊天；最后一位玩家离开时连历史一起清掉。
 *
 * ⚠️ 这个 Map 原来是**只加不减**的：清理只写在 leave() 里「room 不存在」那一条分支上，
 * 而玩家一旦先以 `match:<id>` 进来、随后主播开播并 link-netplay 绑定，
 * leave() 走的就是 `room.matchPlayers.delete(...)` 那条路 —— `match:<id>` 这条记录
 * 的 players 从此再没人删，整条（连带 chat 数组）永久留在内存里。
 * 一场直播开几个小时、联机房换几十个，就是几十条僵尸记录。
 *
 * 所以每条记一个 lastAt，由清扫按「没人 + 够久」回收（见 MATCH_CHAT_TTL_MS）。
 */
const matchChats = new Map()
/** socket.id（或事件流观众的 id，见下）-> {roomId, role} */
const membership = new Map()

const matchChatKey = (roomId) => `match:${roomId}`

/* ---------------- 不走 socket.io 的 SRS 观众（事件流观众） ---------------- */

/**
 * SRS 房的观众只看不玩时，**不开 socket.io**：一次 POST 进房，响应体就是这个人专属的 SSE 事件流
 * （欢迎快照 + 播放票 + 之后的人数 / 弹幕 / 推流状态），换票、发弹幕、催主播各是一个小 POST。
 *
 * 为什么（2026-11-20）：8bitgo.com 上的大陆观众连 socket.io 要走 Cloudflare 洛杉矶 —— WebSocket 要另起一条
 * TCP + TLS，再走 engine.io 握手、命名空间连接、watch 的 ack，首连实测 4～8 秒；而这条 POST 复用页面已有的
 * HTTP/2 连接，一个往返就拿到播放票。同类网站（ggemu）的观众页也是「拿票 → WHEP → SSE 收弹幕」，没有长连接。
 *
 * 长连接只留给主播和「上场当 2P」：2P 输入走主播与观众之间的 DataChannel，SDP / ICE 要服务器转发，
 * 所以有 2P 位时观众端会带同一把 key 改连 socket.io 再 watch 一次 —— 服务端按 key 认出同一个人，
 * 把事件流换成 socket（见 watch 里的 previous），SRS 拉流不断。
 *
 * 身份和 socket 观众同一套：成员 id 记进 room.viewers / membership（播放票、SRS hook、名单、人数
 * 全部原样复用），只是这个 id 不对应任何 socket。凡是拿「nsp.sockets 里有没有」判活的地方都要认它
 * （幽灵扫描），凡是给房间广播的地方都要顺带写一份到事件流（toRoom）。
 */
const STREAM_ID_PREFIX = 'sv_'
/** 成员 id -> 事件流观众 */
const streamViewers = new Map()
/** 会话令牌 -> 事件流观众。令牌只走请求体，不进 URL（URL 会落进访问日志、浏览历史和 Referer） */
const streamSessions = new Map()
/** roomId -> Set<事件流观众>。广播时按房间直取，不扫全部观众 */
const roomStreams = new Map()
/** 催主播（重发一次人数给主播）每位观众最短间隔 */
const STREAM_NUDGE_MIN_MS = 3_000
/** 主播报「抓不到画面」转给事件流观众的最短间隔（按房间） */
const SOURCE_MISSING_MIN_MS = 2_000

const isStreamViewer = (id) => typeof id === 'string' && streamViewers.has(id)

/**
 * 给事件流观众用的「伪 socket」：chatIdentity / liveAccount / 各种令牌桶只读 id、handshake.auth.token、data，
 * 给它一个形状相同的对象，就不用为事件流另写一套身份与限流逻辑（两套迟早不一致）。
 */
function streamPseudoSocket(id, token) {
  return { id, connected: true, handshake: { auth: { token: token || '' } }, data: {} }
}

function streamFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`
}

/** 写一帧给某位事件流观众；写不进去（客户端读不动了 / 已断开）返回 false */
function writeStream(viewer, event, payload) {
  if (viewer.closed) return false
  try {
    return sseWrite(viewer.res, streamFrame(event, payload))
  } catch {
    return false
  }
}

/**
 * 只关掉事件流本身、摘掉索引，**不动**房间名单。用于两种情形：
 *   · 同一把 key 换了新连接（事件流重连 / 升级成 socket）—— 名单已经转到新 id 名下；
 *   · 房间散场 —— 名单随房间一起没了。
 * 真正「这位观众走了」走 leaveStream。
 */
function detachStream(viewer, finalEvent = null, finalPayload = null) {
  if (viewer.closed) return
  if (finalEvent) writeStream(viewer, finalEvent, finalPayload)
  viewer.closed = true
  if (viewer.beat) clearInterval(viewer.beat)
  viewer.beat = null
  streamViewers.delete(viewer.id)
  streamSessions.delete(viewer.session)
  const set = roomStreams.get(viewer.roomId)
  if (set) {
    set.delete(viewer)
    if (set.size === 0) roomStreams.delete(viewer.roomId)
  }
  try {
    if (!viewer.res.writableEnded) viewer.res.end()
  } catch {
    /* 连接早就没了 */
  }
}

/** 给这间房的所有事件流观众推一条。写失败的那几位当作已离开（下一轮幽灵扫描也会兜底） */
function streamBroadcast(nsp, roomId, event, payload) {
  const set = roomStreams.get(roomId)
  if (!set || set.size === 0) return
  const dead = []
  for (const viewer of set) if (!writeStream(viewer, event, payload)) dead.push(viewer)
  for (const viewer of dead) leaveStream(nsp, viewer)
}

/**
 * 给房间广播：socket.io 房间里的人一份，事件流观众一份。
 * `except` 是要排除的那条 socket（原来写 socket.to(room.id) 的地方）；事件流观众从来不是主播，照发。
 */
function toRoom(nsp, roomId, event, payload, except = null) {
  if (except) except.to(roomId).emit(event, payload)
  else nsp.to(roomId).emit(event, payload)
  streamBroadcast(nsp, roomId, event, payload)
}

/**
 * SRS 在没有完整部署配置时保持关闭，开发环境可继续使用原有 P2P；显式启用 SRS 后必须 fail closed。
 * API 端口只给本机 8BitGo 服务访问；浏览器只拿到短时授权，不接触 SRS 管理 API。
 */
function srsConfig() {
  if (!srsRequested()) return null
  const internalApi = String(process.env.LIVE_SRS_INTERNAL_API_ORIGIN || 'http://127.0.0.1:1985').trim()
  const tokenSecret = String(process.env.LIVE_SRS_TOKEN_SECRET || '')
  const hookSecret = String(process.env.LIVE_SRS_HOOK_SECRET || '')
  try {
    const internal = new URL(internalApi)
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || tokenSecret.length < 32 || hookSecret.length < 32 || tokenSecret === hookSecret) return null
    return { internalApi: internal.origin, tokenSecret, hookSecret }
  } catch {
    return null
  }
}

/** 启动日志也从这里读开关，避免同一个 .env 键在多个文件里各自解释。 */
function srsRequested() {
  return String(process.env.LIVE_SRS_ENABLED || '').toLowerCase() === 'true'
}

/** 生产可以额外锁定 SRS，避免有人误删启用开关后悄悄把直播退回主播直连。 */
function srsMandatory() {
  return String(process.env.LIVE_SRS_REQUIRED || '').toLowerCase() === 'true'
}

let srsHealth = { internalApi: '', checkedAt: 0, available: false }
const SRS_HEALTH_CACHE_MS = 3_000

/**
 * 配置齐全不代表 SRS 进程或内网 API 正常。只在创建新房间前做短时探测；显式启用 SRS 后，
 * 探测失败必须拒绝开播，不能悄悄把媒体改成主播直连，否则流量和容量会绕过 SFU 保护。
 */
async function srsServiceAvailable() {
  const config = srsConfig()
  if (!config) return false
  const now = Date.now()
  if (srsHealth.internalApi === config.internalApi && now - srsHealth.checkedAt < SRS_HEALTH_CACHE_MS) {
    return srsHealth.available
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_200)
  let available = false
  try {
    const response = await fetch(`${config.internalApi}/api/v1/versions`, { signal: controller.signal })
    const payload = await response.json()
    // 不同 SRS 6 小版本的 versions 响应有的带 code，有的只返回版本字段。
    const version = payload?.data?.version ?? payload?.version
    available = response.ok && (payload?.code === 0 || (typeof version === 'string' && version.length > 0))
  } catch {
    available = false
  } finally {
    clearTimeout(timer)
  }
  const wasKnown = srsHealth.internalApi === config.internalApi && srsHealth.checkedAt > 0
  const wasAvailable = wasKnown && srsHealth.available
  srsHealth = { internalApi: config.internalApi, checkedAt: Date.now(), available }
  if (!wasKnown || available !== wasAvailable) {
    if (available) console.info('[live] SRS 健康检查通过，新直播间可使用 SRS')
    else console.warn('[live] SRS 健康检查失败；SRS 模式已启用，新直播间将拒绝开播')
  }
  return available
}

/** SRS 同时在线观众数很小，逐房求和比维护易漂移的重复计数更可靠。 */
function activeSrsViewerCount() {
  let count = 0
  for (const room of rooms.values()) if (room.transport === 'srs') count += room.viewers.size
  return count
}

/** SRS 流名 → 房间。hook 每个会话都会来几次，按流名直查，不扫全部房间。 */
const srsRooms = new Map()

const srsNegotiations = new Map()
const SRS_NEGOTIATION_WINDOW_MS = 60_000
const SRS_NEGOTIATION_LIMIT = 8

/**
 * SRS 的会话**不随**我们的房间成员关系自动结束：浏览器只要不关 PeerConnection、一直回 STUN，
 * SRS 就一直给它转发。只靠「每张票每分钟 8 次」挡不住两种放大：
 *   · 同一个观众反复兑换播放票，每分钟多 8 路拉流、旧的不关，几十分钟就是几百路出口带宽；
 *   · 观众断开信令（离房）但不关拉流，再换一个 socket 进房拿新票，名单上只占一席，SRS 里却越堆越多。
 * 主播那边则相反：网络切换后旧上行在 SRS 眼里还活着（要等 stun_timeout，默认 30 秒），新上行会被
 * 判成「stream busy」，所有观众要黑屏半分钟以上。
 *
 * 所以这里按 hook 给的 client_id 记账，并通过只监听回环的 HTTP API 主动踢掉被取代 / 已离房的会话：
 *   · 同一成员新开播放会话 → 踢掉旧的（每位观众在 SRS 里最多一路）；
 *   · 观众离房 → 宽限 SRS_ORPHAN_GRACE_MS 后再踢（信令抖一下、换 socket 回来时凭 key 认领，不打断画面）；
 *   · 主播重新推流 → 先踢旧上行再转发 WHIP；
 *   · 房间结束 → 全部踢掉。
 * 踢人失败（旧版本 SRS、会话早已结束）只是退回 SRS 自己的超时，不影响主流程。
 */
const SRS_ORPHAN_GRACE_MS = Number(process.env.LIVE_SRS_ORPHAN_GRACE_MS || 45_000)
const SRS_KICK_TIMEOUT_MS = 1_500
/** client_id 会拼进 API 路径；只收 SRS 自己生成的那种短 id，杜绝路径注入。 */
const SRS_CLIENT_ID = /^[A-Za-z0-9._:-]{1,96}$/

async function kickSrsClient(clientId) {
  const config = srsConfig()
  if (!config || typeof clientId !== 'string' || !SRS_CLIENT_ID.test(clientId)) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SRS_KICK_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.internalApi}/api/v1/clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
      signal: controller.signal,
    })
    await response.text().catch(() => '')
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** SRS 报告某个会话结束了：账上所有指向它的记录一并删掉，避免之后误踢同名的新会话。 */
function forgetSrsClient(room, clientId) {
  if (!clientId) return
  for (const [member, id] of room.srsPlayers) if (id === clientId) room.srsPlayers.delete(member)
  for (const [key, orphan] of room.srsOrphans) {
    if (orphan.clientId !== clientId) continue
    clearTimeout(orphan.timer)
    room.srsOrphans.delete(key)
  }
}

const srsOrphanKey = (memberId, viewerKey) => (viewerKey ? `key:${viewerKey}` : `member:${memberId}`)

/** 观众离开名单：它在 SRS 里的拉流先挂起，宽限期内同一个人（同一 key）回来就交还，不回来再踢。 */
function orphanSrsPlayer(room, memberId, viewerKey) {
  if (room.transport !== 'srs' || !room.srsPlayers) return
  const clientId = room.srsPlayers.get(memberId)
  if (!clientId) return
  room.srsPlayers.delete(memberId)
  const key = srsOrphanKey(memberId, viewerKey)
  const prior = room.srsOrphans.get(key)
  if (prior) {
    clearTimeout(prior.timer)
    if (prior.clientId !== clientId) void kickSrsClient(prior.clientId)
  }
  const timer = setTimeout(() => {
    if (room.srsOrphans.get(key)?.clientId !== clientId) return
    room.srsOrphans.delete(key)
    void kickSrsClient(clientId)
  }, SRS_ORPHAN_GRACE_MS)
  timer.unref?.()
  room.srsOrphans.set(key, { clientId, timer })
}

/** 同一个观众换了 socket 回来（名单里已经没有旧 id）：认领挂起的拉流，画面不断。 */
function reclaimSrsPlayer(room, memberId, viewerKey) {
  if (room.transport !== 'srs' || !room.srsPlayers || !viewerKey) return
  const key = srsOrphanKey(memberId, viewerKey)
  const orphan = room.srsOrphans.get(key)
  if (!orphan) return
  clearTimeout(orphan.timer)
  room.srsOrphans.delete(key)
  const current = room.srsPlayers.get(memberId)
  if (current && current !== orphan.clientId) void kickSrsClient(orphan.clientId)
  else room.srsPlayers.set(memberId, orphan.clientId)
}

/** 观众信令换了 socket、画面还连着（viewer-rebound）：账跟着人走，不踢。 */
function transferSrsPlayer(room, from, to) {
  if (room.transport !== 'srs' || !room.srsPlayers) return
  const clientId = room.srsPlayers.get(from)
  if (!clientId) return
  room.srsPlayers.delete(from)
  const existing = room.srsPlayers.get(to)
  if (existing && existing !== clientId) void kickSrsClient(existing)
  room.srsPlayers.set(to, clientId)
}

/** 房间结束：上行、所有拉流和挂起的拉流一起踢掉，不留给 SRS 慢慢超时。 */
function releaseSrsSessions(room) {
  if (room.transport !== 'srs' || !room.srsPlayers) return
  const ids = new Set()
  if (room.srsPublisherClient) ids.add(room.srsPublisherClient)
  for (const id of room.srsPlayers.values()) ids.add(id)
  for (const orphan of room.srsOrphans.values()) {
    clearTimeout(orphan.timer)
    ids.add(orphan.clientId)
  }
  room.srsPlayers.clear()
  room.srsOrphans.clear()
  room.srsPublisherClient = ''
  for (const id of ids) void kickSrsClient(id)
}

/**
 * SRS 回调只应来自本机（原生安装）或 Docker 网桥（compose 安装），而且不经过任何反代。
 * 走 nginx / Cloudflare / EdgeOne 进来的请求一定带转发头 —— 那条公网路径上即使有人拿到了 hook 密钥
 * （日志、配置备份泄露），也不能借它把任意房间标成「已推流」或绕过拉流授权。
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'eo-connecting-ip', 'true-client-ip', 'x-8bitgo-edge']
export function trustedSrsHookSource(req) {
  const headers = req?.headers || {}
  for (const name of PROXY_HEADERS) if (headers[name]) return false
  const address = req?.socket?.remoteAddress || req?.connection?.remoteAddress || ''
  return Boolean(address) && isPrivateIp(address)
}

/** 一张短票不能被反复兑换成无限个 SRS 会话；每个发布者 / 观众每分钟最多 8 次，且单飞。 */
function beginSrsNegotiation(key) {
  const now = Date.now()
  let state = srsNegotiations.get(key)
  if (!state || now - state.startedAt >= SRS_NEGOTIATION_WINDOW_MS) {
    state = { startedAt: now, count: 0, inFlight: false }
  }
  if (state.inFlight || state.count >= SRS_NEGOTIATION_LIMIT) return null
  state.count++
  state.inFlight = true
  srsNegotiations.set(key, state)
  return () => {
    if (srsNegotiations.get(key) === state) state.inFlight = false
  }
}

function clearSrsNegotiations(roomId) {
  const prefix = `${roomId}:`
  for (const key of srsNegotiations.keys()) if (key.startsWith(prefix)) srsNegotiations.delete(key)
}

/** 长房间里观众来来去去，过了窗口又不在途的计数没有任何作用，挂在幽灵扫描上顺手清。 */
function pruneSrsNegotiations(now = Date.now()) {
  for (const [key, state] of srsNegotiations) {
    if (!state.inFlight && now - state.startedAt >= SRS_NEGOTIATION_WINDOW_MS) srsNegotiations.delete(key)
  }
}

function clearSrsNegotiation(roomId, role, memberId) {
  srsNegotiations.delete(`${roomId}:${role}:${memberId}`)
}

function srsToken(config, claims, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs })).toString('base64url')
  const signature = createHmac('sha256', config.tokenSecret).update(body).digest('base64url')
  return `${body}.${signature}`
}

function verifySrsToken(config, token) {
  if (typeof token !== 'string' || token.length > 4096) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra) return null
  const expected = createHmac('sha256', config.tokenSecret).update(body).digest()
  let actual
  try {
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!claims || !Number.isFinite(claims.exp) || claims.exp <= Date.now()) return null
    return claims
  } catch {
    return null
  }
}

function srsGrant(room, role, memberId = '') {
  const config = srsConfig()
  if (!config || room.transport !== 'srs') return null
  return srsToken(config, { roomId: room.id, stream: room.srsStream, role, ...(memberId ? { memberId } : {}) }, role === 'publish' ? 8 * 60 * 60_000 : 2 * 60_000)
}

function srsHostAck(room) {
  return {
    roomId: room.id,
    token: room.token,
    transport: room.transport,
    ...(room.transport === 'srs' ? { srsGrant: srsGrant(room, 'publish', room.hostSocketId || '') } : {}),
  }
}

/**
 * 续播的确认：srsHostAck + 观众名单。
 * `viewers` 仍是**全部**成员（老版本主播拿它的长度当人数，决定要不要推 SRS 上行；少算会把唯一一路上行停掉），
 * `streamViewers` 单独列出其中的事件流观众：新版本主播只给剩下的人建 2P 协作连接 —— 事件流观众没有 socket，
 * 给它们发 offer 只会占满协作连接的名额。
 */
function hostResumeAck(room) {
  const viewers = Array.from(room.viewers)
  return { ...srsHostAck(room), viewers, streamViewers: viewers.filter(isStreamViewer) }
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/**
 * 一条纯联机弹幕房多久没人就可以回收。
 *
 * 比 MEMBER_TTL 那类值大得多是故意的：玩家断线重连、页面刷新都会让 players
 * 短暂归零，回收得太快会把人家正在聊的历史清掉。一天足够长，又足够短到
 * 让「开一晚上直播」留下的僵尸记录第二天就没了。
 */
const MATCH_CHAT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 回收纯联机弹幕房。
 *
 * 判据是「**没人**」或者「**够久没动静**」，两个都要：
 *   · 只看没人 —— 主播绑走之后那条记录 players 永远空着，本该立刻回收；
 *   · 只看时间 —— 正在聊的房间会被误删。
 * 挂在 ghostTimer 上跑（见文件末尾），不另起一个定时器。
 */
function sweepMatchChats(now = Date.now()) {
  for (const [key, match] of matchChats) {
    if (match.players.size > 0 && now - (match.lastAt ?? 0) < MATCH_CHAT_TTL_MS) continue
    matchChats.delete(key)
  }
}

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
    maxViewers: room.transport === 'srs' ? MAX_SRS_VIEWERS : MAX_VIEWERS,
    transport: room.transport || 'p2p',
    srsReady: Boolean(room.srsReady),
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
/**
 * 名单最多带这么多人。SRS 房能到上百人，每次有人进出都把整份名单发给房里每一个人是 O(N²) 的流量：
 * 100 人的房一阵进场潮就是几十 MB 的 Socket.IO 下行，弱网观众的信令先被它挤爆。
 * 人数（count）始终是准的，名单只是给面板显示用。
 */
const VIEWER_LIST_MAX = 100
/** 进出场潮里的人数广播合并成一次；主播开推流晚这么一点没有感知。 */
const VIEWERS_NOTIFY_MS = 100

function viewerList(room) {
  const out = []
  for (const id of room.viewers) {
    if (out.length >= VIEWER_LIST_MAX) break
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
function resolveViewerName(nsp, room, socket, findUser = queryOne) {
  const viewerId = socket.id
  void chatIdentity(socket, findUser)
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
  if (room.viewersTimer) return
  room.viewersTimer = setTimeout(() => {
    room.viewersTimer = null
    if (rooms.get(room.id) !== room) return
    // count 保持原样单独给：观众席徽章只要这一个数，不该为了它去数数组。名单在发出那一刻现算
    toRoom(nsp, room.id, 'viewers', { roomId: room.id, count: room.viewers.size, list: viewerList(room) })
    // 人数变了 = 大厅那张卡片上的「N 人在看」也变了
    notifyRoomList()
  }, VIEWERS_NOTIFY_MS)
  room.viewersTimer.unref?.()
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
/** 幽灵房扫描的计时器（见 GHOST_SWEEP_MS）。全局一个：这个清扫和具体 nsp 无关，但只需要一份 */
let ghostTimer = null

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
        if (!sseWrite(watcher.res, `event: rooms\ndata: ${json}\n\n`)) listWatchers.delete(watcher)
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
    if (!sseWrite(res, `event: rooms\ndata: ${json}\n\n`)) listWatchers.delete(watcher)
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
  if (room.closed) return
  // 散场期间给事件流写 live-ended 可能写失败，失败那位的离场处理（leaveStream）不能再回头收这间房
  room.closed = true
  if (room.awayTimer) clearTimeout(room.awayTimer)
  room.awayTimer = null
  if (room.viewersTimer) clearTimeout(room.viewersTimer)
  room.viewersTimer = null
  clearFrozenTimers(room)
  if (room.srsStream && srsRooms.get(room.srsStream) === room) srsRooms.delete(room.srsStream)
  releaseSrsSessions(room)
  toRoom(nsp, room.id, 'live-ended', { roomId: room.id, reason })
  // 事件流观众：上面那帧已经写出去了，这里把连接收掉（名单随房间一起没，不走 leaveStream）
  for (const viewer of [...(roomStreams.get(room.id) ?? [])]) detachStream(viewer)
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
  // 散场时把这条直播绑过的联机弹幕房一起收掉：房间都没了，那段历史没人再看得到
  if (room.netplayRoomId) matchChats.delete(matchChatKey(resolveRoomId(room.netplayRoomId)))
  clearSrsNegotiations(room.id)
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
  if (hadNetplay) toRoom(nsp, room.id, 'netplay-linked', { roomId: null })
  room.awaySince = Date.now()
  if (room.awayTimer) clearTimeout(room.awayTimer)
  room.awayTimer = setTimeout(() => {
    // 期间可能已经被接回去又再断开，或者被 stop-live 关掉 —— 只有还是「不在」才散场
    const cur = rooms.get(room.id)
    if (cur && cur.hostSocketId === null) closeRoom(nsp, cur, 'host-left')
  }, RESUME_GRACE_MS)
  toRoom(nsp, room.id, 'host-away', { roomId: room.id })
  notifyRoomList()
}

/**
 * 挑出「主播 socket 已经不在线」的房间。**纯函数**：只分类、不处理，便于单测
 * （`server/scripts/test-live.mjs` 里直接喂构造出来的房间，不需要真的把服务端跑成漂移态）。
 *
 * 两类房间**不算**幽灵：
 *   · `hostSocketId` 为空 —— 那是已经走过 `hostAway()` 的房，`awayTimer` 在管它；
 *   · 记着的 socket 还在 —— 正常在播。
 *
 * ⚠️ 判据是「socket 还在不在 nsp.sockets 里」，而不是「membership 怎么说」：
 * 这个函数存在的全部理由就是 membership 和 rooms 漂开之后兜底（见 GHOST_SWEEP_MS 的注释）。
 *
 * @param {Iterable<object>} roomList
 * @param {(socketId: string) => boolean} hostAlive
 */
export function ghostRooms(roomList, hostAlive) {
  const ghosts = []
  for (const room of roomList) {
    if (!room.hostSocketId) continue
    if (hostAlive(room.hostSocketId)) continue
    ghosts.push(room)
  }
  return ghosts
}

/**
 * 名单里 socket 已经不在线的观众 / 联机弹幕成员（判据同 ghostRooms：只认 nsp.sockets 这个事实）。
 *
 * 正常断线由 leave() 清掉；漏网的来源是「await 期间断线又被加回名单」这一类竞态。
 * 幽灵观众占着席位、虚报人数，还会让「主播后台 + 零观众」的收房闹钟永远不响 ——
 * 而以前的扫描只看主播，它们能挂到房间散场为止。
 */
export function ghostViewers(room, alive) {
  const dead = []
  for (const id of room.viewers) if (!alive(id)) dead.push(id)
  return dead
}

function sweepGhostViewers(nsp, room) {
  // 事件流观众没有 socket：它的「还活着」就是那条流还登记着（流一断 leaveStream 会把它摘掉）
  const alive = (id) => nsp.sockets.has(id) || isStreamViewer(id)
  for (const id of [...room.matchPlayers]) {
    if (alive(id)) continue
    room.matchPlayers.delete(id)
    if (membership.get(id)?.roomId === room.id) membership.delete(id)
  }
  const dead = ghostViewers(room, alive)
  if (!dead.length) return
  for (const id of dead) {
    if (room.srsPlayers) orphanSrsPlayer(room, id, room.viewerKeys.get(id))
    room.viewers.delete(id)
    room.viewerKeys.delete(id)
    room.viewerNames.delete(id)
    if (membership.get(id)?.roomId === room.id) membership.delete(id)
    if (room.hostSocketId) nsp.to(room.hostSocketId).emit('viewer-left', { viewerId: id })
  }
  if (!room.hostSocketId && room.viewers.size === 0) {
    closeRoom(nsp, room, 'host-left')
    return
  }
  if (room.hostFrozen) scheduleFrozenClose(nsp, room)
  notifyViewers(nsp, room)
}

/**
 * 收掉这个 socket 名下的房间：**没人看直接散、有人看走宽限期**（和断线同一条规则）。
 * 只按 `hostSocketId` 找，不看 membership —— 理由同 ghostRooms。
 */
function releaseHostedRooms(nsp, socketId, reason = 'host-left') {
  for (const room of [...rooms.values()]) {
    if (room.hostSocketId !== socketId) continue
    if (room.viewers.size === 0) closeRoom(nsp, room, reason)
    else hostAway(nsp, room)
  }
}

/** 把房间交给一个（新的）主播 socket */
function bindHost(nsp, room, socket) {
  /*
    ⚠️ 一个 socket 同时只能当**一间**房的主播，多出来的那间在这里关掉。

    房间的清理全靠 `membership`（socket.id → 一个 roomId，**一条**）：一个 socket 挂着
    两间房时，`stop-live` / `host-visibility` / 断线都只会动 membership 指的那一间，
    另一间从此收不到任何事件 —— 就是「幽灵房」的来源。放在这里而不是 `go-live` 里，
    是因为 `resume-live` 也走这个函数，两个入口都要挡。
    正常路径上这里扫不到东西（不带例外的那间本来就不该存在），留着是为了漂移之后能自愈。
  */
  for (const other of [...rooms.values()]) {
    if (other === room || other.hostSocketId !== socket.id) continue
    closeRoom(nsp, other, 'restarted')
  }
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
  /*
    ⚠️ 先按「这个 socket 是哪几间房的主播」扫一遍，**不能只认下面那条 membership**。

    membership 每个 socket 只有一条（socket.id → 一个 roomId）。一旦它和 `rooms` 漂开
    —— 2026-09-20 线上那间挂到浏览器都被关掉还在的房就是这样 —— 这里会走到
    `if (!info) return` 或 `room.hostSocketId !== socket.id` 而直接返回，
    那间房的 `hostSocketId` 就永远指着一个死掉的 socket：`hostAway` 算不出 true，
    宽限期、冻结计时、收房全都不生效，它就一直留在大厅里。

    这一句是「按事实核一遍」：房间记着的 hostSocketId 就是自己，那就是自己该收的房。
    正常断线时它顺手就把下面那条路径要做的事做完了（下面接着走也不会重复处理：
    房已经散了就 return，走宽限期的 hostSocketId 已经是 null）。
  */
  releaseHostedRooms(nsp, socket.id)
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
  clearSrsNegotiation(room.id, info.role === 'host' ? 'publish' : 'play', socket.id)


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
  removeViewer(nsp, room, socket.id)
}

/**
 * 一位观众（socket 观众或事件流观众）离开名单。调用方负责先把 membership 删掉。
 */
function removeViewer(nsp, room, viewerId) {
  // 离房观众在 SRS 里的拉流不能留着白占出口带宽；先挂起，换连接回来时凭 key 认领
  orphanSrsPlayer(room, viewerId, room.viewerKeys.get(viewerId))
  room.viewers.delete(viewerId)
  room.viewerKeys.delete(viewerId)
  room.viewerNames.delete(viewerId)
  // 告诉主播可以把这条 PeerConnection 拆了，别留着占上行（事件流观众没有，主播那边是空操作）
  if (room.hostSocketId) {
    nsp.to(room.hostSocketId).emit('viewer-left', { viewerId })
    // 最后一个观众走了、主播还在后台：上收房的闹钟
    if (room.hostFrozen) scheduleFrozenClose(nsp, room)
  } else if (room.viewers.size === 0) {
    // 主播不在、最后一个观众也走了：这房间已经没有任何人需要它，别再占着宽限期
    closeRoom(nsp, room, 'host-left')
    return
  }
  notifyViewers(nsp, room)
}

/** 事件流断开 = 这位观众走了（和 socket 断线同一条规则：SRS 拉流先挂起，宽限期内同一把 key 回来就认领） */
function leaveStream(nsp, viewer) {
  if (viewer.closed) return
  const room = rooms.get(viewer.roomId)
  detachStream(viewer)
  if (membership.get(viewer.id)?.roomId === viewer.roomId) membership.delete(viewer.id)
  // 名单已经转给同一个人的新连接（事件流重连 / 升级成 socket），或者房间正在散场：这里什么都不用做
  if (!room || room.closed || !room.viewers.has(viewer.id)) return
  clearSrsNegotiation(room.id, 'play', viewer.id)
  removeViewer(nsp, room, viewer.id)
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
  const findGame = options.findGame || ((slug) => queryOne('SELECT slug, adult, hidden FROM games WHERE slug = ? LIMIT 1', [slug]))
  // 和 findUser / findGame 同理：测试可以不起整套联机服务，只替换「是不是那间联机房的玩家」这一问
  const netplayPlayer = options.isNetplayPlayer || isNetplayPlayer
  const nsp = io.of('/live')

  const srsExchange = async (req, res) => {
    const config = srsConfig()
    if (!config) return res.status(503).json({ error: 'SRS live is not configured' })
    const mode = req.params?.mode === 'publish' ? 'publish' : req.params?.mode === 'play' ? 'play' : ''
    if (!mode) return res.status(404).json({ error: 'not found' })
    const roomId = str(req.body?.roomId, 64)
    const grant = str(req.body?.grant, 4096)
    const sdp = typeof req.body?.sdp === 'string' ? req.body.sdp : ''
    // ICE 完整 SDP 通常远小于 256KB；拒绝超大正文，避免握手代理成为内存放大入口。
    // 不是 SDP 的正文也不转给 SRS：它的解析器是 C++ 写的，没必要把任意字节送进去。
    if (!roomId || !grant || !sdp || sdp.length > 256_000 || !/^v=0\r?\n/.test(sdp)) return res.status(400).json({ error: 'invalid request' })
    const claims = verifySrsToken(config, grant)
    const role = mode === 'publish' ? 'publish' : 'play'
    const room = rooms.get(roomId)
    if (!claims || claims.roomId !== roomId || claims.role !== role || !room || room.transport !== 'srs' || claims.stream !== room.srsStream) {
      return res.status(403).json({ error: 'invalid or expired SRS grant' })
    }
    if (!claims.memberId) return res.status(403).json({ error: 'grant is not bound to a room member' })
    if (mode === 'publish' && room.hostSocketId !== claims.memberId) {
      return res.status(403).json({ error: 'publisher is no longer the room host' })
    }
    if (mode === 'play' && (!claims.memberId || !room.viewers.has(claims.memberId) || membership.get(claims.memberId)?.roomId !== roomId)) {
      return res.status(403).json({ error: 'viewer is no longer in this room' })
    }
    if (mode === 'play' && !room.srsReady) return res.status(409).json({ error: 'SRS publisher is not ready' })
    const finishNegotiation = beginSrsNegotiation(`${roomId}:${role}:${claims.memberId}`)
    if (!finishNegotiation) return res.status(429).json({ error: 'too many SRS negotiations' })
    let timer = null
    try {
      /*
        主播重新推流（网络切换、PeerConnection failed 之后重建）时，SRS 往往还认为旧上行活着，
        要等 stun_timeout（默认 30 秒）才放手；这期间新的 WHIP 只会拿到 stream busy，全房黑屏半分钟以上。
        只有当前主播能走到这里（上面已核对 memberId），所以踢掉旧上行不会误伤别人。
      */
      if (mode === 'publish' && room.srsPublisherClient) {
        const kicked = await kickSrsClient(room.srsPublisherClient)
        // SRS 在下一轮协程里才真正回收旧会话；稍等一下，免得新 WHIP 正好撞上还没释放的流
        if (kicked) await new Promise((resolve) => setTimeout(resolve, 150))
        if (rooms.get(roomId) !== room || room.hostSocketId !== claims.memberId) {
          return res.status(403).json({ error: 'room membership changed during negotiation' })
        }
      }
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), 12_000)
      const endpoint = mode === 'publish' ? 'whip' : 'whep'
      const url = new URL(`${config.internalApi}/rtc/v1/${endpoint}/`)
      url.searchParams.set('app', 'live')
      url.searchParams.set('stream', room.srsStream)
      url.searchParams.set('token', grant)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp', accept: 'application/sdp' },
        body: sdp,
        signal: controller.signal,
      })
      const answer = await response.text().catch(() => '')
      if (!response.ok || !answer.trimStart().startsWith('v=0')) {
        console.warn(`[live] SRS ${mode} 协商失败：HTTP ${response.status}`)
        return res.status(502).json({ error: 'SRS negotiation failed' })
      }
      // SDP 往返期间观众可能离房、房主可能被接管；迟到的成功响应也不能再发给旧成员。
      if (rooms.get(roomId) !== room || (mode === 'publish'
          ? room.hostSocketId !== claims.memberId
          : !room.viewers.has(claims.memberId) || membership.get(claims.memberId)?.roomId !== roomId)) {
        return res.status(403).json({ error: 'room membership changed during negotiation' })
      }
      return res.json({ sdp: answer })
    } catch (error) {
      console.warn(`[live] SRS ${mode} API 不可用：`, error?.name || error?.message || error)
      return res.status(502).json({ error: 'SRS service unavailable' })
    } finally {
      if (timer) clearTimeout(timer)
      finishNegotiation()
    }
  }

  const srsHook = (req, res) => {
    const config = srsConfig()
    if (!config) return res.status(503).send('SRS disabled')
    if (!trustedSrsHookSource(req)) return res.status(403).send('forbidden')
    if (!sameSecret(req.query?.key, config.hookSecret)) return res.status(403).send('forbidden')
    const action = str(req.body?.action, 40)
    const stream = str(req.body?.stream, 160)
    const clientId = str(req.body?.client_id, 128)
    const app = str(req.body?.app, 64)
    // 我们只往 live 这个 app 推拉流；别的 app 下同名流不属于任何房间
    if (app && app !== 'live') return res.status(404).send('unknown app')
    const room = srsRooms.get(stream)
    if (!room || rooms.get(room.id) !== room || room.transport !== 'srs') return res.status(404).send('unknown stream')
    if (action === 'on_publish' || action === 'on_play') {
      let token = ''
      const param = typeof req.body?.param === 'string' ? req.body.param : ''
      try {
        token = new URL(param, 'http://srs.invalid').searchParams.get('token') || new URLSearchParams(param.replace(/^\?/, '')).get('token') || ''
      } catch {
        token = ''
      }
      const claims = verifySrsToken(config, token)
      const role = action === 'on_publish' ? 'publish' : 'play'
      if (!claims || claims.roomId !== room.id || claims.stream !== room.srsStream || claims.role !== role) {
        return res.status(403).send('invalid grant')
      }
      if (role === 'publish' && (!claims.memberId || room.hostSocketId !== claims.memberId)) {
        return res.status(403).send('publisher is no longer the room host')
      }
      if (role === 'play' && (!claims.memberId || !room.viewers.has(claims.memberId) || membership.get(claims.memberId)?.roomId !== room.id)) {
        return res.status(403).send('viewer is no longer in this room')
      }
      if (action === 'on_play' && !room.srsReady) return res.status(403).send('publisher not ready')
      // client_id 要拼进踢人 API 的路径，格式不对的一律拒绝；SRS 没给 id 时照常放行，只是记不了账
      if (clientId && !SRS_CLIENT_ID.test(clientId)) return res.status(403).send('invalid client')
      if (action === 'on_publish') {
        const previousClient = room.srsPublisherClient
        // 正常情况下 WHIP 代理已经先踢过旧上行；这里兜底「旧上行的 unpublish 还没到」的那种时序
        if (clientId && previousClient && previousClient !== clientId) void kickSrsClient(previousClient)
        room.srsPublisherClient = clientId
        const wasReady = room.srsReady
        room.srsReady = true
        /*
          换了一路上行也要再广播一次 ready：观众手里的拉流如果已经因为断流死掉，凭这一条立刻重拉；
          还活着的拉流（SRS 会把新上行接到已有的消费者上）在客户端会被忽略，不会白白重建。
        */
        if (!wasReady || previousClient !== clientId) toRoom(nsp, room.id, 'srs-state', { ready: true })
        if (!wasReady) notifyRoomList()
      } else {
        // 每位观众在 SRS 里只留最新的一路：同一成员又开了一路，就踢掉旧的
        const prior = room.srsPlayers.get(claims.memberId)
        if (clientId && prior && prior !== clientId) void kickSrsClient(prior)
        if (clientId) room.srsPlayers.set(claims.memberId, clientId)
        const key = room.viewerKeys.get(claims.memberId)
        const orphanKey = key ? srsOrphanKey(claims.memberId, key) : ''
        const orphan = orphanKey ? room.srsOrphans.get(orphanKey) : null
        if (clientId && orphan && orphan.clientId !== clientId) {
          clearTimeout(orphan.timer)
          room.srsOrphans.delete(orphanKey)
          void kickSrsClient(orphan.clientId)
        }
      }
    } else if (action === 'on_unpublish') {
      if (room.srsReady && clientId && room.srsPublisherClient === clientId) {
        room.srsReady = false
        room.srsPublisherClient = ''
        toRoom(nsp, room.id, 'srs-state', { ready: false })
        notifyRoomList()
      }
    } else if (action === 'on_stop') {
      forgetSrsClient(room, clientId)
    }
    return res.status(200).send('0')
  }

  /* ---------------- 事件流观众的 HTTP 入口（见文件前面「不走 socket.io 的 SRS 观众」） ---------------- */

  /** Authorization 头里的站内 JWT（可选）。只用于成人房年龄核对和弹幕署名，验不过就当游客 */
  const bearerToken = (req) => {
    const header = typeof req.headers?.authorization === 'string' ? req.headers.authorization : ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    return match ? str(match[1], 512) : ''
  }

  /**
   * 进房，响应体是这位观众的事件流。第一帧 `welcome` 带房间快照、最近弹幕、名单、播放票和会话令牌；
   * 之后是 viewers / chat / srs-state / host-frozen / host-away / host-back / netplay-linked / coop / no-source / live-ended，
   * 被同一把 key 的新连接取代时收到 `replaced`，每 SSE_HEARTBEAT_MS 一帧 ping。
   *
   * 拒绝都在开流之前用普通 JSON 回（带 code，客户端据此决定报错还是退回 socket）：
   *   404 room-not-found / 409 p2p-room（老的点对点房只能走 socket）/ 409 full / 403 adult。
   */
  const streamWatch = async (req, res) => {
    const roomId = str(req.params?.roomId, 64)
    const room = rooms.get(roomId)
    if (!room) return res.status(404).json({ error: 'not found', code: 'room-not-found' })
    if (room.transport !== 'srs') return res.status(409).json({ error: 'p2p room', code: 'p2p-room' })
    const key = str(req.body?.key, 64)
    const id = `${STREAM_ID_PREFIX}${randomBytes(12).toString('base64url')}`
    const sock = streamPseudoSocket(id, bearerToken(req))
    if (room.adult) {
      try {
        const accessError = adultLiveAccessError(await liveAccount(sock, findUser))
        if (accessError) return res.status(403).json({ error: accessError, code: 'adult' })
      } catch (e) {
        console.warn('[live] 观看权限检查失败：', e)
        return res.status(500).json({ error: 'failed' })
      }
      // 查账号期间浏览器已经走了 / 房间已经散了：不能再登记一个永远不会走的观众
      if (res.destroyed || res.writableEnded || req.socket?.destroyed) return
      if (rooms.get(room.id) !== room || room.closed) return res.status(404).json({ error: 'not found', code: 'room-not-found' })
    }

    // 同一把 key 的上一条连接（事件流重连）：不占人数、不被自己挤出满员的房间，SRS 拉流记到新 id 名下
    let previous = null
    if (key) {
      for (const [viewerId, viewerKey] of room.viewerKeys) {
        if (viewerKey === key && viewerId !== id) {
          previous = viewerId
          break
        }
      }
    }
    if (!previous && room.viewers.size >= MAX_SRS_VIEWERS) return res.status(409).json({ error: 'full', code: 'full' })
    if (!previous && activeSrsViewerCount() >= MAX_SRS_TOTAL_VIEWERS) return res.status(409).json({ error: 'server full', code: 'full' })

    // 准入闸：爬虫、per-IP / 总量上限、最长寿命。通过后响应头已经写好，从这里起是事件流
    if (!admitSse(req, res)) return

    if (previous) {
      transferSrsPlayer(room, previous, id)
      clearSrsNegotiation(room.id, 'play', previous)
      room.viewers.delete(previous)
      room.viewerKeys.delete(previous)
      room.viewerNames.delete(previous)
      membership.delete(previous)
      const oldStream = streamViewers.get(previous)
      if (oldStream) detachStream(oldStream, 'replaced', {})
      else {
        // 上一条是 socket（客户端不会从 socket 降回事件流，这里只是兜底）：请它离开，主播拆掉那条协作连接
        nsp.sockets.get(previous)?.leave(room.id)
        if (room.hostSocketId) nsp.to(room.hostSocketId).emit('viewer-left', { viewerId: previous })
      }
    }

    const viewer = {
      id,
      session: randomBytes(24).toString('base64url'),
      roomId: room.id,
      res,
      sock,
      closed: false,
      beat: null,
      nudgeAt: 0,
    }
    streamViewers.set(id, viewer)
    streamSessions.set(viewer.session, viewer)
    let set = roomStreams.get(room.id)
    if (!set) {
      set = new Set()
      roomStreams.set(room.id, set)
    }
    set.add(viewer)
    room.viewers.add(id)
    if (key) room.viewerKeys.set(id, key)
    // 上一条连接的断开比这一次进房先到：拉流正挂在宽限期里，凭 key 认领回来
    if (!previous) reclaimSrsPlayer(room, id, key)
    membership.set(id, { roomId: room.id, role: 'viewer' })
    if (room.hostFrozen) scheduleFrozenClose(nsp, room)
    res.once('close', () => leaveStream(nsp, viewer))

    const welcome = {
      ...publicRoom(room),
      session: viewer.session,
      chat: room.chat,
      list: viewerList(room),
      rebound: Boolean(previous),
      srsGrant: srsGrant(room, 'play', id),
    }
    if (!writeStream(viewer, 'welcome', welcome)) {
      leaveStream(nsp, viewer)
      return
    }
    viewer.beat = setInterval(() => {
      if (viewer.closed) return
      try {
        if (sseWrite(res, SSE_HEARTBEAT_FRAME)) return
      } catch {
        /* 下面统一离场 */
      }
      leaveStream(nsp, viewer)
    }, SSE_HEARTBEAT_MS)
    viewer.beat.unref?.()
    resolveViewerName(nsp, room, sock, findUser)
    // 换连接不算人数变化：一个人还是一个人
    if (!previous) notifyViewers(nsp, room)
  }

  /** 请求体里的会话令牌 → 这间房当前名单上的事件流观众 */
  const streamMember = (req) => {
    const roomId = str(req.params?.roomId, 64)
    const viewer = streamSessions.get(str(req.body?.session, 64))
    if (!viewer || viewer.closed || viewer.roomId !== roomId) return null
    const room = rooms.get(roomId)
    if (!room || room.closed || !room.viewers.has(viewer.id) || room.transport !== 'srs') return null
    return { viewer, room }
  }

  /** 续一张 SRS 播放票（同 socket 的 srs-play-grant：拉流断了要重拉时用，不惊动主播） */
  const streamGrant = (req, res) => {
    const found = streamMember(req)
    if (!found) return res.status(404).json({ error: 'not a viewer', code: 'session' })
    const { viewer, room } = found
    if (!takeSignalToken(viewer.sock, { candidate: true }, 'viewer')) return res.status(429).json({ error: 'rate limited' })
    res.json({ srsGrant: srsGrant(room, 'play', viewer.id), srsReady: Boolean(room.srsReady) })
  }

  /**
   * 催一下主播：把人数和名单再发给主播一次。主播收到 `viewers` 会检查自己那一路 SRS 上行，没在推就开推
   * —— 和 socket 观众「重新 watch 一次」催主播是同一个效果，只是不让主播重建协作连接。
   */
  const streamNudge = (req, res) => {
    const found = streamMember(req)
    if (!found) return res.status(404).json({ error: 'not a viewer', code: 'session' })
    const { viewer, room } = found
    const now = Date.now()
    if (now - viewer.nudgeAt < STREAM_NUDGE_MIN_MS) return res.status(429).json({ error: 'rate limited' })
    viewer.nudgeAt = now
    if (room.hostSocketId) {
      nsp.to(room.hostSocketId).emit('viewers', { roomId: room.id, count: room.viewers.size, list: viewerList(room) })
    }
    res.status(204).end()
  }

  /**
   * 发一条弹幕。规则与 socket 的 chat 完全一致（同一套清洗、两道限流、服务端派生署名），
   * 回包用同一组 ack 码，客户端用 chatSendOutcome 统一翻译。房间号只认会话令牌，不收请求里的。
   */
  const streamChat = (req, res) => {
    const found = streamMember(req)
    if (!found) return res.json({ error: CHAT_ACK_NO_ROOM })
    const { viewer, room } = found
    const text = sanitizeChatText(req.body?.text)
    if (!text) return res.json({ error: CHAT_ACK_EMPTY })
    // 中途登录 / 退出：署名跟着这一次请求的令牌走，旧缓存作废
    const token = bearerToken(req)
    if (token !== viewer.sock.handshake.auth.token) {
      viewer.sock.handshake.auth.token = token
      delete viewer.sock.data.chatIdentity
    }
    if (!takeChatToken(viewer.sock)) return res.json({ error: CHAT_ACK_TOO_FAST })
    if (!takeRoomChatToken(room)) return res.json({ error: CHAT_ACK_TOO_FAST })
    void chatIdentity(viewer.sock, findUser).then((identity) => {
      if (rooms.get(room.id) !== room || room.closed || viewer.closed || !room.viewers.has(viewer.id)) {
        return res.json({ error: CHAT_ACK_NO_ROOM })
      }
      const msg = { id: randomBytes(8).toString('base64url'), at: Date.now(), ...identity, host: false, text }
      room.chat.push(msg)
      if (room.chat.length > CHAT_HISTORY_SIZE) room.chat.splice(0, room.chat.length - CHAT_HISTORY_SIZE)
      toRoom(nsp, room.id, 'chat', msg)
      res.json({ id: msg.id })
    }).catch((e) => {
      console.warn('[live] 弹幕广播失败：', e)
      if (!res.headersSent) res.json({ error: CHAT_ACK_FAILED })
    })
  }

  /**
   * 不带 publisherToken 的网页主播和普通观众保持原样；带了就必须验过，不能失败后悄悄
   * 降级成匿名主播。正式设备客户端据 connect_error.data.code 区分过期和服务未配置。
   */
  nsp.use((socket, next) => {
    const token = publisherTokenOf(socket)
    if (!token) return next()
    const cfg = openConfig()
    if (!cfg) return next(publisherAuthError('publisher authorization unavailable', 'publisher_auth_unavailable'))
    const claims = livePublisherModule.verifyLivePublisherToken(token, { publicKey: cfg.publicKey, issuer: cfg.issuer })
    if (!claims) return next(publisherAuthError('invalid or expired publisher token', 'invalid_publisher_token'))
    socket.data.livePublisher = claims
    next()
  })

  nsp.on('connection', (socket) => {
    // 客户端能在 ack 位置塞非函数值，同步 handler 抛错会打挂整个进程，见 socket-guard.js
    guardSocketArgs(socket)
    /**
     * 客户端的 ack 可能在网络切换时丢掉，而服务端其实已经完成了开播/续播。
     * 同一条 socket 再问时要把原结果补回去，不能只回 already in a room ——
     * 后者没有 roomId/token/观众名单，客户端从此既不能继续也不能恢复。
     */
    const boundHostRoom = () => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return null
      const room = rooms.get(info.roomId)
      return room?.hostSocketId === socket.id ? room : null
    }

    // 发布票可能活 12 小时，不能只在握手 / 开播时检查一次。单条发布连接每 15 秒复核；
    // liveAccount 自带 30 秒缓存，所以数据库最多每 30 秒查一次。停用应用、封号或退出所有设备后，
    // 现有直播也会在半分钟内关掉。计时器绑在 socket 生命周期上，不随 go-live / stop-live 累积。
    if (socket.data?.livePublisher) {
      const publisherCheck = setInterval(() => {
        void liveAccount(socket, findUser).then((account) => {
          if (account || !socket.connected) return
          const room = boundHostRoom()
          if (room) closeRoom(nsp, room, 'publisher-revoked')
          socket.disconnect(true)
        }).catch((error) => {
          // 数据库短暂不可用时保留连接，下一轮重试；可读到停用状态时上面的路径会立即收房。
          console.warn('[live] 定期复核发布凭证失败：', error?.message || error)
        })
      }, 15_000)
      publisherCheck.unref?.()
      socket.once('disconnect', () => clearInterval(publisherCheck))
    }

    socket.on('go-live', async (payload, ack) => {
      const existing = boundHostRoom()
      if (existing) return ack?.(null, srsHostAck(existing))
      if (membership.has(socket.id)) return ack?.('already in a room')
      if (socket.data.liveOpening) return ack?.('already opening a room')
      if (!takeOpenToken(socket)) return ack?.('rate limited')
      socket.data.liveOpening = true
      try {
        const requestedSlug = str(payload?.gameSlug, 120)
        /*
          成人位只能来自数据库，不能采信 payload.adult。gameSlug 也是客户端给的，所以：
            · 空 slug / `local:` 开头：玩家自己的本地 ROM，库里没有这款游戏，按普通直播处理；
            · 其余 slug 必须对上一款**存在且未下架**的游戏，否则拒绝。以前查不到就当「非成人」放行，
              主播把成人游戏的 slug 改成一串不存在的字符就能绕过年龄门、出现在公开大厅；
            · 房间里存数据库返回的规范 slug，大小写变体（MySQL 排序规则不区分大小写）不会混进来。
          ⚠️ 剩下的口子：服务端看不到画面内容。网页端在本地 ROM 页（local:）或另一款普通游戏的页面上
          推一路成人画面，这里无从分辨 —— 年龄门约束的是「本站标成成人的游戏」，不是画面审核。
        */
        let gameSlug = ''
        let adult = false
        if (requestedSlug && !requestedSlug.startsWith('local:')) {
          const game = await findGame(requestedSlug)
          if (!game || dbFlag(game.hidden)) return ack?.('unknown game')
          gameSlug = typeof game.slug === 'string' && game.slug ? game.slug : requestedSlug
          adult = dbFlag(game.adult)
        } else {
          gameSlug = requestedSlug
        }
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

        /*
          ⚠️ await 期间这条连接可能已经断了（关标签页 / 网络切换）。disconnect 那一刻 leave()
          什么都没找到，这里再 rooms.set + bindHost 就是给一个死 socket 开房：大厅挂着一张
          hostAway:false 的空卡，socket.join 还会把死 id 写进 adapter 永远不删（closeRoom 只能
          通过 nsp.sockets 找到活连接去 leave）。反复「连上 → go-live → 断开」能让内存无界增长。
        */
        if (!socket.connected) return ack?.('disconnected')
        // 查用户期间同一条连接可能被别的事件放进房间；await 后必须再确认一次。
        const opened = boundHostRoom()
        if (opened) return ack?.(null, srsHostAck(opened))
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

        // 健康检查有一个短 await 窗口；重新核实 socket、房间和 IP 配额，避免并发开播挤过容量闸。
        const srsRequired = srsRequested() || srsMandatory()
        const useSrs = srsRequested() ? await srsServiceAvailable() : false
        if (!socket.connected) return ack?.('disconnected')
        const openedAfterProbe = boundHostRoom()
        if (openedAfterProbe) return ack?.(null, srsHostAck(openedAfterProbe))
        if (membership.has(socket.id)) return ack?.('already in a room')
        // 生产显式启用 SRS 时不能静默退回主播直连；否则观众一多，上行仍按人数放大。
        if (srsRequired && !useSrs) return ack?.('SRS service unavailable')
        if (rooms.size >= MAX_ROOMS) return ack?.('server is full')
        if (ip && !isPrivateIp(ip) && MAX_ROOMS_PER_IP > 0) {
          let mine = 0
          for (const r of rooms.values()) if (r.hostIp === ip) mine++
          if (mine >= MAX_ROOMS_PER_IP) return ack?.('too many rooms')
        }

        const id = randomBytes(9).toString('base64url')
        const room = {
          id,
          // 续播凭证：主播断线重连后凭它 resume-live。观众看不到（publicRoom 不带它）
          token: randomBytes(24).toString('base64url'),
          transport: useSrs ? 'srs' : 'p2p',
          srsStream: randomBytes(18).toString('base64url'),
          srsReady: false,
          srsPublisherClient: '',
          /** 成员 socket.id → 它在 SRS 里的拉流 client_id（见 kickSrsClient 那段注释） */
          srsPlayers: new Map(),
          /** 已离房、宽限期内等认领的拉流：`key:<观众 key>` → { clientId, timer } */
          srsOrphans: new Map(),
          /** 合并人数广播的计时器（见 notifyViewers） */
          viewersTimer: null,
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
        if (room.transport === 'srs') srsRooms.set(room.srsStream, room)
        bindHost(nsp, room, socket)
        ack?.(null, srsHostAck(room))
      } catch (e) {
        console.warn('[live] 开播权限检查失败：', e)
        ack?.('failed')
      } finally {
        socket.data.liveOpening = false
      }
    })

    socket.on('resume-live', async (payload, ack) => {
      const requestedRoomId = str(payload?.roomId, 64)
      const requestedToken = str(payload?.token, 64)
      const already = boundHostRoom()
      if (already) {
        if (already.id !== requestedRoomId) return ack?.('already in a room')
        if (!requestedToken || requestedToken !== already.token) return ack?.('forbidden')
        return ack?.(null, hostResumeAck(already))
      }
      if (membership.has(socket.id)) return ack?.('already in a room')
      if (socket.data.liveResuming) return ack?.('already resuming')
      if (!takeOpenToken(socket)) return ack?.('rate limited')
      socket.data.liveResuming = true
      try {
        const room = rooms.get(requestedRoomId)
        if (!room) return ack?.('not found')
        if (!requestedToken || requestedToken !== room.token) return ack?.('forbidden')
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

        // 查账号期间连接断了：绑回去就是把房间交给一个死 socket（理由同 go-live）
        if (!socket.connected) return ack?.('disconnected')
        // 查账号期间房间可能已经到期散场；不能把一个已删除的对象重新绑回 socket。
        if (rooms.get(room.id) !== room) return ack?.('not found')
        const resumed = boundHostRoom()
        if (resumed) {
          if (resumed.id !== room.id || requestedToken !== resumed.token) return ack?.('already in a room')
          return ack?.(null, hostResumeAck(resumed))
        }
        if (membership.has(socket.id)) return ack?.('already in a room')

        // 接管：旧 socket 还挂着（没到 ping 超时）的话，把它从房间里请出去
        const old = room.hostSocketId
        if (old && old !== socket.id) {
          clearSrsNegotiation(room.id, 'publish', old)
          membership.delete(old)
          nsp.sockets.get(old)?.leave(room.id)
        }
        bindHost(nsp, room, socket)
        // 观众要知道主播的新 id（它们的 signal 其实由服务端路由，但 from 过滤用得上）
        toRoom(nsp, room.id, 'host-back', { roomId: room.id, hostId: socket.id }, socket)
        // 把当前观众名单交给主播：哪条 PeerConnection 还活着它自己知道，死了的重新 offer
        ack?.(null, hostResumeAck(room))
      } catch (e) {
        console.warn('[live] 续播权限检查失败：', e)
        ack?.('failed')
      } finally {
        socket.data.liveResuming = false
      }
    })

    socket.on('srs-publish-grant', (payload, ack) => {
      const room = boundHostRoom()
      if (!room || room.transport !== 'srs') return ack?.('not an SRS host')
      if (str(payload?.roomId, 64) !== room.id || str(payload?.token, 64) !== room.token) return ack?.('forbidden')
      ack?.(null, { srsGrant: srsGrant(room, 'publish', socket.id) })
    })

    /**
     * 观众续一张 SRS 播放票。拉流断了要重拉时用它，而不是再发一次 watch：
     * watch 会让主播重建这位观众的协作连接（viewer-joined），只为换一张 2 分钟的票不值得。
     * 只发给当前名单里的观众，票仍绑定这条 socket，其余校验在兑换时照做。
     */
    socket.on('srs-play-grant', (_payload, ack) => {
      const info = membership.get(socket.id)
      if (info?.role !== 'viewer') return ack?.('not a viewer')
      const room = rooms.get(info.roomId)
      if (!room || !room.viewers.has(socket.id)) return ack?.('not found')
      if (room.transport !== 'srs') return ack?.('not an SRS room')
      if (!takeSignalToken(socket, { candidate: true }, 'viewer')) return ack?.('rate limited')
      ack?.(null, { srsGrant: srsGrant(room, 'play', socket.id), srsReady: Boolean(room.srsReady) })
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
        /*
          查账号期间观众断了：再往 room.viewers 里加就是一个永远不会走的幽灵观众 ——
          占着席位、虚报人数，还让「后台 + 零观众」的收房闹钟永远不响（幽灵扫描只看主播）。
        */
        if (!socket.connected) return ack?.('disconnected')
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
      const maxViewers = room.transport === 'srs' ? MAX_SRS_VIEWERS : MAX_VIEWERS
      if (!again && !previous && room.viewers.size >= maxViewers) return ack?.('full')
      if (!again && !previous && room.transport === 'srs' && activeSrsViewerCount() >= MAX_SRS_TOTAL_VIEWERS) {
        return ack?.('server full')
      }

      if (previous) {
        // 同一个人换了 socket：他在 SRS 里的拉流记到新 id 名下，不能当成「离房」去踢
        transferSrsPlayer(room, previous, socket.id)
        clearSrsNegotiation(room.id, 'play', previous)
        room.viewers.delete(previous)
        room.viewerKeys.delete(previous)
        room.viewerNames.delete(previous)
        membership.delete(previous)
        nsp.sockets.get(previous)?.leave(room.id)
        // 上一条是事件流（观众要上场当 2P，改连 socket）：把那条流收掉，之后的事件只走 socket
        const stream = streamViewers.get(previous)
        if (stream) detachStream(stream, 'replaced', {})
      }
      if (!again) {
        room.viewers.add(socket.id)
        if (key) room.viewerKeys.set(socket.id, key)
        // 旧 socket 的断线比新 socket 的 watch 先到：拉流正挂在宽限期里，凭 key 认领回来
        if (!previous) reclaimSrsPlayer(room, socket.id, key)
        membership.set(socket.id, { roomId: room.id, role: 'viewer' })
        socket.join(room.id)
        // 有人来看了：后台 + 零观众那把收房的闹钟得撤
        if (room.hostFrozen) scheduleFrozenClose(nsp, room)
      }
      // 带上最近几条弹幕：中途进来的观众不该面对一片空白。
      // 只在 watch 的 ack 里给，不进 publicRoom —— 那个是大厅列表用的，
      // 每张卡片都驮着 30 条弹幕纯属白费流量
      ack?.(null, {
        ...publicRoom(room),
        hostId: room.hostSocketId,
        chat: room.chat,
        rebound: Boolean(previous),
        ...(room.transport === 'srs' ? { srsGrant: srsGrant(room, 'play', socket.id) } : {}),
      })
      // 由主播发起 offer：它才知道自己有几条轨、什么编码。
      // 主播不在就先不发，它 resume 回来时会拿到观众名单自己补
      if (room.hostSocketId) {
        const cloudflareFallback = payload?.cloudflareFallback === true
        // 付费兜底必须新建一对匹配的 PeerConnection，不能把仍活着的旧连接只改 socket 名。
        const reoffer = Boolean(payload?.reoffer) || cloudflareFallback
        if (previous && !reoffer) {
          // 画面还连着，只是 socket 换了：主播把那条 PeerConnection 换个名字就行，别重建
          nsp.to(room.hostSocketId).emit('viewer-rebound', { from: previous, to: socket.id })
        } else {
          nsp.to(room.hostSocketId).emit('viewer-joined', {
            viewerId: socket.id,
            ...(previous ? { replaces: previous } : {}),
            ...(cloudflareFallback ? { cloudflareFallback: true } : {}),
          })
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
        if (!socket.connected) return ack?.('disconnected')
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
            match = { id: key, players: new Set(), chat: [], chatFlood: null, lastAt: Date.now() }
            matchChats.set(key, match)
          }
          match.players.add(socket.id)
          match.lastAt = Date.now()
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
      /*
        ⚠️ 绑定必须证明「我就是那间联机房的玩家」，和 join-match-chat 同一道闸。
        联机房号是公开列在大厅里的；以前只认「发消息的是主播」，于是任何人开个匿名直播就能
        把别人的联机房号绑到自己名下：删掉对方的弹幕历史、把对方玩家搬进自己的弹幕流、
        大厅里把自己的直播卡并到对方的联机卡上。解绑（next 为空）不涉及别人，不用令牌。
      */
      if (next && !netplayPlayer(resolveRoomId(next), str(payload?.token, 64))) return
      // 大厅是轮询 /api/live/rooms 的（不像 netplay 那边有 SSE），改完等下一轮就看得到
      const previous = room.netplayRoomId
      room.netplayRoomId = next
      /*
        绑定之后，之前那条 `match:<id>` 记录立刻变成孤儿：
        房间里的人被搬到直播弹幕流（room.matchPlayers），leave() 于是再也不会
        走到「matchChats 里删人」那条分支 —— 那条记录的 players 永远空着，
        连带 chat 历史一起留在内存里（见 matchChats 的注释）。
        这里在搬人的同时把它删掉，别等一天后的清扫。
      */
      if (next) matchChats.delete(matchChatKey(resolveRoomId(next)))
      // 已在纯联机弹幕房的人要换到直播弹幕流；结束联机时则反向退回。
      if (previous) nsp.to(room.id).emit('match-chat-moved')
      if (next) nsp.to(matchChatKey(resolveRoomId(next))).emit('match-chat-moved')
      /**
       * 但**正在看的人不能等**：他们已经在房间里了，不会再去刷大厅。
       * 主播一点「联机」，观众那边就该立刻多出一个「加入联机」的入口 ——
       * 这正是「看着看着就能上场」这件事成立的前提。
       * 后进来的观众不用管，watch 的 ack 里带着 publicRoom，本来就有这个字段。
       */
      toRoom(nsp, room.id, 'netplay-linked', { roomId: next })
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
      const opened = open && !room.coopOpen
      room.coopOpen = open
      room.coopTaken = taken
      // 事件流观众没有 DataChannel，听不到主播的 hello：2P 位刚出现时告诉他们，好改连 socket 去申请上场
      if (opened) streamBroadcast(nsp, room.id, 'coop', { open: true })
      notifyRoomList()
    })

    /**
     * 主播报「这一刻抓不到画面」（新版本主播在人数变化时、手里没有可推的源才发）。
     * socket 观众早有这条（主播 addViewer 时直接 signal 给他），事件流观众没有 socket，由服务端转一句。
     * 只有房主能发、按房间限频：它只是给观众一句更准确的诊断，丢几次无所谓。
     */
    socket.on('source-missing', () => {
      const info = membership.get(socket.id)
      if (info?.role !== 'host') return
      const room = rooms.get(info.roomId)
      if (!room || room.hostSocketId !== socket.id) return
      const now = Date.now()
      if (now - (room.sourceMissingAt || 0) < SOURCE_MISSING_MIN_MS) return
      room.sourceMissingAt = now
      streamBroadcast(nsp, room.id, 'no-source', {})
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
      toRoom(nsp, room.id, 'host-frozen', { roomId: room.id, frozen }, socket)
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
        // 清扫靠 lastAt 判断「还在聊吗」，纯联机房没有房间对象可看，只能在这里记一笔
        if (matchChats.get(room.id) === room) room.lastAt = Date.now()
        toRoom(nsp, room.id, 'chat', msg)
        ack?.(null, { id: msg.id })
      }).catch((e) => {
        console.warn('[live] 弹幕广播失败：', e)
        ack?.(CHAT_ACK_FAILED)
      })
    })

    socket.on('leave', () => leave(nsp, socket))
    socket.on('disconnect', () => leave(nsp, socket))
  })

  /*
    兜底：定期把「主播 socket 已经不在线」的房间收掉（见 GHOST_SWEEP_MS 的注释）。

    ⚠️ 判据只能是 `nsp.sockets` 这个**事实**，不能是 membership ——
    这个扫描存在的唯一理由就是 membership 漂开之后还有人管。
    unref()：这只是个清扫线程，不该因为它让进程迟迟退不出（测试里尤其明显）。
  */
  if (ghostTimer) clearInterval(ghostTimer)
  ghostTimer = setInterval(() => {
    // 先清幽灵观众：主播那条判据要看 viewers.size，幽灵观众会让本该散掉的房走宽限期
    for (const room of [...rooms.values()]) sweepGhostViewers(nsp, room)
    for (const room of ghostRooms(rooms.values(), (id) => nsp.sockets.has(id))) {
      if (room.viewers.size === 0) closeRoom(nsp, room, 'ghost-host')
      else hostAway(nsp, room)
    }
    // 顺手回收纯联机弹幕房（见 sweepMatchChats 的注释）。挂在同一个定时器上，
    // 不为它再开一个 interval —— 这种清扫线程多了，测试结束进程退不出去。
    sweepMatchChats()
    pruneSrsNegotiations()
  }, GHOST_SWEEP_MS)
  ghostTimer.unref?.()

  return {
    nsp,
    list: () => liveRooms(),
    srsExchange,
    srsHook,
    srsEnabled: () => Boolean(srsConfig()),
    srsRequested,
    streamWatch,
    streamGrant,
    streamNudge,
    streamChat,
  }
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
