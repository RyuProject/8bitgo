import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireUser, hashPassword, verifyPassword, signToken, tokenVersionOf } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds, gameIdBySlug } from '../userdata.js'
import { issueCode, verifyCode, sendCodeError } from '../codes.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const meRouter = Router()
meRouter.use(requireUser)

async function publicWithData(userRow) {
  const [f, r] = await Promise.all([favIds(userRow.id), recentIds(userRow.id)])
  return userRowToPublic(userRow, f, r)
}

/** 改资料（昵称 / 头像） */
meRouter.patch('/', async (req, res, next) => {
  try {
    const patch = {}
    if (req.body.nickname !== undefined) {
      const n = String(req.body.nickname).trim()
      if (n.length < 2 || n.length > 16) return res.status(400).json({ error: '昵称需要 2–16 个字符' })
      patch.nickname = n
    }
    if (req.body.avatar) patch.avatar = String(req.body.avatar)
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `\`${k}\` = ?`).join(', ')
      await query(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(patch), req.user.id])
    }
    const row = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])
    res.json(await publicWithData(row))
  } catch (e) {
    next(e)
  }
})

/**
 * 加入 / 移出「稍后玩」（切换），返回最新列表。
 * 路径上仍然用 slug，内部转成 game_id 存 —— 外键保证不会写进不存在的游戏。
 */
meRouter.post('/favorites/:slug', async (req, res, next) => {
  try {
    const { id } = req.user
    const gameId = await gameIdBySlug(req.params.slug)
    if (!gameId) return res.status(404).json({ error: '游戏不存在' })
    const has = await queryOne('SELECT 1 AS x FROM favorites WHERE user_id = ? AND game_id = ?', [id, gameId])
    if (has) await query('DELETE FROM favorites WHERE user_id = ? AND game_id = ?', [id, gameId])
    else await query('INSERT INTO favorites (user_id, game_id) VALUES (?, ?)', [id, gameId])
    res.json({ favorited: !has, favorites: await favIds(id) })
  } catch (e) {
    next(e)
  }
})

/** 记录最近游玩，只保留最近 12 条 */
meRouter.post('/recents/:slug', async (req, res, next) => {
  try {
    const { id } = req.user
    const gameId = await gameIdBySlug(req.params.slug)
    if (!gameId) return res.status(404).json({ error: '游戏不存在' })
    await query(
      `INSERT INTO recents (user_id, game_id, played_at) VALUES (?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE played_at = CURRENT_TIMESTAMP(3)`,
      [id, gameId],
    )
    // 超出 12 条的旧记录删掉。子查询要套一层派生表：
    // MySQL 不允许在 DELETE 的子查询里直接再查同一张表。
    await query(
      `DELETE FROM recents
        WHERE user_id = ? AND game_id IN (
          SELECT game_id FROM (
            SELECT game_id FROM recents WHERE user_id = ? ORDER BY played_at DESC LIMIT 100 OFFSET 12
          ) old
        )`,
      [id, id],
    )
    res.json({ recent: await recentIds(id) })
  } catch (e) {
    next(e)
  }
})

/* ------------------------------------------------------------------ */
/*  游玩统计                                                           */
/* ------------------------------------------------------------------ */

/**
 * 个人中心顶部那几张小卡片。
 *
 * 全部现算，不做缓存也不建汇总表：一个用户的收藏 / 最近 / 存档最多几百行，
 * 而这个接口只在他自己打开个人中心时被调一次。为它加一层缓存的收益是零，
 * 代价是「刚删了存档，统计还显示 3 份」这种对不上。
 */
meRouter.get('/stats', async (req, res, next) => {
  try {
    const { id, created_at: createdAt } = req.user

    // 云存档那张表在老库上可能还没建（schema-v2 里漏了，见 scripts/migrate.mjs）。
    // 缺表时统计里少一项，不该让整个接口 500 —— 个人中心会整页打不开。
    const savesStat = async () => {
      try {
        return await queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM saves WHERE user_id = ?', [id])
      } catch (e) {
        if (e?.code === 'ER_NO_SUCH_TABLE') return null
        throw e
      }
    }

    const [fav, rec, saves, topPlatform, played] = await Promise.all([
      queryOne('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', [id]),
      queryOne('SELECT COUNT(*) AS n FROM recents WHERE user_id = ?', [id]),
      savesStat(),
      // 最近游玩里出现最多的平台。recents 只留 12 条，所以这是「最近常玩」而不是「历史最爱」——
      // 文案上也得这么写，别让人以为是全量统计
      queryOne(
        `SELECT g.platform AS platform, COUNT(*) AS n
           FROM recents r JOIN games g ON g.id = r.game_id
          WHERE r.user_id = ?
          GROUP BY g.platform ORDER BY n DESC, g.platform ASC LIMIT 1`,
        [id],
      ),
      queryOne('SELECT MAX(played_at) AS last FROM recents WHERE user_id = ?', [id]),
    ])

    // 加入天数按 UTC 日期差算。用「毫秒差 / 86400000 再取整」的话，
    // 今天刚注册的用户会看到 0 天，昨天注册的可能也是 0 天（差 23 小时）
    const day = 86_400_000
    const joinedMs = createdAt ? new Date(createdAt).getTime() : Date.now()
    const days = Math.max(1, Math.floor((Date.now() - joinedMs) / day) + 1)

    res.json({
      days,
      favorites: Number(fav?.n ?? 0),
      recent: Number(rec?.n ?? 0),
      // null = 这个库还没有 saves 表，前端据此整块隐藏云存档，而不是显示「0 份」
      saves: saves ? { count: Number(saves.n), bytes: Number(saves.bytes) } : null,
      topPlatform: topPlatform?.platform || null,
      lastPlayedAt: played?.last ? new Date(played.last).getTime() : null,
    })
  } catch (e) {
    next(e)
  }
})

/* ------------------------------------------------------------------ */
/*  账号与安全                                                         */
/* ------------------------------------------------------------------ */

/** 改完密码 / 换绑邮箱 / 主动登出之后，把令牌版本 +1 并给当前设备换一张新令牌 */
async function rotateToken(userId) {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId])
  const row = await queryOne('SELECT * FROM users WHERE id = ?', [userId])
  return { row, token: signToken(userId, tokenVersionOf(row)) }
}

/**
 * 换绑邮箱第一步：往**新**邮箱发验证码。
 *
 * 码是发给新地址的，收得到才说明那个邮箱真是他的 —— 发给旧地址等于没验证新地址，
 * 填错一个字母就把账号绑到一个永远收不到信的地方，之后再也登不进来。
 * 验证码绑定了当前用户 id（见 codes.js 的 userId 参数）：
 * 不绑的话，A 拿自己那封「换绑到 x@y」的码就能去把 B 的账号也换绑成 x@y。
 */
meRouter.post('/email/request-code', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })
    if (email === String(req.user.email).toLowerCase()) {
      return res.status(400).json({ error: '这已经是你当前的邮箱了' })
    }
    // 先查一次占用。等验证码填完才说「这个邮箱已被注册」，等于白发一封信、白等一分钟
    const taken = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    if (taken) return res.status(409).json({ error: '这个邮箱已经注册过了' })
    res.json({ ok: true, ...(await issueCode(req, email, 'bind', req.user.id)) })
  } catch (e) {
    sendCodeError(res, next, e)
  }
})

/**
 * 换绑邮箱第二步：验码并落库。
 *
 * 会顺带把其它设备踢下线（token_version +1）：邮箱就是这个站的登录凭证，
 * 换了邮箱还留着旧会话的话，「我怀疑号被盗了所以换邮箱」这个动作等于没做。
 * 当前设备直接换一张新令牌，用户自己不会被踢。
 */
meRouter.post('/email', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })
    await verifyCode(email, 'bind', String(req.body.code || ''), req.user.id)

    // 验码这十分钟里可能有别人注册了同一个邮箱，所以这里必须再查一次。
    // 唯一索引 uniq_email 是最后一道，但撞上时报的是 ER_DUP_ENTRY，
    // 兜底处理器会翻成「服务器内部错误」—— 用户完全看不懂。
    const taken = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    if (taken && taken.id !== req.user.id) return res.status(409).json({ error: '这个邮箱已经注册过了' })

    await query('UPDATE users SET email = ? WHERE id = ?', [email, req.user.id])
    const { row, token } = await rotateToken(req.user.id)
    res.json({ token, user: await publicWithData(row) })
  } catch (e) {
    sendCodeError(res, next, e)
  }
})

/**
 * 设置 / 修改登录密码。
 *
 * 验证码登录的账号 password_hash 是空串，这种情况下允许直接设 ——
 * 能拿着有效令牌走到这里，说明他刚刚已经用邮箱验证码证明过身份了。
 * 已经有密码的则必须报出旧密码：只凭一张令牌就能改密码的话，
 * 一台没锁屏的电脑就足够让别人把账号彻底接管过去。
 */
meRouter.put('/password', async (req, res, next) => {
  try {
    const password = String(req.body.password || '')
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })
    if (password.length > 200) return res.status(400).json({ error: '密码太长了' })

    const hasPassword = Boolean(req.user.password_hash)
    if (hasPassword) {
      const current = String(req.body.currentPassword || '')
      if (!current) return res.status(400).json({ error: '请先填写当前密码' })
      if (!(await verifyPassword(current, req.user.password_hash))) {
        return res.status(401).json({ error: '当前密码不正确' })
      }
    }

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), req.user.id])
    // 改密码就该把其它设备踢下线，否则「密码被人知道了所以改密码」这个动作是白做的
    const { row, token } = await rotateToken(req.user.id)
    res.json({ token, user: await publicWithData(row), hadPassword: hasPassword })
  } catch (e) {
    next(e)
  }
})

/**
 * 退出所有设备。
 *
 * JWT 是无状态的，我们手里没有「已签发令牌」的名单，所以没法逐个删。
 * 做法是把 users.token_version +1，所有带旧版本号的令牌在 requireUser 那里当场作废
 * （见 server/src/auth.js 的注释）。当前设备换一张新的，不用重新登录。
 */
meRouter.post('/logout-all', async (req, res, next) => {
  try {
    const { row, token } = await rotateToken(req.user.id)
    res.json({ token, user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

/* ------------------------------------------------------------------ */
/*  注销账号                                                           */
/* ------------------------------------------------------------------ */

/** 管理员不给自己删。删完了就没人能进后台了，而这事从个人中心一键触发太容易误操作 */
function refuseIfAdmin(req, res) {
  if (req.user.role === 'admin') {
    res.status(403).json({ error: '管理员账号不能自助注销，请先把角色改回普通用户' })
    return true
  }
  return false
}

/** 注销第一步：往当前邮箱发一封确认码 */
meRouter.post('/delete/request-code', async (req, res, next) => {
  try {
    if (refuseIfAdmin(req, res)) return
    const email = String(req.user.email).trim().toLowerCase()
    res.json({ ok: true, ...(await issueCode(req, email, 'delete', req.user.id)) })
  } catch (e) {
    sendCodeError(res, next, e)
  }
})

/**
 * 注销第二步：验码并删号。
 *
 * 为什么要一封邮件而不是只弹个「确定吗」：删号不可逆，而个人中心是登录态下的页面 ——
 * 一台没锁屏的电脑、一个借出去的浏览器都能点到这里。要求收信等于再确认一次「人还在」。
 *
 * 收藏 / 最近 / 云存档都挂在 users.id 的外键上（ON DELETE CASCADE），
 * 删这一行数据库会自己把它们清干净，不需要应用层再逐张表删。
 */
meRouter.delete('/', async (req, res, next) => {
  try {
    if (refuseIfAdmin(req, res)) return
    const email = String(req.user.email).trim().toLowerCase()
    await verifyCode(email, 'delete', String(req.body?.code || ''), req.user.id)
    await query('DELETE FROM users WHERE id = ?', [req.user.id])
    res.json({ ok: true })
  } catch (e) {
    sendCodeError(res, next, e)
  }
})
