/**
 * 游戏评分：1~5 星，登录一票算 1.0，匿名一票算 0.5。
 *
 * 为什么匿名也能评：评分是「这游戏好不好玩」的信号，不是社区发言。逼人注册才能打分，
 * 拿到的样本会小一个数量级，而且全是重度用户 —— 这样的平均分对新玩家没有参考价值。
 * 代价是必须自己扛住刷分，所以匿名票只有一半权重，且有两道去重（见下）。
 *
 * ⚠️ 匿名身份是**两层**的，缺一不可：
 *   - anon_id：浏览器本地长期保存的随机串。它的作用是让同一个人**能改自己的分**，
 *     不是防刷 —— 前端存的东西，清一下就换一个。
 *   - anon_ip：真正的去重底线，一个 IP 对一款游戏只留一张匿名票。
 *     所以 anon_id 换了但 IP 没换时，会**认领**原来那一行而不是新插一行。
 *
 * 副作用是同一个出口 IP 下的第二个人评分会覆盖第一个人的（家庭、宿舍、公司）。
 * 这是明知的取舍：匿名票只有 0.5 权重，误伤的代价远小于放开 IP 让脚本随便灌。
 * 真在意自己那一票的人登录即可 —— 登录票只按 user_id 去重，完全不看 IP。
 *
 * ⚠️ 拿不到真实客户端 IP 时（反代没透传，见 rateLimit.js 的 isMeaningfulIp），
 * anon_ip 必须写 NULL 而不是那个塌缩后的地址 —— 否则全站所有匿名访客都会被认成同一个人，
 * 表现是「第二个人开始谁都评不了分，只能改掉别人的」。UNIQUE 允许多个 NULL，正好合用。
 */
import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { optionalUser } from '../auth.js'
import { countryOf } from '../mappers.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'
import { ratingStats, findRating, submitRating, removeRating } from '../ratings-repo.js'

export const ratingsRouter = Router()

/** anon_id 是前端生成的 32 位随机串（对齐 game_ratings.anon_id 的 CHAR(32)） */
const ANON_ID_RE = /^[A-Za-z0-9]{32}$/

/** 客户端所在国家，和评论同源（CF-IPCountry）。只做事后分析用，不对外展示 */
function countryFromRequest(req) {
  const h = req.headers
  return countryOf(h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-country-code'] || '')
}

/** 只在 IP 能区分访客时才拿来当身份，否则一律 null（见文件头的警告） */
function anonIpOf(req) {
  const ip = clientKey(req)
  return isMeaningfulIp(ip) ? String(ip).slice(0, 45) : null
}

/** 取请求里的 anon_id：body 优先（POST），其次 query（GET）。不合法一律当没有 */
function anonIdOf(req) {
  const raw = String(req.body?.anonId ?? req.query?.anonId ?? '').trim()
  return ANON_ID_RE.test(raw) ? raw : null
}

/**
 * 封禁账号一律挡掉，不是当成「未登录」放过去。
 *
 * optionalUser 和 requireUser 不同 —— 它不看 status，被封的号手里那张令牌到期之前
 * 仍然解得开。当成匿名放行的话，封号对刷分毫无作用（还白送 0.5 权重）；
 * 明确回 403 才和评论那边的行为一致。
 */
function refuseIfBanned(req, res) {
  if (req.user?.status === 'banned') {
    res.status(403).json({ error: '账号已被封禁' })
    return true
  }
  return false
}

/** 1~5 的整数，别的一律拒绝（前端只会发这五个值，发别的就是有人在试） */
function scoreOf(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
}

/** 按 slug 找游戏。隐藏的游戏也允许评分 —— 隐藏只影响列表曝光，不影响已经拿到链接的人 */
async function gameBySlug(slug) {
  if (!slug) return null
  return (await queryOne('SELECT id FROM games WHERE slug = ?', [slug])) ?? null
}

/** 把一行明细变成对外的 mine 形状 */
function mineOf(row) {
  if (!row) return null
  return {
    score: Number(row.score),
    weight: Number(row.weight),
    anonymous: row.user_id == null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
  }
}

/**
 * 汇总：GET /api/ratings?game=<slug>&anonId=<32位>
 *
 * 回的 average / count 是**按明细现算**的，不读 games 上那三列缓存 ——
 * 详情页上的数字必须永远是对的，列表排序才用得起缓存列。
 */
ratingsRouter.get('/', optionalUser, async (req, res, next) => {
  try {
    const slug = typeof req.query.game === 'string' ? req.query.game.trim() : ''
    if (!slug) return res.status(400).json({ error: '缺少 game 参数' })
    const game = await gameBySlug(slug)
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    const stats = await ratingStats(game.id)
    const identity = { userId: req.user?.id ?? null, anonId: anonIdOf(req), anonIp: anonIpOf(req) }
    // 完全没身份（未登录且没带 anon_id、IP 也不可信）时不查 mine，省一次查询
    const mine = identity.userId || identity.anonId || identity.anonIp ? await findRating(query, game.id, identity) : null
    res.json({ ...stats, mine: mineOf(mine) })
  } catch (e) {
    next(e)
  }
})

/**
 * 提交 / 修改评分：POST /api/ratings { gameSlug, score, anonId? }
 *
 * 整个写入在一个事务里：先 FOR UPDATE 锁住「我那一票」，改完立刻按明细重算 games 上的聚合。
 * 分开两条语句发的话，两个人同时评同一款游戏就会各自读到对方之前的明细，
 * 后提交的那次把前一次的票算丢 —— 这种偏差不会报错，只会让数字慢慢不对。
 */
ratingsRouter.post('/', optionalUser, async (req, res, next) => {
  try {
    if (refuseIfBanned(req, res)) return
    const slug = String(req.body?.gameSlug ?? '').trim()
    const score = scoreOf(req.body?.score)
    if (!slug) return res.status(400).json({ error: '缺少 gameSlug' })
    if (score === null) return res.status(400).json({ error: '评分必须是 1 到 5 的整数' })

    const anonId = anonIdOf(req)
    const anonIp = anonIpOf(req)
    const userId = req.user?.id ?? null

    // 匿名必须自报 anon_id。不强制的话，拿不到真实 IP 的部署上每一次匿名提交都会新插一行，
    // 同一个人点五次就是五票 —— 那评分就没有意义了
    if (!userId && !anonId) return res.status(400).json({ error: '缺少 anonId' })

    if (userId) {
      const perMin = take(`rating:user:${userId}`, 20, 60_000)
      if (!perMin.ok) return res.status(429).json({ error: '操作太频繁，请稍后再试', retryAfter: perMin.retryAfter })
      const perHour = take(`rating:user:hour:${userId}`, 200, 3_600_000)
      if (!perHour.ok) return res.status(429).json({ error: '操作太频繁，请稍后再试', retryAfter: perHour.retryAfter })
    } else {
      /*
        ⚠️ 顺序要紧：**先按 IP，再按 anonId**。

        anonId 是客户端自报的（见 anonIdOf），32 位随机字母数字，攻击者要多少有多少。
        原来是先 `take('rating:anon:'+anonId)` 再按 IP —— 于是被 IP 闸拒掉的那条请求
        **已经在限流表里建好了一个新桶**，每条请求净增一条记录，而且那条路一次库都不查，
        攻击者这边接近零成本。反过来先判 IP，超了就直接出去，攻击面归零。
      */
      if (anonIp) {
        const perIp = take(`rating:ip:${anonIp}`, 30, 60_000)
        if (!perIp.ok) return res.status(429).json({ error: '操作太频繁，请稍后再试', retryAfter: perIp.retryAfter })
      }
      const perAnon = take(`rating:anon:${anonId}`, 10, 60_000)
      if (!perAnon.ok) return res.status(429).json({ error: '操作太频繁，请稍后再试', retryAfter: perAnon.retryAfter })
    }

    const game = await gameBySlug(slug)
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    const country = countryFromRequest(req)
    const identity = { userId, anonId, anonIp }
    const { created } = await submitRating({ gameId: game.id, ...identity, score, country })

    const stats = await ratingStats(game.id)
    const mine = await findRating(query, game.id, identity)
    // 新插的回 201、改分的回 200。前端不靠它区分，纯粹是让访问日志能一眼看出哪些是新票
    res.status(created ? 201 : 200).json({ ...stats, mine: mineOf(mine) })
  } catch (e) {
    // 两个请求同时给同一个身份插第一票时会撞唯一键。这不是错误，是竞态 ——
    // 对用户来说「我的分已经记上了」，回 409 让前端重新拉一次汇总即可
    if (e?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '评分正在处理，请重试' })
    next(e)
  }
})

/**
 * 撤销自己的评分：DELETE /api/ratings?game=<slug>&anonId=<32位>
 *
 * 有「改分」还要「撤分」，是因为改分回不到「没评过」这个状态。
 * 手滑点了一星又不想给任何分的人，没有这条就只能被迫留一个分。
 */
ratingsRouter.delete('/', optionalUser, async (req, res, next) => {
  try {
    if (refuseIfBanned(req, res)) return
    const slug = typeof req.query.game === 'string' ? req.query.game.trim() : ''
    if (!slug) return res.status(400).json({ error: '缺少 game 参数' })
    const game = await gameBySlug(slug)
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    const identity = { userId: req.user?.id ?? null, anonId: anonIdOf(req), anonIp: anonIpOf(req) }
    if (!identity.userId && !identity.anonId) return res.status(400).json({ error: '缺少 anonId' })

    await removeRating({ gameId: game.id, ...identity })

    const stats = await ratingStats(game.id)
    res.json({ ...stats, mine: null })
  } catch (e) {
    next(e)
  }
})
