/**
 * 游戏数据存储。
 *
 * 两种模式，取决于有没有配 VITE_API_URL：
 *
 * 1. 已配后端（remote 模式）：**一切以数据库为准**。列表来自 /api/games，
 *    内置数据 src/data/games.ts 与 localStorage 副本都不参与——数据库是空的，
 *    后台就显示空，不会拿内置的 91 款来充数。首次使用请到「后台 → 数据 →
 *    导入内置数据到数据库」把内置目录写进库里（或在 server/ 下跑 npm run seed）。
 *
 * 2. 没配后端：沿用内置数据 + localStorage 的纯浏览器模式，便于离线开发。
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
  // 配了后端就完全以数据库为准：内置数据与 localStorage 副本都不再参与
  remote: apiEnabled,
})

/** 当前完整列表（含已下架的游戏） */
export const loadGames = gamesStore.load
export const saveGames = gamesStore.save
export const resetGames = gamesStore.reset
export const hasLocalChanges = gamesStore.hasLocalChanges
export const useAllGames = gamesStore.useAll
export const exportGamesJson = gamesStore.exportJson
export const importGamesJson = gamesStore.importJson

/**
 * 从后端拉取游戏，灌入本地缓存（组件仍同步读取）。未配置后端时不做任何事。
 *
 * @param all true = 连已下架的一起要（后台用，需要管理员口令）。
 *            前台不要传，接口默认只给上架的 —— 下架的游戏不该对外可见。
 */
export async function hydrateGames(all = false): Promise<void> {
  if (!apiEnabled()) return
  const list = await api.get<Game[]>(all ? '/api/games?all=1' : '/api/games', all)
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
