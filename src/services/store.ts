/**
 * 游戏数据的写操作与后台读取（schema v2）。
 *
 * v1 在这里维护一份「整个游戏库」的内存 / localStorage 副本，前台后台都从里面读。
 * v2 不再全量加载：
 *   - 前台按路由取数，见 services/pageData.ts
 *   - 后台按页取数，用下面的 fetchAdminGames()
 *   - 「我有几个 slug 要对应的游戏」用 services/gameCache.ts
 *
 * 这里只留写操作，以及后台专用的分页读取。
 */
import type { Game } from '@/types'
import { api, apiEnabled } from './api'
import type { Paged } from './pageData'

export interface AdminGameQuery {
  q?: string
  platform?: string
  /** 'all' | 'visible' | 'hidden'，由服务端筛选，所以 total 和翻页都是全库口径 */
  status?: 'all' | 'visible' | 'hidden'
  /** 'popular' | 'newest' | 'name' */
  sort?: string
  page?: number
  pageSize?: number
}

/**
 * 后台的游戏列表：带 ?all=1，所以包含已下架的，需要管理员口令。
 * 关键字、平台、上下架状态、排序全部由服务端处理 —— 在前端过滤会让
 * total 和翻页失去意义（「只看下架」变成在当前页的 24 条里挑）。
 */
export async function fetchAdminGames(q: AdminGameQuery = {}): Promise<Paged<Game>> {
  if (!apiEnabled()) {
    return { items: [], total: 0, page: 1, pageSize: 24, totalPages: 1 }
  }
  const sp = new URLSearchParams({ all: '1' })
  if (q.q) sp.set('q', q.q)
  if (q.platform && q.platform !== 'all') sp.set('platform', q.platform)
  if (q.status && q.status !== 'all') sp.set('status', q.status)
  if (q.sort) sp.set('sort', q.sort)
  if (q.page) sp.set('page', String(q.page))
  if (q.pageSize) sp.set('pageSize', String(q.pageSize))
  return api.get<Paged<Game>>(`/api/games?${sp.toString()}`, true)
}

/** 新增 / 整体覆盖一款游戏。返回后端保存后的完整对象。 */
export async function upsertGame(game: Game): Promise<Game> {
  return api.put<Game>(`/api/games/${encodeURIComponent(game.slug)}`, game, true)
}

export async function deleteGame(slug: string): Promise<void> {
  await api.del(`/api/games/${encodeURIComponent(slug)}`, true)
}

/**
 * 局部更新（绑定 ROM、上下架…）。
 *
 * 后端按「字段在不在请求里」判断要不要更新，所以 undefined 要显式转成 null
 * （= 清空），否则 JSON.stringify 会把这个键整个丢掉，变成「没提到就不改」。
 */
export async function patchGame(slug: string, patch: Partial<Game>): Promise<Game> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) body[k] = v === undefined ? null : v
  return api.patch<Game>(`/api/games/${encodeURIComponent(slug)}`, body, true)
}

export async function setGameHidden(slug: string, hidden: boolean): Promise<Game> {
  return patchGame(slug, { hidden })
}

/** 本次页面会话里已经上报过的游戏，避免重开模拟器重复计数 */
const reportedPlays = new Set<string>()

/**
 * 上报一次真实游玩。在模拟器**真的跑起来**时调用（不是打开详情页）。
 *
 * 故意做成「失败也不管」：这只是一个计数，网络不通、后端没起、被广告拦截器挡掉，
 * 都不该影响玩家正在玩的游戏。服务端还会再按 IP 去重一次。
 */
export function recordPlay(slug: string): void {
  if (!slug || !apiEnabled() || reportedPlays.has(slug)) return
  reportedPlays.add(slug)
  void api.post(`/api/games/${encodeURIComponent(slug)}/play`).catch(() => {
    reportedPlays.delete(slug)
  })
}

/** 后台概览的全库聚合（在数据库里算，不把全库拉下来 reduce） */
export interface AdminStats {
  games: { total: number; visible: number; hidden: number; withRom: number; visibleWithRom: number }
  plays: number
  posts: { total: number; published: number; draft: number }
}

export async function fetchAdminStats(): Promise<AdminStats> {
  return api.get<AdminStats>('/api/admin/stats', true)
}
