import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireUser } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds, gameIdBySlug } from '../userdata.js'

export const meRouter = Router()
meRouter.use(requireUser)

async function publicWithData(userRow) {
  const [f, r] = await Promise.all([favIds(userRow.id), recentIds(userRow.id)])
  return userRowToPublic(userRow, f, r)
}

/** 改资料（昵称 / 头像） */
meRouter.patch('/', async (req, res, next) => {
  try {
    const patch = {}
    if (req.body.nickname !== undefined) {
      const n = String(req.body.nickname).trim()
      if (n.length < 2 || n.length > 16) return res.status(400).json({ error: '昵称需要 2–16 个字符' })
      patch.nickname = n
    }
    if (req.body.avatar) patch.avatar = String(req.body.avatar)
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `\`${k}\` = ?`).join(', ')
      await query(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(patch), req.user.id])
    }
    const row = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])
    res.json(await publicWithData(row))
  } catch (e) {
    next(e)
  }
})

/**
 * 加入 / 移出「稍后玩」（切换），返回最新列表。
 * 路径上仍然用 slug，内部转成 game_id 存 —— 外键保证不会写进不存在的游戏。
 */
meRouter.post('/favorites/:slug', async (req, res, next) => {
  try {
    const { id } = req.user
    const gameId = await gameIdBySlug(req.params.slug)
    if (!gameId) return res.status(404).json({ error: '游戏不存在' })
    const has = await queryOne('SELECT 1 AS x FROM favorites WHERE user_id = ? AND game_id = ?', [id, gameId])
    if (has) await query('DELETE FROM favorites WHERE user_id = ? AND game_id = ?', [id, gameId])
    else await query('INSERT INTO favorites (user_id, game_id) VALUES (?, ?)', [id, gameId])
    res.json({ favorited: !has, favorites: await favIds(id) })
  } catch (e) {
    next(e)
  }
})

/** 记录最近游玩，只保留最近 12 条 */
meRouter.post('/recents/:slug', async (req, res, next) => {
  try {
    const { id } = req.user
    const gameId = await gameIdBySlug(req.params.slug)
    if (!gameId) return res.status(404).json({ error: '游戏不存在' })
    await query(
      `INSERT INTO recents (user_id, game_id, played_at) VALUES (?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE played_at = CURRENT_TIMESTAMP(3)`,
      [id, gameId],
    )
    // 超出 12 条的旧记录删掉。子查询要套一层派生表：
    // MySQL 不允许在 DELETE 的子查询里直接再查同一张表。
    await query(
      `DELETE FROM recents
        WHERE user_id = ? AND game_id IN (
          SELECT game_id FROM (
            SELECT game_id FROM recents WHERE user_id = ? ORDER BY played_at DESC LIMIT 100 OFFSET 12
          ) old
        )`,
      [id, id],
    )
    res.json({ recent: await recentIds(id) })
  } catch (e) {
    next(e)
  }
})
