import { Router } from 'express'
import { query } from '../db.js'
import { requireAdmin } from '../auth.js'
import { gameApiToRow, postApiToRow, buildUpsert } from '../mappers.js'
import { invalidateContent } from '../content.js'

export const adminRouter = Router()
adminRouter.use(requireAdmin)

/**
 * 批量导入内置数据（首次初始化用）：
 *   POST /api/admin/import { games?: Game[], posts?: Post[] }
 * 前端「后台 → 数据」里点「导入到数据库」会调用这里。
 */
adminRouter.post('/import', async (req, res, next) => {
  try {
    let games = 0
    let posts = 0
    if (Array.isArray(req.body.games)) {
      for (const g of req.body.games) {
        const row = gameApiToRow(g)
        const { sql, values } = buildUpsert('games', row, 'slug')
        await query(sql, values)
        games++
      }
    }
    if (Array.isArray(req.body.posts)) {
      for (const p of req.body.posts) {
        const row = postApiToRow(p)
        const { sql, values } = buildUpsert('posts', row, 'slug')
        await query(sql, values)
        posts++
      }
    }
    // 批量导入后让 SSR 缓存立即失效，前台不用等 60 秒
    invalidateContent()
    res.json({ ok: true, games, posts })
  } catch (e) {
    next(e)
  }
})
