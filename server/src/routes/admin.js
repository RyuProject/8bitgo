import { Router } from 'express'
import { withTransaction } from '../db.js'
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
    const gameList = Array.isArray(req.body.games) ? req.body.games : []
    const postList = Array.isArray(req.body.posts) ? req.body.posts : []
    if (!gameList.length && !postList.length) {
      return res.status(400).json({ error: '请求里没有 games 或 posts 数组' })
    }

    // 缺 slug 的条目直接拒掉：buildUpsert 会把 undefined 写成主键，
    // 结果是整批数据挤进同一行，导入完只剩最后一条。
    const missing = [...gameList, ...postList].filter((x) => !x || typeof x.slug !== 'string' || !x.slug.trim())
    if (missing.length) {
      return res.status(400).json({ error: `有 ${missing.length} 条数据缺少 slug，已全部拒绝` })
    }

    // 整批放进一个事务：中途报错就全部回滚，不会留下导入到一半的库
    const result = await withTransaction(async (run) => {
      for (const g of gameList) {
        const { sql, values } = buildUpsert('games', gameApiToRow(g), 'slug')
        await run(sql, values)
      }
      for (const p of postList) {
        const { sql, values } = buildUpsert('posts', postApiToRow(p), 'slug')
        await run(sql, values)
      }
      return { games: gameList.length, posts: postList.length }
    })

    // 批量导入后让 SSR 缓存立即失效，前台不用等 60 秒
    invalidateContent()
    res.json({ ok: true, ...result })
  } catch (e) {
    next(e)
  }
})
