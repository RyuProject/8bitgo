/**
 * 游戏评论。
 *
 * 规矩就三条，都在这一层落实，不指望前端自觉：
 *   - **发表必须登录**（requireUser）。匿名评论区在一个能被搜索引擎抓到的站点上
 *     等于免费的外链农场，上线第一周就会被灌满。
 *   - **删除是软删除**（deleted_at），后台仍然看得到原文。真删除只发生在
 *     删游戏 / 注销账号时，由外键级联完成。
 *   - **隐藏是管理员的动作**（hidden），和作者自己删的分开记 —— 处理举报纠纷时
 *     「谁让它消失的」是要能查的。
 *
 * 国家：取自 Cloudflare 的 CF-IPCountry 请求头，在**发表那一刻**存进这条评论。
 * 不是用户资料的一部分 —— 同一个人换个网络再来，历史评论上的国旗不该跟着变。
 *
 * ⚠️ 这里所有列表接口都**不能**调 publicApi()。评论是随时在变的，
 * 挂上 s-maxage=300 的话，用户发完自己刷新看不到，只会以为发失败了又发一遍。
 * /api 的默认响应头就是 no-store（见 index.js），保持默认即可。
 */
import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireUser, requireAdmin, isAdminRequest } from '../auth.js'
import { commentRowToApi, countryOf } from '../mappers.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'

export const commentsRouter = Router()

/** 正文长度上限，和 game_comments.content 的 VARCHAR(2000) 对齐 */
const MAX_LEN = 2000
/**
 * 发表后多久内还能编辑。
 *
 * 给的是「改错别字」的窗口，不是「改主张」的窗口 —— 别人已经引用回复之后
 * 还能随意改原文，引用卡片就会变成栽赃工具。
 */
const EDIT_WINDOW_MS = 5 * 60 * 1000
/** 列表分页 */
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

/**
 * 客户端所在国家（ISO 3166-1 alpha-2）。
 *
 * CF-IPCountry 是 Cloudflare 在边缘加的，橙云代理下一定有；
 * 拿不到就是 'XX'（前端显示「未知地区」）。Cloudflare 自己对 Tor 出口回 'T1'，
 * 那是个合法的两字母值，照原样存着即可。
 *
 * 没有走 Cloudflare 的部署会全是 'XX' —— 这是预期行为，不是 bug。
 * 想在别的网关上生效，把对应的头名加进下面这张表。
 */
function countryFromRequest(req) {
  const h = req.headers
  return countryOf(h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-country-code'] || '')
}

/** 正文清洗：去首尾空白、把三个以上的连续换行压成两个（防止用空行把侧栏刷屏） */
function cleanContent(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function pageParams(req) {
  const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1)
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(req.query.pageSize)) || DEFAULT_PAGE_SIZE))
  return { page, size, offset: (page - 1) * size }
}

/**
 * 列表查询的公共 SELECT。
 *
 * 两个 LEFT JOIN 是「引用回复」用的：把父评论和它的作者一起带出来，
 * 前端就能直接画引用卡片，不用为每条回复再打一次请求（N+1）。
 * 只带一层 —— 卡片里要的就是「回复谁、说了什么」这一句，不做整棵树。
 */
const SELECT_COLS = `
  c.*, u.nickname, u.avatar, u.email,
  p.content AS parent_content, p.hidden AS parent_hidden, p.deleted_at AS parent_deleted_at,
  pu.nickname AS parent_nickname, pu.avatar AS parent_avatar`

const FROM_JOINS = `
  FROM game_comments c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN game_comments p ON p.id = c.parent_id
  LEFT JOIN users pu ON pu.id = p.user_id`

/* ==========================================================
 * 后台
 *
 * ⚠️ 这几条必须注册在下面 /:id 那几条**之前**。Express 按注册顺序匹配，
 * 反过来的话 PATCH /api/comments/admin/12 会先命中 PATCH /:id，
 * id 变成字符串 'admin'，表现是后台点「隐藏」返回 404 而前台一切正常。
 * ========================================================== */

/**
 * 后台评论列表。
 *   ?status=all | visible | hidden | deleted
 *   ?q=      在正文 / 昵称 / 邮箱 / 游戏名里搜
 *   ?game=   只看某款游戏（slug）
 *
 * 和前台那条不共用：后台要看到被隐藏和被删除的原文，也要按游戏和用户认人。
 */
commentsRouter.get('/admin/list', requireAdmin, async (req, res, next) => {
  try {
    const { page, size, offset } = pageParams(req)
    const where = []
    const params = []

    const status = String(req.query.status || 'all')
    if (status === 'visible') where.push('c.hidden = 0 AND c.deleted_at IS NULL')
    else if (status === 'hidden') where.push('c.hidden = 1')
    else if (status === 'deleted') where.push('c.deleted_at IS NOT NULL')

    if (typeof req.query.game === 'string' && req.query.game.trim()) {
      where.push('g.slug = ?')
      params.push(req.query.game.trim())
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q) {
      where.push('(c.content LIKE ? OR u.nickname LIKE ? OR u.email LIKE ? OR g.title LIKE ?)')
      // LIKE 的通配符要转义，否则搜「100%」会退化成「100 开头的一切」
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      params.push(like, like, like, like)
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const joins = `${FROM_JOINS}\n  JOIN games g ON g.id = c.game_id`

    const total = Number(
      (await queryOne(`SELECT COUNT(*) AS n ${joins} ${clause}`, params))?.n ?? 0,
    )
    const rows = await query(
      `SELECT ${SELECT_COLS}, g.slug AS game_slug, g.title AS game_title ${joins} ${clause}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset],
    )
    res.json({ total, page, pageSize: size, items: rows.map((r) => commentRowToApi(r, { admin: true })) })
  } catch (e) {
    next(e)
  }
})

/**
 * 隐藏 / 恢复一条评论：PATCH /api/comments/admin/:id { hidden: true|false }
 *
 * 隐藏不动 deleted_at，恢复也不会把作者自己删掉的评论捞回来 ——
 * 那两件事的主体不同，不能互相覆盖。
 */
commentsRouter.patch('/admin/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '评论 ID 不合法' })
    if (typeof req.body?.hidden !== 'boolean') return res.status(400).json({ error: 'hidden 必须是布尔值' })
    const r = await query('UPDATE game_comments SET hidden = ? WHERE id = ?', [req.body.hidden ? 1 : 0, id])
    if (!r.affectedRows) return res.status(404).json({ error: '评论不存在' })
    res.json({ ok: true, hidden: req.body.hidden })
  } catch (e) {
    next(e)
  }
})

/** 后台彻底删除。会连带把引用它的回复上的引用关系断开（外键 ON DELETE SET NULL），不删回复本身。 */
commentsRouter.delete('/admin/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '评论 ID 不合法' })
    const r = await query('DELETE FROM game_comments WHERE id = ?', [id])
    if (!r.affectedRows) return res.status(404).json({ error: '评论不存在' })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/* ==========================================================
 * 前台
 * ========================================================== */

/**
 * 某款游戏的评论：GET /api/comments?game=<slug>&page=1&pageSize=20
 *
 * 只回可见的。被隐藏 / 被删除的那些不进列表，但如果有人引用过它们，
 * 引用卡片会显示成「该评论已删除」—— 直接抹掉引用会让回复变得莫名其妙。
 */
commentsRouter.get('/', async (req, res, next) => {
  try {
    const slug = typeof req.query.game === 'string' ? req.query.game.trim() : ''
    if (!slug) return res.status(400).json({ error: '缺少 game 参数' })
    const game = await queryOne('SELECT id FROM games WHERE slug = ?', [slug])
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    const { page, size, offset } = pageParams(req)
    const visible = 'WHERE c.game_id = ? AND c.hidden = 0 AND c.deleted_at IS NULL'
    // 总数只需要主表，不必带上那两个为了引用卡片而做的 JOIN
    const total = Number(
      (await queryOne(`SELECT COUNT(*) AS n FROM game_comments c ${visible}`, [game.id]))?.n ?? 0,
    )
    const rows = await query(
      `SELECT ${SELECT_COLS} ${FROM_JOINS} ${visible}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
      [game.id, size, offset],
    )
    res.json({ total, page, pageSize: size, items: rows.map((r) => commentRowToApi(r)) })
  } catch (e) {
    next(e)
  }
})

/** 按 id 取一条（含 join），发表 / 编辑后回给前端用，保证和列表里的结构完全一致 */
async function loadOne(id, opts) {
  const row = await queryOne(`SELECT ${SELECT_COLS} ${FROM_JOINS} WHERE c.id = ?`, [id])
  return row ? commentRowToApi(row, opts) : null
}

/**
 * 发表：POST /api/comments { gameSlug, content, parentId? }
 *
 * 限流是必须的 —— 这是个登录用户就能往数据库里写文本的接口。
 * 两道：按用户（挡住一个号刷屏）和按 IP（挡住批量注册的小号）。
 * IP 那道只在拿得到真实 IP 时才算 —— 反代没透传时所有人都塌缩成同一个值，
 * 按 IP 限流会退化成「整站每分钟只能有 10 条评论」（见 rateLimit.js 的 isMeaningfulIp）。
 */
commentsRouter.post('/', requireUser, async (req, res, next) => {
  try {
    const slug = String(req.body?.gameSlug ?? '').trim()
    const content = cleanContent(req.body?.content)
    if (!slug) return res.status(400).json({ error: '缺少 gameSlug' })
    if (!content) return res.status(400).json({ error: '评论内容不能为空' })
    if (content.length > MAX_LEN) return res.status(400).json({ error: `评论不能超过 ${MAX_LEN} 字` })

    const perUser = take(`comment:user:${req.user.id}`, 5, 60_000)
    if (!perUser.ok) return res.status(429).json({ error: '发言太频繁，请稍后再试', retryAfter: perUser.retryAfter })
    const perHour = take(`comment:user:hour:${req.user.id}`, 60, 3_600_000)
    if (!perHour.ok) return res.status(429).json({ error: '今天发得有点多，请稍后再试', retryAfter: perHour.retryAfter })
    const ip = clientKey(req)
    if (isMeaningfulIp(ip)) {
      const perIp = take(`comment:ip:${ip}`, 20, 60_000)
      if (!perIp.ok) return res.status(429).json({ error: '发言太频繁，请稍后再试', retryAfter: perIp.retryAfter })
    }

    const game = await queryOne('SELECT id FROM games WHERE slug = ?', [slug])
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    /**
     * 引用的那条必须属于同一款游戏，而且当下是可见的。
     * 不校验的话，随手传一个别的游戏的 id 就能让引用卡片显示另一个页面的内容 ——
     * 拼出一段「某人在某处说过某句话」的假上下文，代价是零。
     */
    let parentId = null
    if (req.body?.parentId !== undefined && req.body?.parentId !== null && req.body?.parentId !== '') {
      const pid = Number(req.body.parentId)
      if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'parentId 不合法' })
      const parent = await queryOne(
        'SELECT id FROM game_comments WHERE id = ? AND game_id = ? AND hidden = 0 AND deleted_at IS NULL',
        [pid, game.id],
      )
      if (!parent) return res.status(400).json({ error: '被回复的评论不存在或已被删除' })
      parentId = parent.id
    }

    const r = await query(
      'INSERT INTO game_comments (game_id, user_id, parent_id, content, country) VALUES (?, ?, ?, ?, ?)',
      [game.id, req.user.id, parentId, content, countryFromRequest(req)],
    )
    res.status(201).json(await loadOne(r.insertId))
  } catch (e) {
    next(e)
  }
})

/**
 * 编辑自己的评论：PATCH /api/comments/:id { content }
 *
 * 只有作者本人、只在 EDIT_WINDOW_MS 之内、且这条还没被隐藏或删除时才行。
 * 管理员**不能**从这里改别人的正文 —— 后台的动作是隐藏和删除，
 * 悄悄替人改一句话是另一个性质的权力，不该顺手给出去。
 */
commentsRouter.patch('/:id', requireUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '评论 ID 不合法' })
    const content = cleanContent(req.body?.content)
    if (!content) return res.status(400).json({ error: '评论内容不能为空' })
    if (content.length > MAX_LEN) return res.status(400).json({ error: `评论不能超过 ${MAX_LEN} 字` })

    const row = await queryOne('SELECT id, user_id, hidden, deleted_at, created_at FROM game_comments WHERE id = ?', [id])
    if (!row) return res.status(404).json({ error: '评论不存在' })
    if (row.user_id !== req.user.id) return res.status(403).json({ error: '只能编辑自己的评论' })
    if (row.deleted_at) return res.status(410).json({ error: '这条评论已删除' })
    if (row.hidden) return res.status(403).json({ error: '这条评论已被管理员隐藏，不能编辑' })
    const age = Date.now() - new Date(row.created_at).getTime()
    if (age > EDIT_WINDOW_MS) {
      return res.status(403).json({ error: `发表超过 ${Math.round(EDIT_WINDOW_MS / 60000)} 分钟的评论不能再编辑` })
    }

    await query('UPDATE game_comments SET content = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [content, id])
    res.json(await loadOne(id))
  } catch (e) {
    next(e)
  }
})

/**
 * 删除：DELETE /api/comments/:id
 *
 * 作者本人或管理员都可以，做的都是软删除 —— 前台立刻消失，后台还留着原文。
 * 需要彻底抹掉的走后台那条 DELETE /admin/:id。
 */
commentsRouter.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '评论 ID 不合法' })
    const row = await queryOne('SELECT id, user_id, deleted_at FROM game_comments WHERE id = ?', [id])
    if (!row) return res.status(404).json({ error: '评论不存在' })
    // requireUser 已经放进来了，这里再问一次「是不是管理员」是为了让管理员
    // 也能从前台直接清理，不必先进后台
    const mine = row.user_id === req.user.id
    if (!mine && !(await isAdminRequest(req))) return res.status(403).json({ error: '只能删除自己的评论' })
    // 已经删过就当成功：用户连点两次删除不该看到一个 404
    if (!row.deleted_at) await query('UPDATE game_comments SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/** 前端要显示「N 字以内」和编辑窗口，从服务端拿，避免两边各写一份对不上 */
commentsRouter.get('/config', (_req, res) => {
  res.json({ maxLength: MAX_LEN, editWindowMs: EDIT_WINDOW_MS, pageSize: DEFAULT_PAGE_SIZE })
})
