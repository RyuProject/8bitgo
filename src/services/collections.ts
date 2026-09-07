/**
 * 合集的前端接口层。
 *
 * 全部走 /api/collections（见 server/src/routes/collections.js）。读是公开的，
 * 写要登录 —— 令牌由 services/api.ts 统一带上，这里不重复处理。
 */
import { api } from './api'
import type { Collection, CollectionDetail, CollectionPage, Game } from '@/types'
import type { Paged } from './pageData'

/** 公开列表，按「最近有动静」排 */
export function listCollections(page = 1, pageSize = 24): Promise<CollectionPage> {
  return api.get<CollectionPage>(`/api/collections?page=${page}&pageSize=${pageSize}`)
}

export function getCollection(id: number | string): Promise<CollectionDetail> {
  return api.get<CollectionDetail>(`/api/collections/${encodeURIComponent(String(id))}`)
}

/** 我的合集。「加入合集」那个下拉也用它，所以不分页 */
export function myCollections(): Promise<{ items: Collection[] }> {
  return api.get<{ items: Collection[] }>('/api/collections/mine')
}

export function createCollection(input: { title: string; kind?: string; description?: string }): Promise<Collection> {
  return api.post<Collection>('/api/collections', input)
}

export function updateCollection(
  id: number,
  patch: { title?: string; kind?: string; description?: string },
): Promise<Collection> {
  return api.patch<Collection>(`/api/collections/${id}`, patch)
}

export function deleteCollection(id: number): Promise<{ ok: boolean }> {
  return api.del<{ ok: boolean }>(`/api/collections/${id}`)
}

/** 「添加游戏」弹窗每页拿多少。弹窗里是两三列的小格子，一次给太多要滚很久，给太少要频繁点「加载更多」 */
export const PICKER_PAGE_SIZE = 12

/**
 * 「添加游戏」弹窗的搜索：走公开的 /api/games?q=，拿到的是完整的 Game（能直接喂 GameCover / 加进合集）。
 * 不用 /api/games/suggest —— 那个是给顶栏联想做的瘦身版，字段不够画卡片。
 */
export function searchGamesForCollection(q: string, page = 1): Promise<Paged<Game>> {
  const sp = new URLSearchParams({ q: q.trim(), page: String(page), pageSize: String(PICKER_PAGE_SIZE) })
  return api.get<Paged<Game>>(`/api/games?${sp.toString()}`)
}

/** 加游戏。重复加入是幂等的：服务端返回 added=false，不报错 */
export function addGameToCollection(id: number, gameSlug: string): Promise<{ ok: boolean; added: boolean }> {
  return api.post<{ ok: boolean; added: boolean }>(`/api/collections/${id}/games`, { gameSlug })
}

/**
 * 手动排序：把**整个当前顺序**发上去，服务端按下标写 position。
 * 只认作者；不认识的 slug 服务端会忽略（客户端手里的名单可能比服务端旧几秒）。
 */
export function reorderCollectionGames(id: number, slugs: string[]): Promise<{ ok: boolean; ordered: number }> {
  return api.patch<{ ok: boolean; ordered: number }>(`/api/collections/${id}/order`, { slugs })
}

export function removeGameFromCollection(id: number, gameSlug: string): Promise<{ ok: boolean; removed: boolean }> {
  return api.del<{ ok: boolean; removed: boolean }>(`/api/collections/${id}/games/${encodeURIComponent(gameSlug)}`)
}

/** 下架 / 恢复。只有管理员调得动，普通用户会拿到 403 */
export function setCollectionHidden(id: number, hidden: boolean): Promise<{ ok: boolean; hidden: boolean }> {
  return api.patch<{ ok: boolean; hidden: boolean }>(`/api/collections/${id}/hidden`, { hidden })
}

/**
 * 「类型」那一格给的建议。**只是建议** —— 表单是自由输入框，这些只是点一下就填上的快捷方式。
 * 目的是让常见的几种写法收敛一点，而不是把作者框死（「小时候的暑假」也该是合法的类型）。
 */
export const KIND_SUGGESTIONS = ['系列', '主题', '年代', '平台', '通关向', '联机']
