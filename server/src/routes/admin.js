import { Router } from 'express'
import { withTransaction } from '../db.js'
import { requireAdmin, requireAbility, roleOfRequest } from '../auth.js'
import { ROLE_ABILITIES, isStaff } from '../../../shared/roles.js'
import { postApiToRow, buildUpsert } from '../mappers.js'
import { upsertGame, adminStats } from '../games-repo.js'
import { invalidateContent } from '../content.js'
import { queueGameSearchPush, queuePostSearchPush } from '../search-push.js'

export const adminRouter = Router()

/**
 * 后台登录门。只确认「这张凭证能不能进后台」，不为了验证身份顺手查询或泄露业务数据。
 *
 * 从「只放管理员」改成「放所有有权限点的角色」，并且**把角色和权限点一起回给前端** ——
 * 志愿者也要进得来，进来之后导航按这份权限收窄（见 src/admin/AdminLayout.tsx）。
 * 前端拿这份清单只是为了别画出点了会 403 的按钮；真正拦人的是各路由上的 requireAbility。
 */
adminRouter.get('/verify', async (req, res, next) => {
  try {
    const role = await roleOfRequest(req)
    if (!isStaff(role)) return res.status(403).json({ error: '需要后台权限（后台口令、管理员或志愿者账号）' })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, role, abilities: ROLE_ABILITIES[role] })
  } catch (e) {
    next(e)
  }
})

/**
 * 批量导入内置数据（首次初始化用）：
 *   POST /api/admin/import { games?: Game[], posts?: Post[] }
 * 前端「后台 → 数据」里点「导入到数据库」会调用这里。
 */
adminRouter.post('/import', requireAdmin, async (req, res, next) => {
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

    // 游戏要连关联表一起写，逐条走 upsertGame（它内部各自开事务）。
    // 文章只有一张标签表，量也小，放在一个事务里。
    for (const g of gameList) await upsertGame(String(g.slug), g)
    await withTransaction(async (run) => {
      for (const p of postList) {
        const { sql, values } = buildUpsert('posts', postApiToRow(p), 'slug')
        await run(sql, values)
        const [{ id }] = await run('SELECT id FROM posts WHERE slug = ?', [p.slug])
        await run('DELETE FROM post_tags WHERE post_id = ?', [id])
        const tags = [...new Set((p.tags ?? []).map((t) => String(t).trim()).filter(Boolean))]
        if (tags.length) {
          await run(
            `INSERT INTO post_tags (post_id, tag) VALUES ${tags.map(() => '(?, ?)').join(', ')}`,
            tags.flatMap((t) => [id, t]),
          )
        }
      }
    })
    const result = { games: gameList.length, posts: postList.length }

    // 批量导入后让 SSR 缓存立即失效，前台不用等 60 秒
    invalidateContent()
    // 一次导入可能有上百款，统一进入队列后由各自的批量接口合并提交。
    // ⚠️ 百度普通收录有每日配额（新站常见 10~100 条），批量导入几乎必然会把它推满；
    // 剩下的靠每日兜底任务（cd server && npm run baidu）按天补交。
    for (const game of gameList) queueGameSearchPush(game)
    // 文章同样要推。这里只推已发布的：导入包里常常混着草稿。
    for (const post of postList) {
      if (post.published !== false) queuePostSearchPush(post)
    }
    res.json({ ok: true, ...result })
  } catch (e) {
    next(e)
  }
})

/**
 * 后台概览的全库聚合：游戏总数 / 上下架数 / 已绑定 ROM 数 / 累计游玩 / 文章数。
 *
 * 这些必须在数据库里算。v1 是把全库拉进浏览器再 reduce，上千款游戏时
 * 光是为了首页那几个数字就要下载整个目录。
 */
adminRouter.get('/stats', requireAbility('content:edit'), async (_req, res, next) => {
  try {
    res.json(await adminStats())
  } catch (e) {
    next(e)
  }
})
