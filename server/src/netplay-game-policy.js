import { queryOne } from './db.js'
import { netplayGameId } from '../../shared/netplay-game-id.js'
import { gameSupportsNetplay, normalizeGamePlayers } from '../../shared/netplay-players.js'

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

  const row = await loadPolicyRow(slug)
  if (!row || Number(row.hidden) === 1) return null

  // 只看 players 会绕过后台的「是否支持联机」开关；只看 multiplayer 又会把一人脏数据
  // 宣传成可联机。两列必须同时成立，和公开 API / 页面使用同一条规则。
  if (!gameSupportsNetplay(row.multiplayer, row.players)) return null
  const maxPlayers = normalizeGamePlayers(row.players)
  // adult：成人游戏的联机房只对通过年龄门的登录用户可见 / 可进（§2.23，与直播同一条规则），
  // 由各房间注册表在列表与进房时按它过滤。
  return { gameSlug: String(row.slug), gameId: netplayGameId(row.slug), maxPlayers, adult: Number(row.adult) === 1 }
}

/*
  每次开房都要查一次 games 表，走的是全站共用的 10 连接池；刷开房的脚本会把 SSR 也拖慢。
  按 slug 缓存 30 秒（含「查无此游戏」）：后台改人数 / 下架最多晚 30 秒生效，开房已有的房间不受影响。
  同一 slug 并发的查询合并成一次。
*/
const POLICY_TTL_MS = 30_000
const POLICY_CACHE_MAX = 2000
const policyCache = new Map()

async function loadPolicyRow(slug) {
  const hit = policyCache.get(slug)
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.row
  if (hit?.pending) return hit.pending
  const pending = queryOne('SELECT slug, players, multiplayer, hidden, adult FROM games WHERE slug = ? LIMIT 1', [slug])
  policyCache.set(slug, { at: 0, pending })
  try {
    const row = await pending
    if (policyCache.size > POLICY_CACHE_MAX) policyCache.delete(policyCache.keys().next().value)
    policyCache.set(slug, { at: Date.now(), row })
    return row
  } catch (error) {
    policyCache.delete(slug)
    throw error
  }
}

/** 测试与后台写入后可调用，立刻作废缓存。 */
export function clearGameRoomPolicyCache() {
  policyCache.clear()
}
