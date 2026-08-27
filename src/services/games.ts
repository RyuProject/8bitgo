/**
 * 平台 / 类型的配置查找。
 *
 * v1 这里是整个「数据访问层」：把全量游戏库读进内存，再用 JS 做筛选、排序、分页。
 * v2 之后那些职责分别搬到了：
 *   - services/pageData.ts  按路由向后端取数（列表、详情、facets）
 *   - services/gameCache.ts 按 slug 批量取游戏
 * 这里只剩下对**代码里的配置**（平台表、类型表）的查找 —— 它们不在数据库里，
 * 因为 platform.runtime / core 直接对应模拟器适配器，PlatformId / GenreId 还是 TS 类型。
 */
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import type { Genre, Platform } from '@/types'

export const DEFAULT_PAGE_SIZE = 24

export function getPlatform(id: string): Platform | undefined {
  return platformMap[id]
}

export function getGenre(id: string): Genre | undefined {
  return genreMap[id]
}

/** 平台 / 类型带上「有多少款游戏」，数量由后端 facets 提供 */
export interface PlatformWithCount extends Platform {
  count: number
}
export interface GenreWithCount extends Genre {
  count: number
}
