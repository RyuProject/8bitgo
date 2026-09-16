import { queryOne } from './db.js'
import { netplayGameId } from '../../shared/netplay-game-id.js'
import { normalizeGamePlayers } from '../../shared/netplay-players.js'

/**
 * 从 games 表读取这一款游戏真正允许的手柄位数。
 *
 * 客户端传来的 maxPlayers 只能用于兼容旧协议，不能作为权限依据；否则改一行 JS 就能把
 * 后台配置成双人的游戏开成四人房。下架游戏和单人游戏都不允许新建联机房。
 */
export async function resolveGameRoomPolicy({ gameSlug, gameId } = {}) {
  const slug = typeof gameSlug === 'string' ? gameSlug.trim().slice(0, 160) : ''
  if (!slug || slug.startsWith('local:')) return null

  const expectedGameId = netplayGameId(slug)
  if (gameId !== undefined && gameId !== null && String(gameId) !== String(expectedGameId)) return null

  const row = await queryOne('SELECT slug, players, hidden FROM games WHERE slug = ? LIMIT 1', [slug])
  if (!row || Number(row.hidden) === 1) return null

  const maxPlayers = normalizeGamePlayers(row.players)
  if (maxPlayers < 2) return null
  return { gameSlug: String(row.slug), gameId: netplayGameId(row.slug), maxPlayers }
}
