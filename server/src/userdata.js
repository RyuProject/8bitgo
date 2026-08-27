import { query } from './db.js'

/**
 * 用户的收藏 / 最近游玩。
 *
 * v2 里这两张表存的是 game_id（有外键，删游戏自动级联），但对外仍然给 slug ——
 * 前端和 URL 都按 slug 工作，没必要把内部主键漏出去。
 */

/** 用户「稍后玩」的游戏 slug（最新在前） */
export async function favIds(userId) {
  const rows = await query(
    `SELECT g.slug FROM favorites f JOIN games g ON g.id = f.game_id
      WHERE f.user_id = ? ORDER BY f.created_at DESC`,
    [userId],
  )
  return rows.map((r) => r.slug)
}

/** 用户最近游玩的游戏 slug（最新在前，最多 12） */
export async function recentIds(userId) {
  const rows = await query(
    `SELECT g.slug FROM recents r JOIN games g ON g.id = r.game_id
      WHERE r.user_id = ? ORDER BY r.played_at DESC LIMIT 12`,
    [userId],
  )
  return rows.map((r) => r.slug)
}

/** slug -> games.id，找不到返回 undefined */
export async function gameIdBySlug(slug) {
  const rows = await query('SELECT id FROM games WHERE slug = ?', [slug])
  return rows[0]?.id
}
