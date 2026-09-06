/**
 * 合集：注册用户自己建的游戏清单。
 *
 * 三条规矩都在这一层落实，不指望前端自觉：
 *   - **建 / 改 / 加游戏必须登录**（requireUser），且只能动**自己**的合集。
 *   - **管理员只能删或下架，不能改**。产品上的约定：合集是署名的个人表达，
 *     替作者改标题描述等于替他发言。所以 PATCH 一律只认作者本人，
 *     DELETE 和「下架」才认 collections:review。
 *   - **目前一律公开**：没有可见性字段，`hidden` 是管理员的下架开关，不是作者的私密开关。
 *     以后要加「私密」的话，加一个作者可控的 visibility 列，别去复用 hidden ——
 *     「作者自己藏起来」和「被管理员下架」在处理举报时必须分得清（同 game_comments 的教训）。
 *
 * ⚠️ 路由顺序：`/mine` 必须写在 `/:id` **前面**，否则 Express 会把 "mine" 当成 id
 * 去查数据库，永远 404。（评论那边踩过同款，见 [游戏评论] 的记忆）
 *
 * ⚠️ 这里所有接口都**不能**调 publicApi()。合集随时在变，挂上 s-maxage 的话
 * 用户加完游戏刷新看不到，只会以为没加上又加一遍。/api 默认就是 no-store。
 */
import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireUser, optionalUser, hasAbility } from '../auth.js'
import { attachRelations } from '../games-repo.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'

export const collectionsRouter = Router()

/** 和 collections 表的列宽严格对齐 —— 数据库那边截断是静默的，得在这儿挡住 */
const MAX_TITLE = 80
const MAX_KIND = 30
const MAX_DESC = 500
/** 封面四宫格要几张 */
const COVER_COUNT = 4
/** 一个人最多建多少个合集。挡的是脚本刷号，正常用户碰不到 */
const MAX_PER_USER = 100
/** 一个合集最多装多少款游戏 */
const MAX_ITEMS = 500
const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 48

const clean = (raw, max) =>
  String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)

/** 路径参数里的数字 id；不合法返回 0，调用方一律当 404 处理 */
function idOf(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * 给一批合集取「最新放入的四款游戏」，用于封面四宫格。
 *
 * 用窗口函数一次查完，而不是每个合集查一次 —— 首页那一栏有十几个合集，
 * 循环查就是十几个来回。MySQL 8.0+ / MariaDB 10.2+ 都支持 ROW_NUMBER()
 * （games-repo.js 的开发商统计已经在用了）。
 */
async function coversFor(ids) {
  const out = new Map(ids.map((id) => [String(id), []]))
  if (!ids.length) return out
  const holes = ids.map(() => '?').join(',')
  const rows = await query(
    `SELECT collection_id, game_id FROM (
       SELECT collection_id, game_id,
              ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY created_at DESC, game_id DESC) AS rn
       FROM collection_items
       WHERE collection_id IN (${holes})
     ) t WHERE rn <= ?`,
    [...ids, COVER_COUNT],
  )
  if (!rows.length) return out
  // 下架的游戏不该出现在封面上，但它仍然留在合集里（作者的整理不该被我们悄悄改掉）
  const gameIds = [...new Set(rows.map((r) => String(r.game_id)))]
  const gholes = gameIds.map(() => '?').join(',')
  const gameRows = await query(`SELECT * FROM games WHERE id IN (${gholes}) AND hidden = 0`, gameIds)
  const games = await attachRelations(gameRows)
  const byId = new Map(games.map((g, i) => [String(gameRows[i].id), g]))
  for (const r of rows) {
    const g = byId.get(String(r.game_id))
    if (g) out.get(String(r.collection_id))?.push(g)
  }
  return out
}

/** 一批合集各有多少款游戏 */
async function countsFor(ids) {
  const out = new Map(ids.map((id) => [String(id), 0]))
  if (!ids.length) return out
  const holes = ids.map(() => '?').join(',')
  const rows = await query(
    `SELECT collection_id, COUNT(*) AS n FROM collection_items WHERE collection_id IN (${holes}) GROUP BY collection_id`,
    ids,
  )
  for (const r of rows) out.set(String(r.collection_id), Number(r.n) || 0)
  return out
}

function rowToApi(r, { covers = [], gameCount = 0, viewerId = null } = {}) {
  return {
    id: Number(r.id),
    title: r.title,
    kind: r.kind || '',
    description: r.description || '',
    gameCount,
    covers,
    author: {
      id: r.user_id,
      nickname: r.nickname || '玩家',
      avatar: r.avatar || '🕹️',
    },
    hidden: Boolean(Number(r.hidden)),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? ''),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
    // 前端据此决定显不显示编辑入口。没登录时不带这个字段，形状和以前一样
    ...(viewerId && r.user_id === viewerId ? { mine: true } : {}),
  }
}

/** 合集行 + 作者昵称头像，一次 JOIN 查完 */
const SELECT_WITH_AUTHOR =
  'SELECT c.*, u.nickname, u.avatar FROM collections c JOIN users u ON u.id = c.user_id'

/** 把一批行装配成 API 形状（补上封面和游戏数） */
async function decorate(rows, viewerId) {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [covers, counts] = await Promise.all([coversFor(ids), countsFor(ids)])
  return rows.map((r) =>
    rowToApi(r, { covers: covers.get(String(r.id)) ?? [], gameCount: counts.get(String(r.id)) ?? 0, viewerId }),
  )
}

/**
 * 首页那一栏用的：最近有动静的前 N 个公开合集。
 *
 * 单独导出而不是让首页去打自己的 HTTP 接口 —— 首页数据是 SSR 在进程内拼好的
 * （见 content.js 的 loadHome），绕出去发一次网络请求既慢又会把 SSR 和缓存搞乱。
 */
export async function topCollections(limit = 8) {
  const rows = await query(
    `${SELECT_WITH_AUTHOR} WHERE c.hidden = 0 ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    [Math.max(1, Math.min(24, Number(limit) || 8))],
  )
  // 首页是公开数据，不带任何人的登录态 —— viewerId 传 null，输出里就不会有 mine
  return decorate(rows, null)
}

/* ---------------- 公开读 ---------------- */

/**
 * 公开列表。默认按「最近有动静」排 —— 合集是活的，作者往里加游戏就该重新冒头，
 * 按创建时间排的话首页会永远是最早那批。
 */
collectionsRouter.get('/', optionalUser, async (req, res, next) => {
  try {
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE))
    const page = Math.max(1, Number(req.query.page) || 1)
    const total = Number((await queryOne('SELECT COUNT(*) AS n FROM collections WHERE hidden = 0'))?.n) || 0
    const rows = await query(
      `${SELECT_WITH_AUTHOR} WHERE c.hidden = 0 ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      [size, (page - 1) * size],
    )
    res.json({ items: await decorate(rows, req.user?.id ?? null), total, page, pageSize: size })
  } catch (e) {
    next(e)
  }
})

/**
 * 我的合集。**必须排在 /:id 前面** —— 否则 "mine" 会被当成 id。
 * 前端「加入合集」那个下拉也用它，所以这里不分页，直接给全部（上限 MAX_PER_USER）。
 */
collectionsRouter.get('/mine', requireUser, async (req, res, next) => {
  try {
    const rows = await query(
      `${SELECT_WITH_AUTHOR} WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      [req.user.id, MAX_PER_USER],
    )
    res.json({ items: await decorate(rows, req.user.id) })
  } catch (e) {
    next(e)
  }
})

/** 详情：合集本身 + 里面的游戏（最新放入的在前） */
collectionsRouter.get('/:id', optionalUser, async (req, res, next) => {
  try {
    const id = idOf(req.params.id)
    if (!id) return res.status(404).json({ error: '合集不存在' })
    const row = await queryOne(`${SELECT_WITH_AUTHOR} WHERE c.id = ?`, [id])
    if (!row) return res.status(404).json({ error: '合集不存在' })
    const viewerId = req.user?.id ?? null
    // 下架的合集只有作者本人和有审核权的人看得到，别人一律 404（而不是 403 ——
    // 403 等于告诉外人「这里确实有个东西」）
    if (Number(row.hidden) && row.user_id !== viewerId && !(await hasAbility(req, 'collections:review'))) {
      return res.status(404).json({ error: '合集不存在' })
    }

    const itemRows = await query(
      `SELECT ci.game_id, ci.created_at FROM collection_items ci
       WHERE ci.collection_id = ? ORDER BY ci.created_at DESC, ci.game_id DESC LIMIT ?`,
      [id, MAX_ITEMS],
    )
    let games = []
    if (itemRows.length) {
      const ids = itemRows.map((r) => String(r.game_id))
      const holes = ids.map(() => '?').join(',')
      const gameRows = await query(`SELECT * FROM games WHERE id IN (${holes}) AND hidden = 0`, ids)
      const list = await attachRelations(gameRows)
      const byId = new Map(list.map((g, i) => [String(gameRows[i].id), g]))
      // 按 collection_items 的顺序还原，别用 IN 查询回来的顺序
      games = ids.map((gid) => byId.get(gid)).filter(Boolean)
    }
    const [covers, counts] = await Promise.all([coversFor([id]), countsFor([id])])
    res.json({
      collection: rowToApi(row, {
        covers: covers.get(String(id)) ?? [],
        gameCount: counts.get(String(id)) ?? 0,
        viewerId,
      }),
      games,
      // 有审核权的人才知道这个合集被下架了；普通人根本看不到下架的合集
      canReview: await hasAbility(req, 'collections:review'),
    })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 作者的写操作 ---------------- */

/** 取出合集并确认调用者是作者；不是就直接把响应写完，返回 null */
async function ownedOr404(req, res) {
  const id = idOf(req.params.id)
  if (!id) {
    res.status(404).json({ error: '合集不存在' })
    return null
  }
  const row = await queryOne('SELECT * FROM collections WHERE id = ?', [id])
  if (!row) {
    res.status(404).json({ error: '合集不存在' })
    return null
  }
  if (row.user_id !== req.user.id) {
    res.status(403).json({ error: '只能修改自己的合集' })
    return null
  }
  return row
}

/** 有动静就把 updated_at 往前推：列表按它排，加了游戏却不冒头等于白加 */
const touch = (id) => query('UPDATE collections SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id])

collectionsRouter.post('/', requireUser, async (req, res, next) => {
  try {
    const title = clean(req.body?.title, MAX_TITLE)
    if (!title) return res.status(400).json({ error: '合集标题不能为空' })

    const perUser = take(`collection:new:${req.user.id}`, 5, 60_000)
    if (!perUser.ok) return res.status(429).json({ error: '建得太快了，请稍后再试', retryAfter: perUser.retryAfter })
    const ip = clientKey(req)
    if (isMeaningfulIp(ip)) {
      const perIp = take(`collection:new:ip:${ip}`, 20, 60_000)
      if (!perIp.ok) return res.status(429).json({ error: '建得太快了，请稍后再试', retryAfter: perIp.retryAfter })
    }

    const owned = Number((await queryOne('SELECT COUNT(*) AS n FROM collections WHERE user_id = ?', [req.user.id]))?.n) || 0
    if (owned >= MAX_PER_USER) return res.status(400).json({ error: `最多只能建 ${MAX_PER_USER} 个合集` })

    const r = await query('INSERT INTO collections (user_id, title, kind, description) VALUES (?, ?, ?, ?)', [
      req.user.id,
      title,
      clean(req.body?.kind, MAX_KIND),
      clean(req.body?.description, MAX_DESC),
    ])
    const row = await queryOne(`${SELECT_WITH_AUTHOR} WHERE c.id = ?`, [r.insertId])
    res.status(201).json(rowToApi(row, { viewerId: req.user.id }))
  } catch (e) {
    next(e)
  }
})

/** 改标题 / 类型 / 描述。**只认作者本人** —— 管理员也不行，见文件头 */
collectionsRouter.patch('/:id', requireUser, async (req, res, next) => {
  try {
    const row = await ownedOr404(req, res)
    if (!row) return

    const sets = []
    const args = []
    if (req.body?.title !== undefined) {
      const title = clean(req.body.title, MAX_TITLE)
      if (!title) return res.status(400).json({ error: '合集标题不能为空' })
      sets.push('title = ?')
      args.push(title)
    }
    if (req.body?.kind !== undefined) {
      sets.push('kind = ?')
      args.push(clean(req.body.kind, MAX_KIND))
    }
    if (req.body?.description !== undefined) {
      sets.push('description = ?')
      args.push(clean(req.body.description, MAX_DESC))
    }
    if (!sets.length) return res.status(400).json({ error: '没有要修改的内容' })

    sets.push('updated_at = CURRENT_TIMESTAMP(3)')
    await query(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, [...args, row.id])
    const fresh = await queryOne(`${SELECT_WITH_AUTHOR} WHERE c.id = ?`, [row.id])
    const [out] = await decorate([fresh], req.user.id)
    res.json(out)
  } catch (e) {
    next(e)
  }
})

/** 删除：作者本人，或有 collections:review 的管理员 */
collectionsRouter.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const id = idOf(req.params.id)
    if (!id) return res.status(404).json({ error: '合集不存在' })
    const row = await queryOne('SELECT id, user_id FROM collections WHERE id = ?', [id])
    if (!row) return res.status(404).json({ error: '合集不存在' })
    if (row.user_id !== req.user.id && !(await hasAbility(req, 'collections:review'))) {
      return res.status(403).json({ error: '只能删除自己的合集' })
    }
    // collection_items 靠外键级联删掉
    await query('DELETE FROM collections WHERE id = ?', [id])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/** 下架 / 恢复：只有管理员。作者要藏自己的合集只能删 —— 目前不做私密合集 */
collectionsRouter.patch('/:id/hidden', requireUser, async (req, res, next) => {
  try {
    if (!(await hasAbility(req, 'collections:review'))) return res.status(403).json({ error: '没有权限' })
    const id = idOf(req.params.id)
    if (!id) return res.status(404).json({ error: '合集不存在' })
    const hidden = req.body?.hidden ? 1 : 0
    const r = await query('UPDATE collections SET hidden = ? WHERE id = ?', [hidden, id])
    if (!r.affectedRows) return res.status(404).json({ error: '合集不存在' })
    res.json({ ok: true, hidden: Boolean(hidden) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 合集里的游戏 ---------------- */

collectionsRouter.post('/:id/games', requireUser, async (req, res, next) => {
  try {
    const row = await ownedOr404(req, res)
    if (!row) return
    const slug = String(req.body?.gameSlug ?? '').trim()
    if (!slug) return res.status(400).json({ error: '缺少 gameSlug' })
    const game = await queryOne('SELECT id FROM games WHERE slug = ? AND hidden = 0', [slug])
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    const n = Number((await queryOne('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', [row.id]))?.n) || 0
    if (n >= MAX_ITEMS) return res.status(400).json({ error: `一个合集最多放 ${MAX_ITEMS} 款游戏` })

    /*
      IGNORE：主键已经保证同一款游戏在一个合集里只有一条。重复加入是**幂等**的，
      不该报错 —— 玩家在两个标签页里各点一次「加入」是很正常的事。
      但也不能刷新 created_at：那会让封面顺序跟着变，看起来像凭空换了封面。
    */
    const r = await query('INSERT IGNORE INTO collection_items (collection_id, game_id) VALUES (?, ?)', [row.id, game.id])
    if (r.affectedRows) await touch(row.id)
    res.status(201).json({ ok: true, added: Boolean(r.affectedRows) })
  } catch (e) {
    next(e)
  }
})

collectionsRouter.delete('/:id/games/:slug', requireUser, async (req, res, next) => {
  try {
    const row = await ownedOr404(req, res)
    if (!row) return
    const game = await queryOne('SELECT id FROM games WHERE slug = ?', [String(req.params.slug ?? '').trim()])
    if (!game) return res.status(404).json({ error: '游戏不存在' })
    const r = await query('DELETE FROM collection_items WHERE collection_id = ? AND game_id = ?', [row.id, game.id])
    if (r.affectedRows) await touch(row.id)
    res.json({ ok: true, removed: Boolean(r.affectedRows) })
  } catch (e) {
    next(e)
  }
})
