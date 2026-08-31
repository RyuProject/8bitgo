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
  /** 'popular' | 'newest' | 'name' | 'home'（home = 按首页排序号） */
  sort?: string
  /** 'all' | 'picked'（只看上了首页的）| 'unpicked' */
  home?: 'all' | 'picked' | 'unpicked'
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
  if (q.home === 'picked') sp.set('home', '1')
  else if (q.home === 'unpicked') sp.set('home', '0')
  if (q.page) sp.set('page', String(q.page))
  if (q.pageSize) sp.set('pageSize', String(q.pageSize))
  return api.get<Paged<Game>>(`/api/games?${sp.toString()}`, true)
}

/**
 * 新增 / 整体覆盖一款游戏。返回后端保存后的完整对象。
 *
 * DOS 共享系统镜像是后来才加入的字段。部署时如果只更新了前端静态文件、没有重启
 * Express，旧后端会把不认识的 JSON 字段直接忽略，却仍然返回 200。后台过去会因此显示
 * “已保存”，重新编辑时镜像路径却消失。这里用服务端回包做一次回读校验，让版本错位
 * 当场报清楚，也保留尚未保存的表单内容。
 */
export async function upsertGame(game: Game): Promise<Game> {
  const saved = await api.put<Game>(`/api/games/${encodeURIComponent(game.slug)}`, game, true)
  const requestedSystem = game.dosSystem?.trim() || undefined
  const persistedSystem = saved.dosSystem?.trim() || undefined
  if (requestedSystem !== persistedSystem) {
    throw new Error(
      '服务端没有保存 Windows 系统镜像。请在服务器运行数据库迁移并重启 8bitgo-api，然后重新保存。',
    )
  }
  const requestedWindowsVersion = game.dosWindowsVersion
  if (requestedWindowsVersion !== saved.dosWindowsVersion) {
    throw new Error(
      '服务端没有保存 Windows 版本。请在服务器运行数据库迁移并重启 8bitgo-api，然后重新保存。',
    )
  }
  const requestedConfig = game.dosboxConfig?.trim() || undefined
  const persistedConfig = saved.dosboxConfig?.trim() || undefined
  if (requestedConfig !== persistedConfig) {
    throw new Error(
      '服务端没有保存 DOSBox-X 配置。请在服务器运行数据库迁移并重启 8bitgo-api，然后重新保存。',
    )
  }
  return saved
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

/** 本次页面会话里已经上报过的游戏，省掉重开模拟器时的无谓请求 */
const reportedPlays = new Set<string>()

/**
 * 上报一次真实游玩。在模拟器**真的跑起来**时调用（不是打开详情页）。
 *
 * 故意做成「失败也不管」：这只是一个计数，网络不通、后端没起、被广告拦截器挡掉，
 * 都不该影响玩家正在玩的游戏。
 *
 * 真正的去重在服务端：一个人对一款游戏只算一次，登录了按账号、没登录按 IP，
 * 记录落库、永久有效（见 server/src/playcount.js）。上面那个 Set 只是省请求，
 * 不承担正确性 —— 刷新页面它就空了。
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
