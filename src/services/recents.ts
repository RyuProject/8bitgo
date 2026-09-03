/**
 * 「曾经玩过」的本机记录。
 *
 * 登录用户的最近记录在后端（users.recent / POST /api/me/recents），
 * 但访客也该看得到自己刚玩过什么 —— 那份就存在这台浏览器的 localStorage 里。
 * 这里只管访客那一份，登录后以后端为准（见 Sidebar / auth.recordRecent）。
 *
 * 故意不 import auth：auth 要调 pushGuestRecent，两边互相 import 容易绕成环。
 */
import { useSyncExternalStore } from 'react'

export const GUEST_RECENTS_KEY = '8bitgo.recents'
/** 与后端 users.recent 的上限保持一致 */
const MAX = 12

const listeners = new Set<() => void>()
/** useSyncExternalStore 要求快照引用稳定：内容没变就必须返回同一个数组 */
let cache: string[] = []
let loaded = false

function read(): string[] {
  try {
    const raw = localStorage.getItem(GUEST_RECENTS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : null
    if (!Array.isArray(list)) return []
    return list.filter((s): s is string => typeof s === 'string').slice(0, MAX)
  } catch {
    return []
  }
}

export function guestRecents(): string[] {
  if (!loaded) {
    cache = read()
    loaded = true
  }
  return cache
}

/** 记一款游戏；已经在列表里就提到最前面。返回是否真的写了。 */
export function pushGuestRecent(slug: string): void {
  const next = [slug, ...guestRecents().filter((s) => s !== slug)].slice(0, MAX)
  if (next.join() === cache.join()) return
  cache = next
  try {
    localStorage.setItem(GUEST_RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式下写不进去，内存里那份照样能用 */
  }
  for (const l of listeners) l()
}

export function clearGuestRecents(): void {
  if (!cache.length) {
    cache = []
    loaded = true
    return
  }
  cache = []
  try {
    localStorage.removeItem(GUEST_RECENTS_KEY)
  } catch {
    /* ignore */
  }
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== GUEST_RECENTS_KEY) return
    loaded = false
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

const EMPTY: string[] = []

/**
 * 访客的「曾经玩过」。服务端快照恒为空数组 —— 记录只在浏览器里，
 * 首帧跟着服务端一起渲染成空，hydration 之后才补上（同 useCurrentUser 的处理）。
 */
export function useGuestRecents(): string[] {
  return useSyncExternalStore(subscribe, guestRecents, () => EMPTY)
}
