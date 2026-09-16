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

/**
 * 记录最近游玩，只保留最近 12 条。站内页面和开放设备共用这一条写法，
 * 否则设备上已经开玩、账号的「最近在玩」却没有它，两个入口会长期对不上。
 */
export async function recordRecent(userId, slug) {
  const gameId = await gameIdBySlug(slug)
  if (!gameId) return false
  await query(
    `INSERT INTO recents (user_id, game_id, played_at) VALUES (?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE played_at = CURRENT_TIMESTAMP(3)`,
    [userId, gameId],
  )
  // MySQL 不允许 DELETE 的子查询直接再读同一张表，所以保留这层派生表。
  await query(
    `DELETE FROM recents
      WHERE user_id = ? AND game_id IN (
        SELECT game_id FROM (
          SELECT game_id FROM recents WHERE user_id = ? ORDER BY played_at DESC LIMIT 100 OFFSET 12
        ) old
      )`,
    [userId, userId],
  )
  return true
}
