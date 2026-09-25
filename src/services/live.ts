/**
 * 直播（一人玩、多人看）的客户端。
 *
 * 和 netplay 的区别：netplay 是「一起玩」，需要 EmulatorJS 4.3.0-pre 那套输入同步；
 * 直播只需要主播那边的画布和声音，任何引擎都能拿到（Runtime 的 captureSources）。
 * 所以 GBA、DOS、Flash、J2ME 这些没有联机能力的核心，照样能开播。
 *
 * 画面和声音走 WebRTC 直连，不经过服务器；服务器只转发握手包（server/src/live.js）。
 *
 * socket.io 客户端不打进前端包，而是从自家后端 /socket.io/socket.io.js 现取 ——
 * 这样版本永远和服务端一致，也省下几十 KB 的首屏体积。模拟器 iframe 里那套联机
 * 用的也是同一个脚本。
 */
import { useSyncExternalStore } from 'react'
import { fallbackAfterErrors } from './sseFallback'
import { getToken, apiBase, TOKEN_CHANGED_EVENT } from './api'
import { getT } from './i18n'
import { fetchIceConfig, type IceConfig } from './netplay'
import type { Presence } from './presence'
import type { UserRole } from '@/types'
import { describeExport, looksLikeSocketIo, runAsCommonJs, umdGlobals } from '@/lib/umd'
import { liveEnabled } from './roomFlags'

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
type IoFactory = (uri: string, opts?: Record<string, unknown>) => LiveSocket

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

/** socket.io 客户端脚本地址（后端 serveClient: true 会把它发出来） */
export function socketScriptUrl(): string {
  return `${apiBase()}/socket.io/socket.io.js`
}

/**
 * 首选路子：**取源码，当 CommonJS 模块跑一遍**。
 *
 * `module` / `exports` 是 `new Function` 的**形参**，只在这段代码里可见 ——
 * 全局一个字节都不动。于是：
 *  · 不看页面上有没有别人占了 define / module / exports（UMD 第一支必然命中）
 *  · 不碰 `window.io`，js-dos 那个泄漏的同名全局也就不用再存来存去
 *    （见 [js-dos 泄漏全局 io] 那条：反过来覆盖它，DOS 游戏本身会跑不起来）
 *
 * 站点没有设 CSP，`new Function` 可用；真哪天加了 `unsafe-eval` 限制，
 * 或者 API 在别的域上没开 CORS，就退回下面那条老路子。
 */
async function loadIoAsModule(url: string): Promise<IoFactory> {
  const res = await fetch(url, { credentials: 'omit' })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  const exported = runAsCommonJs(await res.text())
  if (!looksLikeSocketIo(exported)) throw new Error(`${url} 跑完没导出 io()：${describeExport(exported)}`)
  return exported as IoFactory
}

/** 退路：老老实实插一个 <script>，装完把 window.io 原样放回去 */
function loadIoAsScript(url: string): Promise<IoFactory> {
  return new Promise<IoFactory>((resolve, reject) => {
    const win = window as unknown as { io?: unknown }
    const had = 'io' in win
    const prev = win.io
    const restore = () => {
      if (had) win.io = prev
      else delete win.io
    }
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => {
      const loaded = win.io
      restore()
      if (looksLikeSocketIo(loaded)) resolve(loaded as IoFactory)
      else reject(new Error(`${url} 装上了却没暴露 io()：${describeExport(loaded)}；${umdGlobals()}`))
    }
    script.onerror = () => {
      restore()
      reject(new Error(`${url} 加载失败（网络或反代）`))
    }
    document.head.appendChild(script)
  })
}

/** 拿到手的工厂自己收着，不再回头读全局 —— 后面再有脚本也夺不走 */
let ioFactory: IoFactory | null = null
let ioLoading: Promise<IoFactory> | null = null
function loadIo(): Promise<IoFactory> {
  if (ioFactory) return Promise.resolve(ioFactory)
  if (ioLoading) return ioLoading
  const url = socketScriptUrl()
  const win = window as unknown as { io?: unknown }
  // 别人已经把正牌 socket.io 放在全局了就直接用，省一次请求
  if (looksLikeSocketIo(win.io)) {
    ioFactory = win.io as IoFactory
    return Promise.resolve(ioFactory)
  }
  ioLoading = loadIoAsModule(url)
    .catch((e) => {
      // 走到这儿多半是 CORS 或者 CSP 禁了 eval。留一行，别把原因吞掉
      console.warn('[live] 取 socket.io 源码失败，改用 <script> 装', e)
      return loadIoAsScript(url)
    })
    .then((f) => {
      ioFactory = f
      return f
    })
    .catch((e) => {
      ioLoading = null // 允许下次重试（比如反代刚修好）
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
    auth: { token: getToken() || undefined },
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

/** 直播用的 ICE 配置，和联机共用同一个接口（TURN 凭证由后端现签） */
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
export async function liveIceConfig(): Promise<IceConfig> {
  try {
    return await fetchIceConfig()
  } catch {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], hasTurn: false, expiry: 0 }
  }
}

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
  try {
    const res = await fetch(`${apiBase()}/api/live/capacity`, { cache: 'no-store', signal })
    if (!res.ok) return true
    const capacity = (await res.json()) as Partial<LiveCapacity>
    return typeof capacity.available === 'boolean' ? capacity.available : true
  } catch {
    return true
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
/** 空数组用固定引用：useSyncExternalStore 要求快照引用稳定，否则会无限重渲染 */
const NO_LIVE_ROOMS: LiveRoomInfo[] = []

/** 和 fetchLiveRooms 的区别：这个会把失败抛出来，让 store 能区分「没人在播」和「后端不可达」 */
async function loadLiveRooms(): Promise<LiveRoomInfo[]> {
  const res = await fetch(`${apiBase()}/api/live/rooms`, { cache: 'no-store', headers: liveAuthHeaders() })
  if (!res.ok) throw new Error(String(res.status))
  const list = (await res.json()) as LiveRoomInfo[]
  return Array.isArray(list) ? list : []
}

const liveStore = (() => {
  let rooms: LiveRoomInfo[] = NO_LIVE_ROOMS
  const listeners = new Set<() => void>()
  let es: EventSource | null = null
  let stopFallback: (() => void) | null = null
  let timer = 0
  /** 当前连接按哪一张 JWT 建立；登录 / 退出后必须换通道，否则会沿用旧权限。 */
  let connectedToken = ''
  /** 让旧连接 / 旧 JWT 发起的迟到响应失效，避免登出后短暂显示成人房或陈旧房间。 */
  let generation = 0
  const emit = () => listeners.forEach((l) => l())

  /** 列表空了要真的清空 —— 主播下播之后卡片必须消失，不能因为「保留上次结果」一直挂着 */
  const apply = (next: LiveRoomInfo[]) => {
    rooms = next.length ? next : NO_LIVE_ROOMS
    emit()
  }

  const refresh = async () => {
    const mine = generation
    const token = getToken()
    try {
      const next = await loadLiveRooms()
      if (mine === generation && token === getToken()) apply(next)
    } catch {
      /* 后端暂时不可达时保留上次结果，别闪一下空列表 */
    }
  }

  /** 退回轮询（SSE 不可用、或后端还没有这个端点时） */
  const startPolling = () => {
    if (timer) return
    void refresh()
    timer = window.setInterval(() => void refresh(), LIST_POLL_MS)
  }

  const connect = () => {
    connectedToken = getToken()
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
        if (Array.isArray(list)) apply(list)
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
      window.clearInterval(timer)
      timer = 0
    }
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
export function useLiveRooms(): LiveRoomInfo[] {
  return useSyncExternalStore(liveStore.subscribe, liveStore.get, () => NO_LIVE_ROOMS)
}

/** 手动刷新（开播 / 下播之后立刻让列表跟上，不用等下一轮） */
export function refreshLiveRooms(): void {
  void liveStore.refresh()
}
