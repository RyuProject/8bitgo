/**
 * 联机房间：列表 + 心跳。
 *
 * 房间本身由 cloud-game 服务器管理（见 src/emulator/adapters/cloudgame.ts），
 * 但它不对外提供「有哪些房间」。所以每个正在联机的浏览器定期向本站后端
 * /api/rooms/heartbeat 报到，侧边栏「联机玩」从 /api/rooms 读列表。
 *
 * 没配置 VITE_API_URL 时房间列表不可用（联机本身仍可用，只是别人看不到你的房间，
 * 需要手动分享链接）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, apiEnabled } from './api'
import { getCurrentUser } from './auth'
import { randomId } from './localStore'
import type { Presence } from './presence'

export interface RoomMember {
  nickname: string
  playerIndex: number
  host: boolean
  presence?: Presence
}

export interface Room {
  roomId: string
  gameSlug: string
  createdAt: number
  host: { nickname: string; userId: string | null } | null
  players: number
  playerIndexes: number[]
  members: RoomMember[]
  /** 房主的设备 / 地区 / 网络。见 services/presence.ts */
  presence?: Presence
}

export const MAX_PLAYERS = 4
const HEARTBEAT_MS = 10_000
const LIST_POLL_MS = 8_000

/** 本浏览器的成员 id（游客也要有一个稳定身份） */
const MEMBER_KEY = '8bitgo.room.member'
export function memberId(): string {
  try {
    let id = sessionStorage.getItem(MEMBER_KEY)
    if (!id) {
      id = randomId('m')
      sessionStorage.setItem(MEMBER_KEY, id)
    }
    return id
  } catch {
    return randomId('m')
  }
}

const GUEST_KEY = '8bitgo.room.guest'
/** 显示名：登录用户用昵称，游客用「Guest-xxxx」并在本浏览器里保持稳定 */
export function displayName(): string {
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

export function roomsEnabled(): boolean {
  return apiEnabled()
}

/** 联机页面链接：朋友打开即可加入 */
export function roomLink(gameSlug: string, roomId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/games/${gameSlug}?room=${encodeURIComponent(roomId)}`
}

export async function fetchRooms(): Promise<Room[]> {
  if (!roomsEnabled()) return []
  return api.get<Room[]>('/api/rooms')
}

export async function fetchRoom(roomId: string): Promise<Room | null> {
  if (!roomsEnabled()) return null
  try {
    return await api.get<Room>(`/api/rooms/${encodeURIComponent(roomId)}`)
  } catch {
    return null
  }
}

/**
 * 在房间里期间保持心跳；返回停止函数（离开房间时调用，会立刻从列表移除）。
 */
export function keepAlive(input: { roomId: string; gameSlug: string; playerIndex: number; host: boolean }): () => void {
  if (!roomsEnabled()) return () => {}
  const me = memberId()
  let stopped = false
  /**
   * 上一次心跳的往返耗时，下一次心跳时报上去 —— 云端房间没有常驻连接，
   * 服务端量不到延迟，只能这么来（见 server/src/presence.js 的说明）。
   * 报的是上一次而不是这一次，因为这一次的耗时要等它回来才知道；
   * 心跳 10 秒一发，差这一拍无所谓。
   *
   * 注意这个数比 socket 心跳的 RTT 偏大：它含了一次完整的 HTTP 往返
   * 加上服务端处理时间。同一档阈值下云端房间会显得稍微「差」一点，
   * 但云端房间和 P2P 房间本来也不比这个。
   */
  let lastRtt: number | null = null
  const beat = () => {
    if (stopped) return
    const sentAt = Date.now()
    void api
      .post<Room>('/api/rooms/heartbeat', { ...input, memberId: me, nickname: displayName(), rtt: lastRtt })
      .then((room) => {
        lastRtt = Date.now() - sentAt
        cache.set(room)
      })
      .catch(() => {})
  }
  beat()
  const timer = window.setInterval(beat, HEARTBEAT_MS)
  return () => {
    stopped = true
    window.clearInterval(timer)
    void api.del(`/api/rooms/${encodeURIComponent(input.roomId)}/members/${me}`).catch(() => {})
    cache.remove(input.roomId)
  }
}

/* ---------------- 列表缓存（多个组件共享一份轮询） ---------------- */
const cache = (() => {
  let rooms: Room[] = []
  const listeners = new Set<() => void>()
  let timer = 0
  const emit = () => listeners.forEach((l) => l())
  const refresh = async () => {
    try {
      rooms = await fetchRooms()
      emit()
    } catch {
      /* 后端不可达时保留上次结果 */
    }
  }
  return {
    get: () => rooms,
    set(room: Room) {
      const i = rooms.findIndex((r) => r.roomId === room.roomId)
      rooms = i >= 0 ? rooms.map((r) => (r.roomId === room.roomId ? room : r)) : [room, ...rooms]
      emit()
    },
    remove(roomId: string) {
      // 乐观更新：自己先从人数里减掉，随后再拉一次真实列表
      rooms = rooms
        .map((r) => (r.roomId === roomId ? { ...r, players: Math.max(0, r.players - 1) } : r))
        .filter((r) => r.players > 0)
      emit()
      window.setTimeout(() => void refresh(), 500)
    },
    subscribe(l: () => void) {
      listeners.add(l)
      if (listeners.size === 1 && roomsEnabled()) {
        void refresh()
        timer = window.setInterval(() => void refresh(), LIST_POLL_MS)
      }
      return () => {
        listeners.delete(l)
        if (listeners.size === 0) window.clearInterval(timer)
      }
    },
    refresh,
  }
})()

/** 在线房间列表（自动轮询，多个组件共享一个定时器） */
export function useRooms(): Room[] {
  return useSyncExternalStore(cache.subscribe, cache.get, () => [])
}

/**
 * 某个房间的实时信息（进入房间页时用，用于选空闲手柄位）。
 * undefined = 还在查询；null = 查不到（房间已关闭，或没配置后端）
 */
export function useRoom(roomId: string | undefined): Room | null | undefined {
  const rooms = useRooms()
  // 轮询列表里已经有这个房间就直接用，不必额外发请求
  const fromList = roomId ? rooms.find((r) => r.roomId === roomId) : undefined
  // 列表里没有（比如刚从邀请链接进来、列表还没轮到）才单独查一次
  const [fetched, setFetched] = useState<{ roomId: string; room: Room | null } | null>(null)

  useEffect(() => {
    if (!roomId || fromList) return
    let cancelled = false
    void fetchRoom(roomId).then((r) => {
      if (!cancelled) setFetched({ roomId, room: r })
    })
    return () => {
      cancelled = true
    }
  }, [roomId, fromList])

  if (!roomId) return undefined
  if (fromList) return fromList
  // 只认当前 roomId 的查询结果，切换房间时不会短暂显示上一个
  return fetched?.roomId === roomId ? fetched.room : undefined
}

/** 下一个空闲的手柄位（0 起） */
export function freePlayerIndex(room: Room | null | undefined, max = MAX_PLAYERS): number {
  const taken = new Set(room?.playerIndexes ?? [])
  for (let i = 0; i < max; i++) if (!taken.has(i)) return i
  return max - 1
}
