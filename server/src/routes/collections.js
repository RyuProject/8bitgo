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
import { query, queryOne, withTransaction } from '../db.js'
import { playIdentity } from '../playcount.js'
import { requireUser, optionalUser, hasAbility } from '../auth.js'
import { attachRelations } from '../games-repo.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'

export const collectionsRouter = Router()

/** 和 collections 表的列宽严格对齐 —— 数据库那边截断是静默的，得在这儿挡住 */
const MAX_TITLE = 80
const MAX_KIND = 30
const MAX_DESC = 500
/**
 * 封面给几张。四宫格只**摆** 4 张，但多给几张让卡片能轮播：每隔几秒把一格换成合集里的另一款，
 * 访客不点进去也能看出这个合集大概装了什么（用户 09-07 提的）。
 * 12 = 摆 4 张 + 8 张备用。再多的话首页那一栏（十几个合集）的数据量就上去了，而轮播到第 12 张
 * 早就过去半分钟，没人看那么久。
 * 给的是**瘦身版**（slug / title / titleZh / platform / icon / cover / video），不是完整 Game ——
 * 完整 Game 带两种语言的长简介，12 × 十几个合集就是几百 KB 塞进首页 HTML 里。
 */
const COVER_POOL = 12
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
 * 给一批合集取「最新放入的 COVER_POOL 款游戏」（瘦身版），前 4 张拼封面四宫格，其余给卡片轮播。
 * 最新的在最前，所以四宫格永远是最新放入的四款 —— 这条规则没变。
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
    [...ids, COVER_POOL],
  )
  if (!rows.length) return out
  // 下架的游戏不该出现在封面上，但它仍然留在合集里（作者的整理不该被我们悄悄改掉）
  const gameIds = [...new Set(rows.map((r) => String(r.game_id)))]
  const gholes = gameIds.map(() => '?').join(',')
  // 只取画封面要用的几列（形状对齐 src/types.ts 的 CoverGame），不走 attachRelations
  const gameRows = await query(
    `SELECT id, slug, title, title_zh, platform, icon, cover, video FROM games WHERE id IN (${gholes}) AND hidden = 0`,
    gameIds,
  )
  const byId = new Map(gameRows.map((r) => [String(r.id), coverGame(r)]))
  for (const r of rows) {
    const g = byId.get(String(r.game_id))
    if (g) out.get(String(r.collection_id))?.push(g)
  }
  return out
}

/** 封面用的瘦身 Game。可选字段没有就不带，和 gameRowToApi 的习惯一致 */
function coverGame(r) {
  const g = { slug: r.slug, title: r.title, platform: r.platform, icon: r.icon || '🎮' }
  if (r.title_zh) g.titleZh = r.title_zh
  if (r.cover) g.cover = r.cover
  if (r.video) g.video = r.video
  return g
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

/**
 * 一批合集各有多少人看过（`collection_views` 的行数，按人去重）。
 *
 * ⚠️ **失败一律当 0，绝不往上抛。** 这个数字是装饰性的，而 decorate() 里它和
 * 封面、游戏数是 `Promise.all` 并列的 —— 一抛就是整份列表 500。
 * 最现实的失败就是「表还没迁移」（新部署、或者忘了 npm run migrate），
 * 那时候合集页该照常能看，只是数字是 0。同 topCollections 的 `.catch(() => [])`。
 *
 * ⚠️ 表里**没有作者本人那一行**（写入时就拦掉了），所以这里不需要、也无法再减作者。
 */
async function viewCountsFor(ids) {
  const out = new Map(ids.map((id) => [String(id), 0]))
  if (!ids.length) return out
  const holes = ids.map(() => '?').join(',')
  try {
    const rows = await query(
      `SELECT collection_id, COUNT(*) AS n FROM collection_views WHERE collection_id IN (${holes}) GROUP BY collection_id`,
      ids,
    )
    for (const r of rows) out.set(String(r.collection_id), Number(r.n) || 0)
  } catch (e) {
    console.warn('[collections] 读浏览量失败，按 0 处理（表迁移了吗？）：', e?.message || e)
  }
  return out
}

function rowToApi(r, { covers = [], gameCount = 0, viewCount = 0, viewerId = null } = {}) {
  return {
    id: Number(r.id),
    title: r.title,
    kind: r.kind || '',
    description: r.description || '',
    gameCount,
    // 多少人看过（去重）。作者本人的浏览不计，见 POST /:id/view
    viewCount,
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
  const [covers, counts, views] = await Promise.all([coversFor(ids), countsFor(ids), viewCountsFor(ids)])
  return rows.map((r) =>
    rowToApi(r, {
      covers: covers.get(String(r.id)) ?? [],
      gameCount: counts.get(String(r.id)) ?? 0,
      viewCount: views.get(String(r.id)) ?? 0,
      viewerId,
    }),
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

/* ---------------- 开放平台（/api/open/v1/*）专用只读入口 ---------------- */

/**
 * 给开放平台用的公开合集列表。
 *
 * 和 GET / 是同一段查询 + 同一套 `decorate`（封面走 `coverGame`，只选 slug/title/platform/cover
 * 等安全列，**不带 ROM 真实地址**）。区别只有 viewerId 强制 null（开放平台令牌背后没有站内用户，
 * 永远不报 `mine`），以及分页参数由调用方给定。
 */
export async function listPublicCollections(page, pageSize) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE))
  const p = Math.max(1, Number(page) || 1)
  const total = Number((await queryOne('SELECT COUNT(*) AS n FROM collections WHERE hidden = 0'))?.n) || 0
  const rows = await query(
    `${SELECT_WITH_AUTHOR} WHERE c.hidden = 0 ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    [size, (p - 1) * size],
  )
  return { items: await decorate(rows, null), total, page: p, pageSize: size }
}

/**
 * 给开放平台用的单个合集元信息 + 游戏 slug（按展示顺序）。
 *
 * ⚠️ **不回完整游戏对象**：站内的 GET /:id 走 `attachRelations`，会把 ROM 真实地址等内部字段
 * 一起发出去；开放平台那条路由必须改用 `openGame` 白名单重新映射（见 routes/open.js），
 * 所以这里只回 slug 列表，游戏对象由那边现拼。
 * 下架 / 不存在一律返回 null（调用方转 404），和站内「下架合集对外 404」一致。
 */
export async function getPublicCollection(id) {
  const cid = idOf(id)
  if (!cid) return null
  const row = await queryOne(`${SELECT_WITH_AUTHOR} WHERE c.id = ?`, [cid])
  if (!row || Number(row.hidden)) return null
  const itemRows = await query(
    `SELECT ci.game_id FROM collection_items ci
     WHERE ci.collection_id = ?
     ORDER BY (ci.position IS NULL) ASC, ci.position ASC, ci.created_at DESC, ci.game_id DESC LIMIT ?`,
    [cid, MAX_ITEMS],
  )
  const ids = itemRows.map((r) => String(r.game_id))
  let slugs = []
  if (ids.length) {
    const holes = ids.map(() => '?').join(',')
    const gameRows = await query(`SELECT id, slug FROM games WHERE id IN (${holes}) AND hidden = 0`, ids)
    const slugById = new Map(gameRows.map((g) => [String(g.id), g.slug]))
    slugs = ids.map((gid) => slugById.get(gid)).filter(Boolean)
  }
  const counts = await countsFor([cid])
  return {
    collection: rowToApi(row, { viewerId: null, gameCount: counts.get(String(cid)) ?? 0 }),
    gameSlugs: slugs,
  }
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

    /*
      顺序：作者排过的（position 非空）在前、按 position 升序；没排过的垫在后面、按加入时间倒序。
      作者从没拖过时全是 NULL，顺序和以前一模一样（最新放入的在前）。
      排过之后再加进来的新游戏 position 是 NULL → 自动排到末尾，像给清单追加一条，
      而不是插到作者精心排好的前面去。
    */
    const itemRows = await query(
      `SELECT ci.game_id, ci.created_at, ci.position FROM collection_items ci
       WHERE ci.collection_id = ?
       ORDER BY (ci.position IS NULL) ASC, ci.position ASC, ci.created_at DESC, ci.game_id DESC LIMIT ?`,
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
    const [covers, counts, views] = await Promise.all([coversFor([id]), countsFor([id]), viewCountsFor([id])])
    res.json({
      collection: rowToApi(row, {
        covers: covers.get(String(id)) ?? [],
        gameCount: counts.get(String(id)) ?? 0,
        viewCount: views.get(String(id)) ?? 0,
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

    /*
      ⚠️ 数上限和写入要在同一个事务、同一把锁下。

      原来是「先 COUNT 再 INSERT」，中间没有锁，而 collections 表上也没有
      「每用户条数」的约束（库里只有外键）。并发 5 个请求（正好卡在上面那道
      5 次/分钟的闸内 —— 限流是内存计数，5 个并发全部放行）会读到同一个 owned，
      于是 MAX_PER_USER 这个上限不再是硬的，长期跑能一直撑破。

      锁 users 那一行：collections 里可能一条都没有，锁不住不存在的行。
      代价只落在同一个人自己并发建合集的时候，那本来就该排队。
    */
    const created = await withTransaction(async (run) => {
      await run('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id])
      const owned =
        Number((await run('SELECT COUNT(*) AS n FROM collections WHERE user_id = ?', [req.user.id]))[0]?.n) || 0
      if (owned >= MAX_PER_USER) return { over: true }
      const ins = await run('INSERT INTO collections (user_id, title, kind, description) VALUES (?, ?, ?, ?)', [
        req.user.id,
        title,
        clean(req.body?.kind, MAX_KIND),
        clean(req.body?.description, MAX_DESC),
      ])
      return { over: false, insertId: ins.insertId }
    })
    if (created.over) return res.status(400).json({ error: `最多只能建 ${MAX_PER_USER} 个合集` })
    const row = await queryOne(`${SELECT_WITH_AUTHOR} WHERE c.id = ?`, [created.insertId])
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

/**
 * 记一次合集浏览。前端在**详情页拿到数据之后**调一次（每次挂载一次，见 CollectionDetailPage）。
 *
 * ── 数的是「多少人看过」，不是累计次数 ──────────────────────
 * 站长 2026-09-07 拍板。合集没有游戏那种「模拟器真的跑起来」的硬信号，浏览就是
 * 打开页面 —— 不去重的话刷新、预取、爬虫就能把数字堆到四位数，那和 playcount.js
 * 开头刻意否决的做法是同一个毛病。所以复用**同一套身份**：登录按账号、
 * 未登录按 IP 的 HMAC 摘要（不存明文 IP），落 `collection_views`，主键判重。
 *
 * ── 三条容易漏的 ────────────────────────────────────────────
 * 1. **绝不能调 `touch()`。** `collections.updated_at` 是列表的默认排序键，而且
 *    刻意没有 `ON UPDATE CURRENT_TIMESTAMP` —— 建表时的注释点名说过「将来任何一次
 *    无关的 UPDATE（**加个浏览计数之类**）都会把合集顶到最前面」。这条接口正是那个
 *    「之类」。有一条断言盯着「浏览之后 updated_at 一个字都不许变」。
 * 2. **作者自己看自己的不算。** 作者会反复打开自己的合集去整理，把他算进去的话
 *    这个数字对他自己毫无意义。服务端拦（req.user 是可信的），不指望前端自觉。
 * 3. **写失败一律当没数到，不报错。** 一个装饰性的数字不该让页面看起来出了问题；
 *    最现实的失败就是表还没迁移。
 *
 * 用 optionalUser 而不是 requireUser：游客的浏览也算数，带了 token 只是顺手认出是谁。
 * 和 /:slug/play 一样**不调 invalidateContent()** —— 高频写，每次清 SSR 缓存等于把缓存关掉。
 */
collectionsRouter.post('/:id/view', optionalUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ error: '合集不存在' })
    const row = await queryOne('SELECT id, user_id, hidden FROM collections WHERE id = ?', [id])
    // 不存在 / 已下架一律 404 —— 403 等于承认「这里确实有个东西」（同 GET /:id）
    // hidden 是 tinyint(1)，mysql2 给的是数字 —— 用 Number() 判，和上面 GET /:id 那处一致
    if (!row || Number(row.hidden)) return res.status(404).json({ error: '合集不存在' })
    // 作者本人：直接不记（见上面第 2 条）
    if (req.user?.id && String(row.user_id) === String(req.user.id)) return res.json({ ok: true, counted: false })
    const who = playIdentity(req)
    // 既没登录、又拿不到任何 IP：宁可不记，也不要把这类请求全塞进同一个身份里
    if (!who) return res.json({ ok: true, counted: false })
    let counted = false
    try {
      const r = await query('INSERT IGNORE INTO collection_views (collection_id, kind, identity) VALUES (?, ?, ?)', [
        row.id,
        who.kind,
        who.identity,
      ])
      counted = Number(r?.affectedRows ?? 0) > 0
    } catch (e) {
      console.warn('[collections] 记浏览量失败，按没数到处理（表迁移了吗？）：', e?.message || e)
    }
    res.json({ ok: true, counted })
  } catch (e) {
    next(e)
  }
})

collectionsRouter.post('/:id/games', requireUser, async (req, res, next) => {
  try {
    const row = await ownedOr404(req, res)
    if (!row) return
    const slug = String(req.body?.gameSlug ?? '').trim()
    if (!slug) return res.status(400).json({ error: '缺少 gameSlug' })
    const game = await queryOne('SELECT id FROM games WHERE slug = ? AND hidden = 0', [slug])
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    /*
      这条路以前**一道限流都没有**（对比同文件的 POST / 有两道）。
      作者自己对自己的合集并发 POST 几百个不同 slug，就能绕过下面那个上限。
    */
    const gate = take(`collection:add:${req.user.id}`, 120, 60_000)
    if (!gate.ok) return res.status(429).json({ error: '加得太快了，请稍后再试', retryAfter: gate.retryAfter })

    /*
      ⚠️ 数上限和写入要在同一个事务、同一把锁下 —— 理由同 POST /。

      超了之后的症状特别隐蔽：GET /:id 用 `LIMIT MAX_ITEMS` 取，多出来的那些游戏
      **在详情页上列不出来，也就没有删除入口** —— 看不见也删不掉，只能从库里清。
      属于「不报错，但数据回不去」那一类。

      这里锁 collections 那一行（合集一定存在，ownedOr404 刚查过），
      粒度比锁用户更细：同一个人可以同时往两个不同的合集里加游戏。

      IGNORE 保留：主键已经保证同一款游戏在一个合集里只有一条。重复加入是**幂等**的，
      不该报错 —— 玩家在两个标签页里各点一次「加入」是很正常的事。
      但也不能刷新 created_at：那会让封面顺序跟着变，看起来像凭空换了封面。
    */
    const added = await withTransaction(async (run) => {
      await run('SELECT id FROM collections WHERE id = ? FOR UPDATE', [row.id])
      const n =
        Number((await run('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', [row.id]))[0]?.n) || 0
      if (n >= MAX_ITEMS) return { over: true }
      const ins = await run('INSERT IGNORE INTO collection_items (collection_id, game_id) VALUES (?, ?)', [row.id, game.id])
      return { over: false, affected: ins.affectedRows }
    })
    if (added.over) return res.status(400).json({ error: `一个合集最多放 ${MAX_ITEMS} 款游戏` })
    if (added.affected) await touch(row.id)
    res.status(201).json({ ok: true, added: Boolean(added.affected) })
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

/**
 * 手动排序：PATCH /:id/order  body { slugs: [...] }
 *
 * 客户端把**当前看到的整个顺序**发上来，服务端按下标写 position。只认作者本人
 * （ownedOr404）—— 顺序也是作者的表达，管理员一样不能碰，和改标题一个道理。
 *
 * 只写名单里有的：不在名单里的（另一个标签页刚加进来的）position 保持 NULL，
 * 自然排到末尾，不会因为这次没带上就被删掉或乱序。
 * 不认识的 slug、不在这个合集里的 slug 直接忽略而不是 400 —— 客户端手里的名单
 * 可能比服务端旧几秒，这不是它的错。
 */
collectionsRouter.patch('/:id/order', requireUser, async (req, res, next) => {
  try {
    const row = await ownedOr404(req, res)
    if (!row) return
    const raw = req.body?.slugs
    if (!Array.isArray(raw)) return res.status(400).json({ error: '缺少 slugs' })
    if (raw.length > MAX_ITEMS) return res.status(400).json({ error: `一次最多排 ${MAX_ITEMS} 款` })
    // 去重、去掉不是字符串的；保留首次出现的位置
    const slugs = []
    const seen = new Set()
    for (const x of raw) {
      const slug = String(x ?? '').trim()
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      slugs.push(slug)
    }
    if (!slugs.length) return res.json({ ok: true, ordered: 0 })

    const holes = slugs.map(() => '?').join(',')
    const gameRows = await query(`SELECT id, slug FROM games WHERE slug IN (${holes})`, slugs)
    const idBySlug = new Map(gameRows.map((g) => [g.slug, String(g.id)]))
    const inCollection = new Set(
      (await query('SELECT game_id FROM collection_items WHERE collection_id = ?', [row.id])).map((r) => String(r.game_id)),
    )
    // 只给「真在这个合集里」的写位置；下标按过滤后的顺序连续编号，中间不留洞
    const ordered = slugs.map((slug) => idBySlug.get(slug)).filter((gid) => gid && inCollection.has(gid))
    if (ordered.length) {
      /*
        一条 UPDATE 写完所有位置：CASE game_id WHEN ? THEN ? ... END。
        500 款也就一个来回；逐条 UPDATE 是 500 个来回，拖一下卡半秒。
        参数排列：[gid, pos, gid, pos, ..., collection_id, gid, gid, ...]
      */
      const cases = ordered.map(() => 'WHEN ? THEN ?').join(' ')
      const inHoles = ordered.map(() => '?').join(',')
      await query(
        `UPDATE collection_items SET position = CASE game_id ${cases} END WHERE collection_id = ? AND game_id IN (${inHoles})`,
        [...ordered.flatMap((gid, i) => [gid, i]), row.id, ...ordered],
      )
      await touch(row.id)
    }
    res.json({ ok: true, ordered: ordered.length })
  } catch (e) {
    next(e)
  }
})
