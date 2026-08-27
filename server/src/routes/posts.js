import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireAdmin, isAdminRequest } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { postRowToApi, postApiToRow, buildUpsert } from '../mappers.js'

export const postsRouter = Router()

/**
 * 文章列表。默认只返回已发布的；?all=1 返回全部（含草稿），需要管理员身份。
 * 以前无条件返回全部，草稿正文对任何人可读 —— curl /api/posts 就能看到还没发的稿子。
 */
postsRouter.get('/', async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1'
    if (wantAll && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: '需要管理员权限才能查看草稿' })
    }
    const sql = wantAll
      ? 'SELECT * FROM posts ORDER BY date DESC'
      : 'SELECT * FROM posts WHERE published = 1 ORDER BY date DESC'
    const rows = await query(sql)
    // 只有公开视角（不带 ?all=1）才可以缓存：管理员视角带着身份，
    // 缓存下来等于把下架文章 / 草稿发给所有人
    if (!wantAll) publicApi(res)
    res.json(rows.map(postRowToApi))
  } catch (e) {
    next(e)
  }
})

postsRouter.get('/:slug', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT * FROM posts WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '文章不存在' })
    if (!row.published && !(await isAdminRequest(req))) {
      return res.status(404).json({ error: '文章不存在' })
    }
    // 已发布的文章对所有人一样，可以缓存；草稿保持 no-store
    if (row.published) publicApi(res)
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
    invalidateContent()
    res.json(postRowToApi(saved))
  } catch (e) {
    next(e)
  }
})

postsRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
  try {
    await query('DELETE FROM posts WHERE slug = ?', [req.params.slug])
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
