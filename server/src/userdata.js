import { query } from './db.js'

/** 用户收藏的游戏 slug（最新在前） */
export async function favIds(userId) {
  const rows = await query('SELECT game_slug FROM favorites WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return rows.map((r) => r.game_slug)
}

/** 用户最近游玩的游戏 slug（最新在前，最多 12） */
export async function recentIds(userId) {
  const rows = await query('SELECT game_slug FROM recents WHERE user_id = ? ORDER BY played_at DESC LIMIT 12', [userId])
  return rows.map((r) => r.game_slug)
}
