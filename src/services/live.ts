/**
 * 直播（一人玩、多人看）的客户端。
 *
 * 和 netplay 的区别：netplay 是「一起玩」，需要 EmulatorJS 4.3.0-pre 那套输入同步；
 * 直播只需要主播那边的画布和声音，任何引擎都能拿到（Runtime 的 captureSources）。
 * 所以 GBA、DOS、Flash、J2ME 这些没有联机能力的核心，照样能开播。
 *
 * 新房间优先经 SRS 转发音视频，旧房间继续兼容 P2P；Socket.IO 管理房间和协作输入，
 * SDP 由本站后端校验短时授权后代理给 SRS（server/src/live.js）。
 *
 * socket.io 客户端打进前端包（npm 的 socket.io-client，版本钉死与服务端一致），
 * 连 /live 时才按需加载那个分块，见 loadIo。
 */
import { useSyncExternalStore } from 'react'
import { fallbackAfterErrors } from './sseFallback'
import { getToken, apiBase, TOKEN_CHANGED_EVENT } from './api'
import { importWithRetry, lazyChunkFile } from './moduleLinkRecovery'
import { getT } from './i18n'
import { fetchLiveIceConfig, type IceConfig } from './netplay'
import type { Presence } from './presence'
import type { UserRole } from '@/types'
import { liveEnabled } from './roomFlags'
import { rankSrsCodecs, relayOnlyIceServers, srsJitterTargetMs, srsOfferSdp, srsPeerConfiguration } from './liveSrsIce'

export interface LiveRoomInfo {
  roomId: string
  title: string
  gameSlug: string
  gameName: string
  platform: string
  hostName: string
  viewers: number
  maxViewers: number
  startedAt: number
  /** 直播媒体走 SRS；缺省兼容旧服务端的 P2P 房间。 */
  transport?: 'p2p' | 'srs'
  /** SRS 已收到主播上行；观众据此决定何时发起拉流协商。 */
  srsReady?: boolean
  /** 主播断线了、房间在宽限期里等它回来（server/src/live.js 的「主播掉线」一节） */
  hostAway?: boolean
  /** 主播切到后台了：画面冻着不是断了（server/src/live.js 的 host-visibility）。大厅卡片据此提示，别让人点进去对着冻住的画面猜 */
  hostFrozen?: boolean
  /**
   * 配对的联机房号：主播点了「联机」，这个直播间同时也是一个联机房。
   *
   * 直播**不停**（观众一帧不掉），大厅拿它把直播卡和联机卡合成一张 ——
   * 见 services/allRooms.ts。主播掉线时服务端会清掉它。
   */
  netplayRoomId?: string | null
  /**
   * 这一局能不能让观众上场当 2P（同屏双打的 Flash 游戏，见 emulator/coopSeat.ts），
   * 以及位子有没有人坐着。两格都是主播报的（`coop-state`），服务端只存不判。
   *
   * 大厅拿它挂 👋「房主在等人一起玩」—— 没有这两格的话，这个功能只有
   * 已经点开直播间的人才发现得了。
   */
  coopOpen?: boolean
  coopTaken?: boolean
  /** 主播的设备 / 地区 / 网络，服务端从握手信息里看出来的。见 services/presence.ts */
  presence?: Presence
}

export interface LiveCapacity {
  used: number
  max: number
  remaining: number
  available: boolean
}

/**
 * 一条弹幕。字段全部由服务端产出 —— 客户端报什么名字都不算数，
 * 所以这里没有「发送者自称」这种东西（见 server/src/live.js 的 chatIdentity）。
 */
export interface LiveChatMessage {
  id: string
  /** 服务端收到的时刻（毫秒） */
  at: number
  /** 登录用户的昵称。游客没有这个字段 */
  name?: string
  /** 发送者角色（admin / volunteer），游客和普通玩家不带的 */
  role?: UserRole
  /** 游客号（4 位，跟着这次连接走）。登录用户没有这个字段 */
  guest?: string
  /** 是不是房主发的。服务端比对 hostSocketId 得出，伪造不了 */
  host: boolean
  text: string
  /**
   * 这条是**进房时补的历史**，不是刚发生的。
   *
   * ⚠️ 只在客户端打，服务端不发这个字段 —— 它回答的是「对我来说这条是不是旧的」，
   * 而同一条消息对先进来的人是新的、对后进来的人是历史，本来就不是消息自己的属性。
   *
   * 唯一的用处是让飘幕跳过它们：三十条历史一次性到达，全飞的话会瞬间糊满画面，
   * 而且把真正该飞的新消息挤掉（见 LiveChatLane 的 seen / FLYING_MAX）。
   */
  history?: boolean
}

/**
 * 观众名单里的一位。服务端派生，客户端自报的一律不认（见 server/src/live.js 的 viewerList）。
 *
 * 三种形态：`{name}` 登录用户、`{guest}` 游客、`{}` 名字还在异步解析中。
 * ⚠️ **没有 socket.id**：名单会发给房间里所有人，带 id 等于把「谁是谁」的句柄散出去。
 */
export interface LiveViewerEntry {
  name?: string
  guest?: string
  /** admin / volunteer 才有，普通玩家 / 游客不带 */
  role?: UserRole
}

/** socket.io 客户端的最小接口，够用就行，不为它引一整套类型 */
export interface LiveSocket {
  id?: string
  connected: boolean
  emit: (event: string, ...args: unknown[]) => void
  on: (event: string, handler: (...args: never[]) => void) => void
  off: (event: string, handler?: (...args: never[]) => void) => void
  close: () => void
}

/** SDP 代理的失败。status 让调用方分清「票过期了换张票」（403）、「主播还没推上来」（409）和「歇一会儿」（429）。 */
export class LiveSrsError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'LiveSrsError'
    this.status = status
  }
}

/** 通过本站后端代理 SRS 的 HTTP SDP 协商，避免把 SRS 管理 API 暴露给浏览器。 */
export async function exchangeLiveSrsSdp(
  mode: 'publish' | 'play',
  roomId: string,
  grant: string,
  sdp: string,
): Promise<RTCSessionDescriptionInit> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${apiBase()}/api/live/srs/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ roomId, grant, sdp }),
      cache: 'no-store',
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => null)) as { sdp?: string; error?: string } | null
    if (!response.ok || !payload?.sdp) throw new LiveSrsError(payload?.error || `SRS ${mode} negotiation failed`, response.status || 0)
    return { type: 'answer', sdp: payload.sdp }
  } finally {
    window.clearTimeout(timer)
  }
}

/** 拿出 HTTP 状态码；网络错误 / 超时没有状态码，返回 0 */
export function liveSrsErrorStatus(error: unknown): number {
  return error instanceof LiveSrsError ? error.status : 0
}

/**
 * SRS 6 以 H.264 / Opus 作为最稳妥的 WebRTC 组合；把它们放在首选位置，避免浏览器先选了不兼容编码。
 *
 * 按规范 setCodecPreferences 要用**接收端**能力校验（recvonly 拉流尤其如此）；拿发送端能力去设，
 * 某些 H.264 profile 不在接收能力里就会整个抛错、首选失效。所以先试接收端，再退回发送端。
 */
export function preferLiveSrsCodecs(transceiver: RTCRtpTransceiver, kind: 'audio' | 'video'): void {
  if (typeof transceiver.setCodecPreferences !== 'function') return
  const sources = [
    typeof RTCRtpReceiver === 'undefined' ? undefined : RTCRtpReceiver.getCapabilities?.(kind)?.codecs,
    typeof RTCRtpSender === 'undefined' ? undefined : RTCRtpSender.getCapabilities?.(kind)?.codecs,
  ]
  for (const codecs of sources) {
    if (!codecs?.length) continue
    const ranked = rankSrsCodecs(codecs, kind)
    if (!ranked) continue
    try {
      transceiver.setCodecPreferences(ranked)
      return
    } catch {
      /* 这份能力表被拒了就换另一份；都不行就保持浏览器默认协商，不让播放器因此失败。 */
    }
  }
}

/** 给 SRS 拉流的接收端设抖动缓冲（见 srsJitterTargetMs）。不支持的浏览器静默跳过 */
export function tuneLiveSrsJitter(pc: RTCPeerConnection, sample: { loss: number; rttMs?: number }): void {
  const target = srsJitterTargetMs(sample)
  for (const receiver of pc.getReceivers()) {
    const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null }
    if (!('jitterBufferTarget' in r)) continue
    try {
      if (r.jitterBufferTarget !== target) r.jitterBufferTarget = target
    } catch {
      /* 超出浏览器允许的范围：保持原值 */
    }
  }
}
type IoFactory = (uri: string, opts?: Record<string, unknown>) => LiveSocket

/** 直播首屏不能被容量预检无限期挂住。 */
const LIVE_CAPACITY_TIMEOUT_MS = 4_000

/**
 * `liveEnabled()` 的定义在 ./roomFlags —— runtimeMeta.ts 只需要这一个布尔值，
 * 从本文件取会把整条直播链路拖进主包。这里转出去，别删。
 */
export { liveEnabled }

/** 成人房列表和详情由服务端按 JWT 年龄过滤，所以这些请求必须带当前登录令牌。 */
function liveAuthHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * socket.io 客户端：打进前端包，连接时才按需加载这个分块。
 *
 * 2026-11-20 以前它不打包，而是运行时从后端 /socket.io/socket.io.min.js 现取（serveClient: true）。
 * 那个地址是 `Cache-Control: max-age=0`，Cloudflare 每次都要回源站复验（cf-cache-status: REVALIDATED）；
 * 8bitgo.com 上的大陆访客走洛杉矶，实测一份 15KB 的脚本 11～40 秒，8 秒超时一到就放弃，
 * 开播、看直播全部失败。打包之后它和其它前端分块一样：文件名带内容哈希、一年 immutable，
 * 边缘和浏览器都缓存，大陆访客跟着页面走 EdgeOne（renderBuiltUrl 让分块相对引用方解析）。
 * 同类网站（ggemu）的观众页也是这样，没有任何运行时现取的脚本。
 *
 * 为什么是动态 import 而不是静态：本文件经 services/allRooms.ts 被侧栏房间数加载，几乎每个页面都有，
 * 静态 import 会让所有页面多下约 14KB（gzip）；按需加载只在真正连 /live 时才取。
 * 分块取不下来走 importWithRetry：就地重试，换带查询串的新地址，避开浏览器模块表里记住的失败。
 *
 * 版本必须和服务端的 socket.io 同一个 minor，scripts/test-live-io.mjs 会核对两边装的版本。
 * 以前走全局 window.io 时被别的脚本抢过 define / module（UMD 分支）、被 js-dos 泄漏的同名全局顶掉过；
 * 现在是 ES 模块导入，页面全局一个字节都不读，这两类问题都不存在了。
 */
const loadSocketIoClient = () => import('socket.io-client')
const socketIoClientChunk = lazyChunkFile(loadSocketIoClient)

/** 拿到手的工厂自己收着，后面每次连接直接用 */
let ioFactory: IoFactory | null = null
let ioLoading: Promise<IoFactory> | null = null
function loadIo(): Promise<IoFactory> {
  if (ioFactory) return Promise.resolve(ioFactory)
  if (ioLoading) return ioLoading
  ioLoading = importWithRetry(loadSocketIoClient, socketIoClientChunk, import.meta.url)
    .then((m) => {
      ioFactory = m.io as unknown as IoFactory
      return ioFactory
    })
    .catch((e) => {
      ioLoading = null // 允许下次重试（网络恢复后再开播）
      throw e
    })
  return ioLoading
}

/** 连到 /live 命名空间。失败时抛出的错误里带着脚本地址，方便排查反代问题。 */
export async function connectLive(): Promise<LiveSocket> {
  const io = await loadIo()
  const base = apiBase()
  const socket = io(base ? `${base}/live` : '/live', {
    transports: ['websocket', 'polling'],
    forceNew: true,
    /**
     * 把登录令牌带进握手：普通直播仍允许游客，服务端也会据此给弹幕署名；
     * 成人游戏直播则把它作为真正的权限凭证，开播、续播和观看都会核对账号出生日期。
     */
    // 传函数不传对象：socket.io 每次（重）连都会重新取。传死对象的话中途登录 / 退出后，
    // 自动重连带的还是旧令牌 —— 成人直播续播会按旧身份判权限，弹幕署名也是旧的。
    auth: (cb: (data: { token?: string }) => void) => cb({ token: getToken() || undefined }),
  })
  await new Promise<void>((resolve, reject) => {
    /**
     * ⚠️ 这两个处理器只管**首连**，连上之后必须摘掉。
     * 以前没摘：socket.io 自动重连时每一次失败的尝试都会再触发 connect_error，
     * 这里就把 socket 关了 —— 服务器重启那几秒、网络抖一下，重连从此永久停止，
     * 主播的房间和观众的画面就这么没了，而且没有任何报错。
     */
    let lastError: Error | null = null
    const finishError = (err: Error) => {
      window.clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      // socket.io 在「命名空间没注册」时回的就是一句 "Invalid namespace"，
      // 对着这句话没人猜得到该干什么。翻译成人话：后端代码是旧的，或者没重启。
      const msg = String(err?.message || '')
      reject(new Error(/invalid namespace/i.test(msg) ? getT().runtime.liveNoServer : msg || getT().runtime.liveNoServer))
    }
    const onConnect = () => {
      window.clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      resolve()
    }
    const onError = ((err: Error) => {
      const msg = String(err?.message || '')
      // Invalid namespace 是部署配置错误，等多久也不会自己好；其余首次连接错误多半是
      // Wi‑Fi/移动网络切换或服务器短暂重启，让 Socket.IO 在总预算内继续重试。
      if (/invalid namespace/i.test(msg)) finishError(err)
      else lastError = err
    }) as (...args: never[]) => void
    const timer = window.setTimeout(
      () => finishError(lastError ?? new Error(getT().runtime.liveTimeout)),
      15_000,
    )
    socket.on('connect', onConnect)
    socket.on('connect_error', onError)
  })
  return socket
}

/** 直播首轮只取直连与自建 TURN；Cloudflare 不能混进首轮候选。 */
export async function liveIceServers(): Promise<RTCIceServer[]> {
  return (await liveIceConfig()).iceServers
}

/**
 * 完整的 ICE 配置（含 hasTurn）。
 *
 * `hasTurn` 服务端一直在算、netplay 那边也一路传到了 onIceReady —— 但**全站没有一处消费它**。
 * 于是「站点根本没配 TURN、这两个网络之间注定连不通」这件事，明明开播前就知道，
 * 却要让观众对着转圈等满超时，再收一句「可能是网络限制」。观众侧现在拿它来分辨
 * 「真的连不上」和「主播下播了」，给出的提示才有指向。
 */
export async function liveIceConfig({ cloudflareFallback = false }: { cloudflareFallback?: boolean } = {}): Promise<IceConfig> {
  try {
    return await fetchLiveIceConfig({ cloudflareFallback })
  } catch {
    return {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      hasTurn: false,
      expiry: 0,
      retryAt: Math.floor(Date.now() / 1000) + 60,
    }
  }
}

/**
 * SRS 连接用的 ICE 服务器（为什么默认一个都不要，见 liveSrsIce.ts 文件头）。
 *
 * relay=true 只在「直连从没连上就 failed」之后用：只带站点自建的 TURN 中继，绝不带 Cloudflare
 * （那是 P2P 观众的付费末级兜底，见 netplay.ts）。取不到配置就返回空 —— 和直连一样，不会更差。
 */
export async function liveSrsIceServers({ relay = false }: { relay?: boolean } = {}): Promise<RTCIceServer[]> {
  if (!relay) return []
  try {
    const config = await liveIceConfig()
    if (config.turnSources?.includes('cloudflare')) return []
    return relayOnlyIceServers(config.iceServers)
  } catch {
    return []
  }
}

export { srsOfferSdp, srsPeerConfiguration }

/** 观看链接：朋友打开即是观众 */
export function liveLink(gameSlug: string, roomId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/games/${gameSlug}?live=${encodeURIComponent(roomId)}`
}

export async function fetchLiveRooms(gameSlug?: string): Promise<LiveRoomInfo[]> {
  if (!liveEnabled()) return []
  try {
    const url = `${apiBase()}/api/live/rooms${gameSlug ? `?game=${encodeURIComponent(gameSlug)}` : ''}`
    const res = await fetch(url, { cache: 'no-store', headers: liveAuthHeaders() })
    if (!res.ok) return []
    return (await res.json()) as LiveRoomInfo[]
  } catch {
    return []
  }
}

export async function fetchLiveRoom(roomId: string): Promise<LiveRoomInfo | null> {
  if (!liveEnabled()) return null
  try {
    const res = await fetch(`${apiBase()}/api/live/rooms/${encodeURIComponent(roomId)}`, {
      cache: 'no-store',
      headers: liveAuthHeaders(),
    })
    if (!res.ok) return null
    return (await res.json()) as LiveRoomInfo
  } catch {
    return null
  }
}

/**
 * 自动开播前的容量预检。请求失败时放行：旧后端尚未部署这个接口、或一瞬间断网，都不该永久
 * 关掉直播；真正的 go-live 仍会在服务端按实时房间数拒绝，因而这里放行也不会突破上限。
 */
export async function canAutoStartLive(signal?: AbortSignal): Promise<boolean> {
  if (!liveEnabled()) return false
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(() => controller.abort(), LIVE_CAPACITY_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase()}/api/live/capacity`, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) return true
    const capacity = (await res.json()) as Partial<LiveCapacity>
    return typeof capacity.available === 'boolean' ? capacity.available : true
  } catch {
    return true
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/* ---------------- 正在直播的房间列表（轮询，多个组件共享一个定时器） ---------------- */

/**
 * 现在走 SSE（`/api/live/events`）：服务端有变化才推，平时零请求，开播 / 下播 / 人数变化
 * 立刻可见。以前是每 8 秒轮询一次 —— 而侧边栏挂在**每个页面**上，等于每个在线访客都在
 * 持续打请求，100 个人在线就是每秒十几次，绝大多数时候列表根本没变。
 * netplay 那边（services/netplay.ts）更早就换过来了，这里是补上同一套。
 *
 * EventSource 自带断线重连；浏览器不支持、或者后端还是老版本没有这个端点时，退回轮询。
 */
const LIST_POLL_MS = 15_000
/** 轮询连续失败时的退避上限：后端挂着的那几分钟，每个登录用户别再按 15 秒一次去撞它 */
const LIST_POLL_MAX_MS = 120_000
/** 与 netplay 列表一致：网关挂起时必须释放轮询锁，不能让大厅永久停在旧快照。 */
const LIST_REQUEST_TIMEOUT_MS = 8_000
/** 空数组用固定引用：useSyncExternalStore 要求快照引用稳定，否则会无限重渲染 */
const NO_LIVE_ROOMS: LiveRoomInfo[] = []
const EMPTY_LIVE_ROOMS = () => NO_LIVE_ROOMS
const NO_LIVE_SUBSCRIBE = (_listener: () => void) => () => {}

/** 和 fetchLiveRooms 的区别：这个会把失败抛出来，让 store 能区分「没人在播」和「后端不可达」 */
async function loadLiveRooms(signal?: AbortSignal): Promise<LiveRoomInfo[]> {
  const res = await fetch(`${apiBase()}/api/live/rooms`, { cache: 'no-store', headers: liveAuthHeaders(), signal })
  if (!res.ok) throw new Error(String(res.status))
  const list = (await res.json()) as LiveRoomInfo[]
  if (!Array.isArray(list)) throw new Error('invalid live room list')
  return list
}

const liveStore = (() => {
  let rooms: LiveRoomInfo[] = NO_LIVE_ROOMS
  const listeners = new Set<() => void>()
  let es: EventSource | null = null
  let stopFallback: (() => void) | null = null
  let timer = 0
  /** 轮询这一轮还在飞：慢响应 + 下一跳会叠成并发请求 */
  let polling = false
  /** 连续失败次数，决定下一轮隔多久（指数退避，见 LIST_POLL_MAX_MS） */
  let pollFailures = 0
  /** 当前连接按哪一张 JWT 建立；登录 / 退出后必须换通道，否则会沿用旧权限。 */
  let connectedToken = ''
  /** 记录缓存快照所属的权限身份；身份变化时先清缓存，避免成人房残留给新身份。 */
  let roomsToken = ''
  /** 让旧连接 / 旧 JWT 发起的迟到响应失效，避免登出后短暂显示成人房或陈旧房间。 */
  let generation = 0
  /** REST 与 SSE 都是快照；序号阻止较旧的 HTTP 响应覆盖更新的推送。 */
  let listRevision = 0
  let activeRequest: AbortController | null = null
  let inFlight: { generation: number; token: string; promise: Promise<boolean> } | null = null
  const emit = () => listeners.forEach((l) => l())

  /** 列表空了要真的清空 —— 主播下播之后卡片必须消失，不能因为「保留上次结果」一直挂着 */
  const apply = (next: LiveRoomInfo[]) => {
    rooms = next.length ? next : NO_LIVE_ROOMS
    emit()
  }

  /** 返回这一轮成没成功；轮询靠它决定退避 */
  const refresh = async (): Promise<boolean> => {
    const mine = generation
    const token = getToken()
    if (!liveEnabled()) return false
    if (inFlight?.generation === mine && inFlight.token === token) return inFlight.promise

    // 轮询期间若 SSE 或本地权限变化已产生更新，迟到的 REST 快照不能把大厅倒退。
    const revision = listRevision
    const controller = new AbortController()
    activeRequest = controller
    let promise!: Promise<boolean>
    promise = (async () => {
      const timeout = window.setTimeout(() => controller.abort(), LIST_REQUEST_TIMEOUT_MS)
      try {
        const next = await loadLiveRooms(controller.signal)
        if (mine !== generation || token !== getToken() || revision !== listRevision) return true
        roomsToken = token
        apply(next)
        listRevision++
        return true
      } catch {
        /* 后端暂时不可达时保留上次结果，别闪一下空列表；超时后轮询仍可继续退避重试。 */
        return false
      } finally {
        window.clearTimeout(timeout)
        if (activeRequest === controller) activeRequest = null
        if (inFlight?.promise === promise) inFlight = null
      }
    })()
    inFlight = { generation: mine, token, promise }
    return promise
  }

  /**
   * 退回轮询（SSE 不可用、或后端还没有这个端点时；登录用户一律走这里）。
   *
   * ⚠️ 不能是一个固定 15 秒的 setInterval：侧边栏挂在每个页面上，登录用户全走这条路 ——
   * 后台标签页照打不误、后端故障时所有人按全速去撞、慢响应还会和下一跳叠成并发。
   * 现在：标签页藏着就不打（切回来立刻补一次）；一次只飞一个；失败按指数退避到 2 分钟。
   */
  const pollOnce = async () => {
    timer = 0
    if (polling) return
    if (typeof document !== 'undefined' && document.hidden) return // visibilitychange 会补上
    const mine = generation
    polling = true
    const ok = await refresh()
    // disconnect / 身份切换已经让这一轮作废；旧轮询不能解锁新一轮的 polling 标志。
    if (mine !== generation) return
    polling = false
    pollFailures = ok ? 0 : pollFailures + 1
    const delay = Math.min(LIST_POLL_MAX_MS, LIST_POLL_MS * 2 ** pollFailures)
    timer = window.setTimeout(() => void pollOnce(), delay)
  }
  const onVisible = () => {
    if (document.hidden || timer || polling || !pollingOn) return
    void pollOnce()
  }
  let pollingOn = false
  const startPolling = () => {
    if (pollingOn) return
    pollingOn = true
    pollFailures = 0
    document.addEventListener('visibilitychange', onVisible)
    void pollOnce()
  }

  const connect = () => {
    connectedToken = getToken()
    if (roomsToken !== connectedToken) {
      // 房间快照可能包含按年龄权限过滤后的直播；切换账号时必须先抹掉旧权限的数据。
      roomsToken = connectedToken
      rooms = NO_LIVE_ROOMS
      listRevision++
      emit()
    }
    const mine = generation
    /*
      EventSource 不能自定义 Authorization 头。游客继续用它享受低请求量；登录用户改用带 JWT 的
      轮询，否则服务端只能把他当游客，年满 18 岁也永远看不到成人房。令牌绝不能塞进 URL，
      那会进入访问日志、历史记录和 Referer。
    */
    if (connectedToken) {
      startPolling()
      return
    }
    if (typeof EventSource !== 'function') {
      startPolling()
      return
    }
    try {
      es = new EventSource(`${apiBase()}/api/live/events`)
    } catch {
      startPolling()
      return
    }
    es.addEventListener('rooms', (e) => {
      if (mine !== generation || connectedToken) return
      try {
        const list = JSON.parse((e as MessageEvent<string>).data) as LiveRoomInfo[]
        if (Array.isArray(list)) {
          roomsToken = ''
          listRevision++
          apply(list)
        }
      } catch {
        /* 坏包忽略，等下一条 */
      }
    })
    /*
      连续失败就退回轮询。⚠️ 判据不能只看 `readyState === CLOSED`：
      HTTP/3 那类传输层断流（线上实测的 ERR_QUIC_PROTOCOL_ERROR）浏览器会一直重连、
      状态停在 CONNECTING，兜底一次都不会触发，列表就静静地不再更新。
      详见 sseFallback.ts。
    */
    stopFallback = fallbackAfterErrors(es, () => {
      if (mine === generation) startPolling()
    })
  }

  const disconnect = () => {
    generation++
    stopFallback?.()
    stopFallback = null
    es?.close()
    es = null
    if (timer) {
      window.clearTimeout(timer)
      timer = 0
    }
    if (pollingOn) {
      pollingOn = false
      document.removeEventListener('visibilitychange', onVisible)
    }
    polling = false
    activeRequest?.abort()
    activeRequest = null
    inFlight = null
  }

  const reconnectForToken = () => {
    if (getToken() === connectedToken) return
    disconnect()
    if (listeners.size > 0 && liveEnabled()) connect()
  }

  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === '8bitgo.token') reconnectForToken()
  }

  return {
    get: () => rooms,
    subscribe(l: () => void) {
      listeners.add(l)
      if (listeners.size === 1 && liveEnabled()) {
        window.addEventListener(TOKEN_CHANGED_EVENT, reconnectForToken)
        window.addEventListener('storage', onStorage)
        connect()
      }
      return () => {
        listeners.delete(l)
        if (listeners.size === 0) {
          window.removeEventListener(TOKEN_CHANGED_EVENT, reconnectForToken)
          window.removeEventListener('storage', onStorage)
          disconnect()
        }
      }
    },
    refresh,
  }
})()

/** 正在直播的房间（服务端推送，多个组件共享一条连接） */
export function useLiveRooms(enabled = true): LiveRoomInfo[] {
  /*
    播放器只有在联机房内才需要知道直播与联机的配对变化。单机游戏期间，直播观众进出
    仍会更新大厅列表，但不该因此让整棵模拟器界面反复渲染。
  */
  return useSyncExternalStore(enabled ? liveStore.subscribe : NO_LIVE_SUBSCRIBE, enabled ? liveStore.get : EMPTY_LIVE_ROOMS, EMPTY_LIVE_ROOMS)
}

/** 手动刷新（开播 / 下播之后立刻让列表跟上，不用等下一轮） */
export function refreshLiveRooms(): void {
  void liveStore.refresh()
}
