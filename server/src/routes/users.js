import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireAdmin } from '../auth.js'
import { userRowToPublic } from '../mappers.js'

export const usersRouter = Router()
usersRouter.use(requireAdmin)

/** 全部用户（含收藏 / 最近，供后台展示） */
usersRouter.get('/', async (_req, res, next) => {
  try {
    const users = await query('SELECT * FROM users ORDER BY created_at DESC')
    const favs = await query('SELECT user_id, game_slug FROM favorites ORDER BY created_at DESC')
    const recents = await query('SELECT user_id, game_slug FROM recents ORDER BY played_at DESC')
    const byUser = (rows) => {
      const m = new Map()
      for (const r of rows) {
        if (!m.has(r.user_id)) m.set(r.user_id, [])
        m.get(r.user_id).push(r.game_slug)
      }
      return m
    }
    const fMap = byUser(favs)
    const rMap = byUser(recents)
    res.json(users.map((u) => userRowToPublic(u, fMap.get(u.id) || [], (rMap.get(u.id) || []).slice(0, 12))))
  } catch (e) {
    next(e)
  }
})

/** 单次调整金币的上限，挡住手滑多打几个零 */
const MAX_COIN_DELTA = 1_000_000

/** 还剩几个能用的管理员（不含被封禁的） */
async function activeAdminCount(excludeId) {
  const r = await queryOne(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
    [excludeId ?? ''],
  )
  return Number(r?.n ?? 0)
}

/**
 * 调整金币 / 改状态（封禁 / 解封）。
 *
 * 两道护栏，以前都没有：
 *  1. 不能封禁 / 删除自己 —— 封了自己下一次请求就被 requireUser 拦住，直接把自己关在外面；
 *  2. 不能封禁 / 删除最后一个还能用的管理员 —— 同上，只是慢一步发现。
 * 用后台口令（ADMIN_TOKEN）调用时 req.user 为空，第 1 条自然不适用，第 2 条仍然生效。
 */
usersRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const target = await queryOne('SELECT id, role, status FROM users WHERE id = ?', [id])
    if (!target) return res.status(404).json({ error: '用户不存在' })

    if (req.body.coinsDelta !== undefined) {
      const delta = Math.trunc(Number(req.body.coinsDelta))
      if (!Number.isFinite(delta)) return res.status(400).json({ error: 'coinsDelta 必须是数字' })
      if (Math.abs(delta) > MAX_COIN_DELTA) {
        return res.status(400).json({ error: `单次调整不能超过 ${MAX_COIN_DELTA.toLocaleString('en-US')} G 币` })
      }
      if (delta !== 0) await query('UPDATE users SET coins = GREATEST(0, coins + ?) WHERE id = ?', [delta, id])
    }

    if (req.body.status === 'active' || req.body.status === 'banned') {
      if (req.body.status === 'banned') {
        if (req.user?.id === id) return res.status(400).json({ error: '不能封禁自己' })
        if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
          return res.status(400).json({ error: '这是最后一个可用的管理员，不能封禁' })
        }
      }
      await query('UPDATE users SET status = ? WHERE id = ?', [req.body.status, id])
    }

    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/** 删除用户。favorites / recents 有 ON DELETE CASCADE，会跟着一起删掉。 */
usersRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const target = await queryOne('SELECT id, role FROM users WHERE id = ?', [id])
    if (!target) return res.status(404).json({ error: '用户不存在' })
    if (req.user?.id === id) return res.status(400).json({ error: '不能删除自己' })
    if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
      return res.status(400).json({ error: '这是最后一个可用的管理员，不能删除' })
    }
    await query('DELETE FROM users WHERE id = ?', [id])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
