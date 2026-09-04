/**
 * P2P 联机（EmulatorJS netplay）—— 默认的联机方案。
 *
 * 房主的浏览器正常跑游戏，用 captureStream 把画面 / 声音经 WebRTC 直推给其他玩家；
 * 访客的按键走 DataChannel 回到房主，注入到对应手柄位。
 * **画面不经过我们的服务器**，服务端只有一个 socket.io 信令（server/src/netplay.js）。
 *
 * 和 cloud-game 的区别：
 *   P2P        零服务器成本，但房主关页面这局就结束，画质取决于房主的上行带宽
 *   cloud-game 游戏跑在服务器上，房主离开也不影响，但每个房间占一个 CPU 核
 *
 * 没配置 VITE_NETPLAY_URL 时整块功能自动隐藏。
 */
import { useSyncExternalStore } from 'react'
import { getCurrentUser } from './auth'
import type { Presence } from './presence'

export const NETPLAY_URL: string = (import.meta.env.VITE_NETPLAY_URL || '').replace(/\/+$/, '')

/**
 * ICE 服务器。P2P 直连要穿 NAT，光靠 STUN 大约有一到两成的组合连不通
 * （对称型 NAT、部分企业网 / 移动网），这时必须有 TURN 中继兜底 —— 只有这部分流量会过服务器。
 *
 * .env 里给 JSON 数组，例如：
 *   VITE_NETPLAY_ICE=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:1.2.3.4:3478","username":"8bitgo","credential":"xxx"}]
 */
export const ICE_SERVERS: RTCIceServer[] = (() => {
  const raw = import.meta.env.VITE_NETPLAY_ICE
  if (!raw) return [{ urls: 'stun:stun.l.google.com:19302' }]
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[]
    return Array.isArray(parsed) && parsed.length ? parsed : [{ urls: 'stun:stun.l.google.com:19302' }]
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }]
  }
})()

export interface IceConfig {
  iceServers: RTCIceServer[]
  /** 有没有 TURN 兜底。没有的话大约一到两成的玩家组合会连不通 */
  hasTurn: boolean
  /** 凭证过期时间（unix 秒），0 = 没有 TURN */
  expiry: number
}

let icePromise: Promise<IceConfig> | null = null
let iceCached: IceConfig | null = null

/**
 * 取 ICE 配置。
 *
 * 优先问服务端要（GET /api/netplay/ice，见 server/src/routes/ice.js）——
 * 那边按请求现算一份短期 TURN 凭证。两个好处：
 *   1. TURN 的账号密码不再打进前端包。走 VITE_NETPLAY_ICE 的话密码明晃晃写在 JS 里，
 *      谁都能抄走当免费流量中转。
 *   2. 换 TURN 服务器 / 轮换密钥不用重新构建前端。
 *
 * 服务端没配 TURN 或接口不可用时，退回 VITE_NETPLAY_ICE / 公共 STUN，
 * 功能照常，只是连通率低一些。凭证快过期时自动重取。
 */
export async function fetchIceConfig(): Promise<IceConfig> {
  const now = Math.floor(Date.now() / 1000)
  // 提前 5 分钟续，别让一局玩到一半凭证过期
  if (iceCached && (iceCached.expiry === 0 || iceCached.expiry - now > 300)) return iceCached
  if (icePromise) return icePromise

  icePromise = (async () => {
    try {
      const res = await fetch(`${NETPLAY_URL.replace(/\/netplay$/, '')}/api/netplay/ice`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as Partial<IceConfig>
      if (!Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error('empty')
      iceCached = { iceServers: data.iceServers, hasTurn: Boolean(data.hasTurn), expiry: Number(data.expiry) || 0 }
      return iceCached
    } catch {
      iceCached = { iceServers: ICE_SERVERS, hasTurn: false, expiry: 0 }
      return iceCached
    } finally {
      icePromise = null
    }
  })()
  return icePromise
}

/** socket.io 客户端脚本地址：模拟器 iframe 里需要全局的 io()，由信令服务器自带 */
export function socketIoScriptUrl(): string {
  if (!NETPLAY_URL) return ''
  // NETPLAY_URL 形如 https://host/netplay，socket.io 的客户端脚本在同源根下
  return `${NETPLAY_URL.replace(/\/netplay$/, '')}/socket.io/socket.io.js`
}

export function netplayEnabled(): boolean {
  return Boolean(NETPLAY_URL)
}

/**
 * 交给模拟器 iframe 用的信令地址 —— **必须是绝对地址**。
 *
 * 模拟器跑在 srcdoc iframe 里，那个文档的 location 是 about:srcdoc：protocol 是 "about:"、
 * host 是空串。fetch / XHR / <script src> 走的是文档的 base URL（继承父页面），所以相对路径
 * 都好用；但 socket.io 客户端算地址**不看 base URL**，只拼 location.protocol + location.host ——
 * `io('/netplay')` 在 iframe 里算出来的是 `http://about:80/socket.io/…`（socket.io-client 4.8 实测），
 * HTTPS 页面上被当 Mixed Content 直接拦掉。表现：控制台一串「insecure XMLHttpRequest endpoint」
 * （每次重连一条）、信令永远连不上、open-room 卡在发送缓冲区里、大厅看不到房间、
 * 房主拿不到 room-token（「没有房间令牌，房主进度托管未启动」）。
 *
 * 所以在父页面这边先按当前页面解析成绝对地址（/netplay → https://8bitgo.com/netplay）再写进
 * EJS_netplayUrl。NETPLAY_URL 本来就是绝对地址时原样返回。本模块其它地方是父页面里的 fetch，
 * 继续用相对地址没问题。
 */
export function netplayUrlForFrame(): string {
  if (!NETPLAY_URL) return ''
  if (typeof window === 'undefined') return NETPLAY_URL
  try {
    return new URL(NETPLAY_URL, window.location.href).href.replace(/\/+$/, '')
  } catch {
    return NETPLAY_URL
  }
}

/**
 * EmulatorJS 要求 gameId 是数字（否则联机按钮不显示），而我们的游戏用 slug。
 * 用 FNV-1a 32 位散列把 slug 映射成稳定的数字，两边都能算，不需要额外存储。
 */
export function gameIdFor(slug: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * gameId → slug 的反查表。
 *
 * 以前是「只构建一次」，但游戏列表可能是后到的（连了数据库时要等接口回来）——
 * 第一次调用时列表还是空的，就把一张空表永久缓存了下来，之后所有房间都认不出游戏，
 * 侧边栏和 /rooms 页永远是空的。改成按列表长度判断要不要重建。
 */
let slugByGameId: Map<number, string> | null = null
let slugCacheSize = -1
export function slugForGameId(gameId: number, allSlugs: string[]): string | undefined {
  if (!slugByGameId || slugCacheSize !== allSlugs.length) {
    slugByGameId = new Map()
    for (const s of allSlugs) slugByGameId.set(gameIdFor(s), s)
    slugCacheSize = allSlugs.length
  }
  return slugByGameId.get(gameId)
}

export type RoomRole = 'player' | 'spectator'

export interface NetplayRoom {
  roomId: string
  gameId: number
  roomName: string
  createdAt: number
  host: { nickname: string } | null
  players: number
  max: number
  /** 只看不玩的人数（直播观众） */
  spectators?: number
  maxSpectators?: number
  hasPassword: boolean
  members: Array<{ nickname: string; host: boolean; role?: RoomRole; presence?: Presence }>
  /** 房主的设备 / 地区 / 网络。见 services/presence.ts */
  presence?: Presence
  kind: 'p2p'
  /** 房主掉线了，正在等人接手（60 秒内） */
  awaitingHost?: boolean
  /** 被选中接手的人（netplay 内部的 playerID） */
  nextHostUserId?: string | null
  /** 服务器上有没有存档可以接着玩 */
  hasState?: boolean
  /** 已经换过房主了，房间搬到了这个新 id（老邀请链接会带上它） */
  migratedTo?: string | null
  /** 被选中的人已经认领、正在重开房间 */
  claimed?: boolean
}

/** 服务端根路径（NETPLAY_URL 形如 https://host/netplay） */
const apiBase = () => NETPLAY_URL.replace(/\/netplay$/, '')

/**
 * 房主定期把存档传上去，掉线时交给新房主。
 * gzip 之后 NES 大约 20KB、GBA 几十 KB，25 秒一次可以忽略不计。
 *
 * 鉴权只认房间令牌（服务端 room-token 事件发下来的那个）。
 * ⚠️ 以前这里把令牌塞进了 `x-netplay-user` —— 服务端拿它当 userid 比对，永远 403，
 * 房主的进度托管其实一直没在工作；而没拿到令牌时退回 userid 的那条路又是任何访客都能伪造的。
 */
export async function uploadState(roomId: string, token: string, state: Uint8Array): Promise<boolean> {
  if (!token) return false
  try {
    let body: BodyInit = state as BodyInit
    if (typeof CompressionStream === 'function') {
      const stream = new Blob([state as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
      body = await new Response(stream).blob()
    }
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-netplay-token': token },
      body,
    })
    return res.ok
  } catch {
    return false
  }
}

/** 取存档（自动解 gzip）。没有就返回 null */
export async function downloadState(roomId: string, token = ''): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/state`, {
      // 存档是别人游戏进度的完整快照，服务端要校验请求方确实是房间成员。
      // 没有令牌时也发（服务端对老前端放行），升级完两端就能收紧成强制。
      headers: token ? { 'x-netplay-token': token } : {},
    })
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    // gzip 魔数
    if (buf[0] === 0x1f && buf[1] === 0x8b && typeof DecompressionStream === 'function') {
      const stream = new Blob([buf as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    }
    return buf
  } catch {
    return null
  }
}

/**
 * 认领：服务器选中我接手，先告诉它「我来」。
 *
 * 必须在重新挂载引擎**之前**调：重挂引擎会断掉旧连接，不先认领的话，服务器看到
 * 唯一的访客断了就把房间散掉，老邀请链接跟着死；多人房则 8 秒后轮给下一位，两个人抢着接。
 * 认领之后服务器暂停轮询、断线不散场，存档也可以凭这个令牌下载。
 */
export async function claimRoom(roomId: string, token: string): Promise<string | null> {
  if (!token) return null
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netplay-token': token },
      body: '{}',
    })
    if (!res.ok) return null
    const data = (await res.json()) as { claimToken?: string }
    return data.claimToken || null
  } catch {
    return null
  }
}

/**
 * 新房主开好新房间后，把新旧房间接上（老邀请链接才能继续有效）。
 * 两个令牌：认领令牌证明「我是被选中的人」，新房间的成员令牌证明「新房间是我开的」——
 * 以前只看 body 里的 userId，那是谁都能填的。
 */
export async function migrateRoom(oldRoomId: string, newRoomId: string, claimToken: string, newRoomToken: string): Promise<boolean> {
  if (!claimToken || !newRoomToken) return false
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(oldRoomId)}/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netplay-token': claimToken },
      body: JSON.stringify({ newRoomId, newRoomToken }),
    })
    return res.ok
  } catch {
    return false
  }
}

const GUEST_KEY = '8bitgo.netplay.name'
/** 房间里显示的名字：登录用户用昵称，游客给个稳定的随机名 */
export function playerName(): string {
  const user = getCurrentUser()
  if (user?.nickname) return user.nickname
  try {
    let g = localStorage.getItem(GUEST_KEY)
    if (!g) {
      g = `Guest-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      localStorage.setItem(GUEST_KEY, g)
    }
    return g
  } catch {
    return 'Guest'
  }
}

/** 邀请链接：朋友打开即可加入 */
export function inviteLink(gameSlug: string, roomId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/games/${gameSlug}?p2p=${encodeURIComponent(roomId)}`
}

/* ---------------- 房间列表（服务端推送，多个组件共享） ---------------- */

/**
 * 以前是每 6 秒轮询一次。侧边栏「联机玩」在每个页面都挂着，等于每个在线访客
 * 一直在给信令服务器打请求 —— 100 个人在线就是每秒十几个请求，而绝大多数时候
 * 房间列表根本没变。
 *
 * 现在用 SSE（EventSource）：服务端有变化才推，平时零流量，而且换房主、满员、
 * 房间消失都是立刻可见，不用等下一轮轮询。
 * EventSource 自带断线重连；浏览器不支持或连不上时退回轮询。
 */
const POLL_MS = 15_000
/** 空数组用固定引用：useSyncExternalStore 要求快照引用稳定，否则会无限重渲染 */
const NO_ROOMS: NetplayRoom[] = []

const store = (() => {
  let rooms: NetplayRoom[] = NO_ROOMS
  const listeners = new Set<() => void>()
  let es: EventSource | null = null
  let timer = 0
  const emit = () => listeners.forEach((l) => l())

  const refresh = async () => {
    try {
      const res = await fetch(`${apiBase()}/api/netplay/rooms`)
      if (!res.ok) return
      rooms = (await res.json()) as NetplayRoom[]
      emit()
    } catch {
      /* 信令服务器暂时不可达时保留上次结果 */
    }
  }

  /** 退回轮询（SSE 不可用时） */
  const startPolling = () => {
    if (timer) return
    void refresh()
    timer = window.setInterval(() => void refresh(), POLL_MS)
  }

  const connect = () => {
    if (typeof EventSource !== 'function') {
      startPolling()
      return
    }
    try {
      es = new EventSource(`${apiBase()}/api/netplay/events`)
    } catch {
      startPolling()
      return
    }
    es.addEventListener('rooms', (e) => {
      try {
        rooms = JSON.parse((e as MessageEvent<string>).data) as NetplayRoom[]
        emit()
      } catch {
        /* 坏包忽略，等下一条 */
      }
    })
    es.addEventListener('error', () => {
      // EventSource 会自己重连；连续失败时（比如服务端根本没有这个接口）
      // 兜一层轮询，保证功能不至于完全不可用
      if (es?.readyState === EventSource.CLOSED) startPolling()
    })
  }

  const disconnect = () => {
    es?.close()
    es = null
    if (timer) {
      window.clearInterval(timer)
      timer = 0
    }
  }

  return {
    get: () => rooms,
    subscribe(l: () => void) {
      listeners.add(l)
      if (listeners.size === 1 && netplayEnabled()) connect()
      return () => {
        listeners.delete(l)
        if (listeners.size === 0) disconnect()
      }
    },
    refresh,
  }
})()

export function useNetplayRooms(): NetplayRoom[] {
  return useSyncExternalStore(store.subscribe, store.get, () => NO_ROOMS)
}

/** 手动刷新（开完房间后立刻让列表出现自己） */
export function refreshNetplayRooms(): void {
  void store.refresh()
}

/**
 * 查单个房间。走的是「顺着别名解析」的接口，所以换过房主之后老邀请链接照样能查到，
 * 并且会在 migratedTo 里告诉你新的房间 id。
 */
/**
 * 订阅某个房间的变化（换房主、有人进出、房间消失）。
 *
 * 播放器以前是在房间里时每 2.5 秒 fetch 一次自己的房间，纯粹为了等「房主掉线了」
 * 这个几乎不会发生的事件。改成 SSE 之后平时零请求，而且房主一掉线立刻就知道，
 * 接手速度快很多（原来最坏要等 2.5 秒才发现）。
 *
 * @returns 取消订阅的函数
 */
export function watchNetplayRoom(
  roomId: string,
  handlers: { onRoom: (room: NetplayRoom) => void; onGone: () => void },
): () => void {
  if (!netplayEnabled() || !roomId) return () => {}

  let stopped = false
  let es: EventSource | null = null
  let timer = 0

  const poll = async () => {
    const room = await fetchNetplayRoom(roomId)
    if (stopped) return
    if (room) handlers.onRoom(room)
    else handlers.onGone()
  }

  if (typeof EventSource === 'function') {
    try {
      es = new EventSource(`${apiBase()}/api/netplay/events?watch=${encodeURIComponent(roomId)}`)
      es.addEventListener('room', (e) => {
        if (stopped) return
        try {
          handlers.onRoom(JSON.parse((e as MessageEvent<string>).data) as NetplayRoom)
        } catch {
          /* 坏包忽略 */
        }
      })
      es.addEventListener('room-gone', () => {
        if (!stopped) handlers.onGone()
      })
      es.addEventListener('error', () => {
        if (es?.readyState === EventSource.CLOSED && !timer) {
          timer = window.setInterval(() => void poll(), 3000)
        }
      })
    } catch {
      es = null
    }
  }
  if (!es) timer = window.setInterval(() => void poll(), 3000)

  return () => {
    stopped = true
    es?.close()
    if (timer) window.clearInterval(timer)
  }
}

export async function fetchNetplayRoom(roomId: string): Promise<NetplayRoom | null> {
  if (!netplayEnabled()) return null
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}`)
    if (!res.ok) return null
    return (await res.json()) as NetplayRoom
  } catch {
    return null
  }
}

/**
 * 切换自己在房间里的身份：上场当玩家，或退下来只看。
 * 用房间令牌鉴权（和上传存档同一套），改不了别人的。
 */
export async function setRoomRole(roomId: string, token: string, role: RoomRole): Promise<boolean> {
  if (!token) return false
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-netplay-token': token },
      body: JSON.stringify({ role }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 房间里在看的人数（老服务端没有这个字段时返回 0） */
export function viewersOf(room: NetplayRoom): number {
  return room.spectators ?? 0
}
