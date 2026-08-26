import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireAdmin } from '../auth.js'
import { gameRowToApi, gameApiToRow, buildUpsert } from '../mappers.js'

export const gamesRouter = Router()

/** 全部游戏（含隐藏，带 hidden 字段；前台自行过滤）。自用站点，简单优先。 */
gamesRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await query('SELECT * FROM games ORDER BY plays DESC')
    res.json(rows.map(gameRowToApi))
  } catch (e) {
    next(e)
  }
})

gamesRouter.get('/:slug', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT * FROM games WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '游戏不存在' })
    res.json(gameRowToApi(row))
  } catch (e) {
    next(e)
  }
})

/** 新增 / 覆盖一款游戏（后台） */
gamesRouter.put('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const body = { ...req.body, slug: req.params.slug }
    const row = gameApiToRow(body)
    const { sql, values } = buildUpsert('games', row, 'slug')
    await query(sql, values)
    const saved = await queryOne('SELECT * FROM games WHERE slug = ?', [row.slug])
    res.json(gameRowToApi(saved))
  } catch (e) {
    next(e)
  }
})

/** 局部更新（如切换上下架 { hidden: true }）（后台） */
gamesRouter.patch('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const existing = await queryOne('SELECT * FROM games WHERE slug = ?', [req.params.slug])
    if (!existing) return res.status(404).json({ error: '游戏不存在' })
    const merged = { ...gameRowToApi(existing), ...req.body, slug: req.params.slug }
    const row = gameApiToRow(merged)
    const { sql, values } = buildUpsert('games', row, 'slug')
    await query(sql, values)
    res.json(gameRowToApi({ ...existing, ...row }))
  } catch (e) {
    next(e)
  }
})

gamesRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
  try {
    await query('DELETE FROM games WHERE slug = ?', [req.params.slug])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
