import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireAdmin } from '../auth.js'
import { postRowToApi, postApiToRow, buildUpsert } from '../mappers.js'

export const postsRouter = Router()

/** 全部文章（含未发布，带 published 字段；前台自行过滤）。 */
postsRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await query('SELECT * FROM posts ORDER BY date DESC')
    res.json(rows.map(postRowToApi))
  } catch (e) {
    next(e)
  }
})

postsRouter.get('/:slug', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT * FROM posts WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '文章不存在' })
    res.json(postRowToApi(row))
  } catch (e) {
    next(e)
  }
})

postsRouter.put('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const row = postApiToRow({ ...req.body, slug: req.params.slug })
    const { sql, values } = buildUpsert('posts', row, 'slug')
    await query(sql, values)
    const saved = await queryOne('SELECT * FROM posts WHERE slug = ?', [row.slug])
    res.json(postRowToApi(saved))
  } catch (e) {
    next(e)
  }
})

postsRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
  try {
    await query('DELETE FROM posts WHERE slug = ?', [req.params.slug])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
