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
import { apiBase, apiEnabled } from './api'
import { getT } from './i18n'
import { fetchIceConfig } from './netplay'
import type { Presence } from './presence'

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
  /** 主播的设备 / 地区 / 网络，服务端从握手信息里看出来的。见 services/presence.ts */
  presence?: Presence
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

export function liveEnabled(): boolean {
  return apiEnabled()
}

/** socket.io 客户端脚本地址（后端 serveClient: true 会把它发出来） */
export function socketScriptUrl(): string {
  return `${apiBase()}/socket.io/socket.io.js`
}

let ioLoading: Promise<IoFactory> | null = null
function loadIo(): Promise<IoFactory> {
  if (ioLoading) return ioLoading
  ioLoading = new Promise<IoFactory>((resolve, reject) => {
    const win = window as unknown as { io?: IoFactory }
    if (win.io) return resolve(win.io)
    const script = document.createElement('script')
    script.src = socketScriptUrl()
    script.async = true
    script.onload = () => (win.io ? resolve(win.io) : reject(new Error('socket.io 已加载但没有暴露 io()')))
    script.onerror = () => reject(new Error(socketScriptUrl()))
    document.head.appendChild(script)
  }).catch((e) => {
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
  })
  await new Promise<void>((resolve, reject) => {
    /**
     * ⚠️ 这两个处理器只管**首连**，连上之后必须摘掉。
     * 以前没摘：socket.io 自动重连时每一次失败的尝试都会再触发 connect_error，
     * 这里就把 socket 关了 —— 服务器重启那几秒、网络抖一下，重连从此永久停止，
     * 主播的房间和观众的画面就这么没了，而且没有任何报错。
     */
    const onConnect = () => {
      window.clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      resolve()
    }
    const onError = ((err: Error) => {
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
    }) as (...args: never[]) => void
    const timer = window.setTimeout(() => onError(new Error(getT().runtime.liveTimeout) as never), 15_000)
    socket.on('connect', onConnect)
    socket.on('connect_error', onError)
  })
  return socket
}

/** 直播用的 ICE 配置，和联机共用同一个接口（TURN 凭证由后端现签） */
export async function liveIceServers(): Promise<RTCIceServer[]> {
  try {
    return (await fetchIceConfig()).iceServers
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }]
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
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []
    return (await res.json()) as LiveRoomInfo[]
  } catch {
    return []
  }
}

export async function fetchLiveRoom(roomId: string): Promise<LiveRoomInfo | null> {
  if (!liveEnabled()) return null
  try {
    const res = await fetch(`${apiBase()}/api/live/rooms/${encodeURIComponent(roomId)}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as LiveRoomInfo
  } catch {
    return null
  }
}

/* ---------------- 正在直播的房间列表（轮询，多个组件共享一个定时器） ---------------- */

/**
 * 为什么是轮询而不是 SSE：直播房间只存在于 /live 命名空间的内存里（server/src/live.js），
 * 开播 / 下播都是 socket 事件，没有现成的推送通道。8 秒一次和联机列表原来的节奏一致，
 * 大厅这种页面够用了；真要做到「一开播就出现」得在 attachLive 里再挂一路 SSE。
 */
const LIST_POLL_MS = 8_000
/** 空数组用固定引用：useSyncExternalStore 要求快照引用稳定，否则会无限重渲染 */
const NO_LIVE_ROOMS: LiveRoomInfo[] = []

/** 和 fetchLiveRooms 的区别：这个会把失败抛出来，让 store 能区分「没人在播」和「后端不可达」 */
async function loadLiveRooms(): Promise<LiveRoomInfo[]> {
  const res = await fetch(`${apiBase()}/api/live/rooms`, { cache: 'no-store' })
  if (!res.ok) throw new Error(String(res.status))
  const list = (await res.json()) as LiveRoomInfo[]
  return Array.isArray(list) ? list : []
}

const liveStore = (() => {
  let rooms: LiveRoomInfo[] = NO_LIVE_ROOMS
  const listeners = new Set<() => void>()
  let timer = 0
  const emit = () => listeners.forEach((l) => l())

  const refresh = async () => {
    try {
      const next = await loadLiveRooms()
      // 列表空了要真的清空 —— 主播下播之后卡片必须消失，不能因为「保留上次结果」一直挂着
      rooms = next.length ? next : NO_LIVE_ROOMS
      emit()
    } catch {
      /* 后端暂时不可达时保留上次结果，别闪一下空列表 */
    }
  }

  return {
    get: () => rooms,
    subscribe(l: () => void) {
      listeners.add(l)
      if (listeners.size === 1 && liveEnabled()) {
        void refresh()
        timer = window.setInterval(() => void refresh(), LIST_POLL_MS)
      }
      return () => {
        listeners.delete(l)
        if (listeners.size === 0 && timer) {
          window.clearInterval(timer)
          timer = 0
        }
      }
    },
    refresh,
  }
})()

/** 正在直播的房间（自动轮询，多个组件共享一个定时器） */
export function useLiveRooms(): LiveRoomInfo[] {
  return useSyncExternalStore(liveStore.subscribe, liveStore.get, () => NO_LIVE_ROOMS)
}

/** 手动刷新（开播 / 下播之后立刻让列表跟上，不用等下一轮） */
export function refreshLiveRooms(): void {
  void liveStore.refresh()
}
