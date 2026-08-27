import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireAdmin, isAdminRequest } from '../auth.js'
import { invalidateContent } from '../content.js'
import { gameRowToApi, gameApiToRow, buildUpsert } from '../mappers.js'

export const gamesRouter = Router()

/**
 * 游戏列表。
 *
 * 默认只返回已上架的（hidden = 0）。加 ?all=1 才返回全部，且需要管理员身份 ——
 * 以前这里无条件返回全部，等于任何人 curl 一下就能看到你下架的游戏，
 * 「下架」这个功能形同虚设。后台自己会带上管理员口令来取全量。
 */
gamesRouter.get('/', async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1'
    if (wantAll && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: '需要管理员权限才能查看全部游戏' })
    }
    const sql = wantAll
      ? 'SELECT * FROM games ORDER BY plays DESC'
      : 'SELECT * FROM games WHERE hidden = 0 ORDER BY plays DESC'
    const rows = await query(sql)
    res.json(rows.map(gameRowToApi))
  } catch (e) {
    next(e)
  }
})

gamesRouter.get('/:slug', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT * FROM games WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '游戏不存在' })
    // 已下架的对外当作不存在，只有管理员能取到
    if (row.hidden && !(await isAdminRequest(req))) {
      return res.status(404).json({ error: '游戏不存在' })
    }
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
    invalidateContent()
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
    invalidateContent()
    res.json(gameRowToApi({ ...existing, ...row }))
  } catch (e) {
    next(e)
  }
})

gamesRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
  try {
    await query('DELETE FROM games WHERE slug = ?', [req.params.slug])
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
