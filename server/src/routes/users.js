import { Router } from 'express'
import { query } from '../db.js'
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

/** 调整金币 / 改状态（封禁 / 解封） */
usersRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    if (typeof req.body.coinsDelta === 'number') {
      await query('UPDATE users SET coins = GREATEST(0, coins + ?) WHERE id = ?', [Math.trunc(req.body.coinsDelta), id])
    }
    if (req.body.status === 'active' || req.body.status === 'banned') {
      await query('UPDATE users SET status = ? WHERE id = ?', [req.body.status, id])
    }
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

usersRouter.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM users WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
