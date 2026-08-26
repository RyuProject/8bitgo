import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireUser } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds } from '../userdata.js'

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

/** 收藏 / 取消收藏（切换），返回最新收藏列表 */
meRouter.post('/favorites/:slug', async (req, res, next) => {
  try {
    const { id } = req.user
    const slug = req.params.slug
    const has = await queryOne('SELECT 1 AS x FROM favorites WHERE user_id = ? AND game_slug = ?', [id, slug])
    if (has) await query('DELETE FROM favorites WHERE user_id = ? AND game_slug = ?', [id, slug])
    else await query('INSERT INTO favorites (user_id, game_slug) VALUES (?, ?)', [id, slug])
    res.json({ favorited: !has, favorites: await favIds(id) })
  } catch (e) {
    next(e)
  }
})

/** 记录最近游玩 */
meRouter.post('/recents/:slug', async (req, res, next) => {
  try {
    const { id } = req.user
    const slug = req.params.slug
    await query(
      'INSERT INTO recents (user_id, game_slug, played_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE played_at = CURRENT_TIMESTAMP',
      [id, slug],
    )
    // 只保留最近 12 条
    await query(
      `DELETE r FROM recents r
       JOIN (SELECT game_slug FROM recents WHERE user_id = ? ORDER BY played_at DESC LIMIT 100 OFFSET 12) old
         ON r.game_slug = old.game_slug
       WHERE r.user_id = ?`,
      [id, id],
    )
    res.json({ recent: await recentIds(id) })
  } catch (e) {
    next(e)
  }
})
