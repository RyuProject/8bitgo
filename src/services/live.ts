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
import { apiBase, apiEnabled } from './api'
import { fetchIceConfig } from './netplay'

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
    const timer = window.setTimeout(() => reject(new Error('connect timeout')), 15_000)
    socket.on('connect', () => {
      window.clearTimeout(timer)
      resolve()
    })
    socket.on('connect_error', ((err: Error) => {
      window.clearTimeout(timer)
      reject(err)
    }) as (...args: never[]) => void)
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
