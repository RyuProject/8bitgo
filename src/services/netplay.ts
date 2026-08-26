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

/** gameId → slug 的反查表（只在用到时构建一次） */
let slugByGameId: Map<number, string> | null = null
export function slugForGameId(gameId: number, allSlugs: string[]): string | undefined {
  if (!slugByGameId) {
    slugByGameId = new Map()
    for (const s of allSlugs) slugByGameId.set(gameIdFor(s), s)
  }
  return slugByGameId.get(gameId)
}

export interface NetplayRoom {
  roomId: string
  gameId: number
  roomName: string
  createdAt: number
  host: { nickname: string } | null
  players: number
  max: number
  hasPassword: boolean
  members: Array<{ nickname: string; host: boolean }>
  kind: 'p2p'
  /** 房主掉线了，正在等人接手（60 秒内） */
  awaitingHost?: boolean
  /** 被选中接手的人（netplay 内部的 playerID） */
  nextHostUserId?: string | null
  /** 服务器上有没有存档可以接着玩 */
  hasState?: boolean
  /** 已经换过房主了，房间搬到了这个新 id（老邀请链接会带上它） */
  migratedTo?: string | null
}

/** 服务端根路径（NETPLAY_URL 形如 https://host/netplay） */
const apiBase = () => NETPLAY_URL.replace(/\/netplay$/, '')

/**
 * 房主定期把存档传上去，掉线时交给新房主。
 * gzip 之后 NES 大约 20KB、GBA 几十 KB，25 秒一次可以忽略不计。
 */
export async function uploadState(roomId: string, userId: string, state: Uint8Array): Promise<boolean> {
  try {
    let body: BodyInit = state as BodyInit
    if (typeof CompressionStream === 'function') {
      const stream = new Blob([state as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
      body = await new Response(stream).blob()
    }
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-netplay-user': userId },
      body,
    })
    return res.ok
  } catch {
    return false
  }
}

/** 取存档（自动解 gzip）。没有就返回 null */
export async function downloadState(roomId: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(roomId)}/state`)
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

/** 新房主开好新房间后，把新旧房间接上（老邀请链接才能继续有效） */
export async function migrateRoom(oldRoomId: string, newRoomId: string, userId: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/api/netplay/rooms/${encodeURIComponent(oldRoomId)}/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newRoomId, userId }),
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

/* ---------------- 房间列表（轮询，多个组件共享） ---------------- */
const POLL_MS = 6_000

const store = (() => {
  let rooms: NetplayRoom[] = []
  const listeners = new Set<() => void>()
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

  return {
    get: () => rooms,
    subscribe(l: () => void) {
      listeners.add(l)
      if (listeners.size === 1 && netplayEnabled()) {
        void refresh()
        timer = window.setInterval(() => void refresh(), POLL_MS)
      }
      return () => {
        listeners.delete(l)
        if (listeners.size === 0) window.clearInterval(timer)
      }
    },
    refresh,
  }
})()

export function useNetplayRooms(): NetplayRoom[] {
  return useSyncExternalStore(store.subscribe, store.get, () => [])
}

/** 手动刷新（开完房间后立刻让列表出现自己） */
export function refreshNetplayRooms(): void {
  void store.refresh()
}

/**
 * 查单个房间。走的是「顺着别名解析」的接口，所以换过房主之后老邀请链接照样能查到，
 * 并且会在 migratedTo 里告诉你新的房间 id。
 */
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
