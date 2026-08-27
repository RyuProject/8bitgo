/**
 * 搜索联想与「搜不到」的补救。
 *
 * 联想接口刻意做得比 /api/games 轻：只回列表要显示的那几列，不带类型/标签/ROM。
 * 用户每敲一个字就会调一次，多查一次关联表就是多一轮往返。
 */
import { api, apiEnabled } from './api'

export interface SuggestItem {
  slug: string
  title: string
  titleZh: string | null
  platform: string
  year: number | null
  icon: string
  cover: string | null
}

export interface SearchFallback {
  /** 拼写纠正的建议词，没有就是 null */
  suggestion: string | null
  /** 放宽条件之后捞回来的相关游戏 */
  related: SuggestItem[]
}

export function searchEnabled(): boolean {
  return apiEnabled()
}

export async function fetchSuggest(q: string, limit = 8): Promise<SuggestItem[]> {
  const text = q.trim()
  if (!text || !apiEnabled()) return []
  const res = await api.get<{ items: SuggestItem[] }>(
    `/api/games/suggest?q=${encodeURIComponent(text)}&limit=${limit}`,
  )
  return res.items ?? []
}

export async function fetchSearchFallback(q: string): Promise<SearchFallback> {
  const text = q.trim()
  if (!text || !apiEnabled()) return { suggestion: null, related: [] }
  return await api.get<SearchFallback>(`/api/games/search-fallback?q=${encodeURIComponent(text)}`)
}

/* ---------------- 最近搜索 ---------------- */

const RECENT_KEY = '8bitgo.recentSearches'
const RECENT_MAX = 8

export function recentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    // 隐私模式 / 存了脏数据：当作没有历史，不要让它把搜索框拖垮
    return []
  }
}

export function rememberSearch(q: string) {
  const text = q.trim()
  if (!text) return
  try {
    // 去重时按大小写不敏感比较，免得「Zelda」和「zelda」占两条
    const lower = text.toLowerCase()
    const next = [text, ...recentSearches().filter((x) => x.toLowerCase() !== lower)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 存不了就算了，不影响搜索本身 */
  }
}

export function clearRecentSearches() {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    /* ignore */
  }
}
