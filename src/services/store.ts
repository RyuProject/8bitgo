/**
 * 游戏数据存储。
 *
 * 默认使用 src/data/games.ts 里的内置数据；在后台 (/admin) 做过修改后，
 * 完整的游戏列表会保存到 localStorage，前台与后台都从这里读取。
 * 「重置」即删除 localStorage 里的副本，恢复内置数据。
 */
import { games as builtinGames } from '@/data/games'
import type { Game } from '@/types'
import { createLocalStore } from './localStore'
import { api, apiEnabled } from './api'

export const STORAGE_KEY = '8bitgo.admin.games'

function isGame(x: unknown): x is Game {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Game).slug === 'string' &&
    typeof (x as Game).title === 'string' &&
    typeof (x as Game).platform === 'string' &&
    Array.isArray((x as Game).genres)
  )
}

export const gamesStore = createLocalStore<Game>({
  key: STORAGE_KEY,
  initial: builtinGames,
  getId: (g) => g.slug,
  validate: isGame,
})

/** 当前完整列表（含已下架的游戏） */
export const loadGames = gamesStore.load
export const saveGames = gamesStore.save
export const resetGames = gamesStore.reset
export const hasLocalChanges = gamesStore.hasLocalChanges
export const useAllGames = gamesStore.useAll
export const exportGamesJson = gamesStore.exportJson
export const importGamesJson = gamesStore.importJson

/** 开机时从后端拉取游戏，灌入本地缓存（组件仍同步读取）。未配置后端时不做任何事。 */
export async function hydrateGames(): Promise<void> {
  if (!apiEnabled()) return
  const list = await api.get<Game[]>('/api/games')
  if (Array.isArray(list)) gamesStore.save(list)
}

/** 新增 / 覆盖游戏：配置后端时写库，同时更新本地缓存 */
export async function upsertGame(game: Game): Promise<void> {
  if (apiEnabled()) await api.put(`/api/games/${encodeURIComponent(game.slug)}`, game, true)
  gamesStore.upsert(game)
}

export async function deleteGame(slug: string): Promise<void> {
  if (apiEnabled()) await api.del(`/api/games/${encodeURIComponent(slug)}`, true)
  gamesStore.remove(slug)
}

export async function setGameHidden(slug: string, hidden: boolean): Promise<void> {
  if (apiEnabled()) await api.patch(`/api/games/${encodeURIComponent(slug)}`, { hidden }, true)
  gamesStore.update(slug, { hidden })
}
