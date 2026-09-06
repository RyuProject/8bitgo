/**
 * 评分的读写与聚合维护。
 *
 * 为什么单独一个文件、而不是全塞进 routes/ratings.js：
 * `games` 上那三列聚合（rating_sum / rating_weight / rating_count）不只在「有人评分」时
 * 会变 —— **删账号**也会让它变。users 是 game_ratings 的外键父表，删一个用户，
 * 他投过的票被数据库级联清掉，而聚合列不会自己跟着降。删号的代码在 routes/me.js 和
 * routes/users.js，让它们去 import 一个评分路由文件很别扭，所以把重算抽在这里。
 *
 * 聚合是**全量重算**，不是加减增量。增量看起来更快，但只要有任何一条明细是绕过
 * 应用层消失的（外键级联、后台直接删库、导入脚本），增量就会永久跑偏且没人发现 ——
 * 评分这种「看着不太对但不报错」的数据，一旦偏了根本回不去。
 * 全量重算走的是 (game_id) 索引，一款游戏几千票也就是一次索引区间扫描，
 * 而且每次写入都顺手把这款游戏的数字修回正确值，是自愈的。
 */
import { query, withTransaction } from './db.js'

/** 登录用户一票算 1 分权重 */
export const WEIGHT_USER = 1.0
/** 匿名一票算 0.5 —— 门槛低，就该轻一些 */
export const WEIGHT_ANON = 0.5

/**
 * 贝叶斯先验：排序时假装每款游戏都先有 PRIOR_WEIGHT 份权重的「平均分」打底。
 *
 * 不加这个的话，一款只有 1 票 5 分的冷门游戏会排在 500 票 4.8 分的前面 ——
 * 评分排序第一天就会变成「谁的样本少谁靠前」，等于给刷分留了正门。
 * 先验均分取 3.5（五分制的中位偏上，符合玩家实际打分分布，不是 2.5）。
 */
export const PRIOR_WEIGHT = Number(process.env.RATING_PRIOR_WEIGHT || 10)
export const PRIOR_MEAN = Number(process.env.RATING_PRIOR_MEAN || 3.5)

/**
 * 排序用的加权分表达式（带 g. 前缀，和 games-repo.js 的 orderBy 对齐）。
 * 直接吃 games 上的聚合列，不 join 明细表 —— 列表页每次都 join 一张只会越来越大的
 * 表，是这三列冗余存在的全部理由。
 */
export const BAYES_SCORE_SQL =
  `(g.rating_sum + ${PRIOR_MEAN} * ${PRIOR_WEIGHT}) / (g.rating_weight + ${PRIOR_WEIGHT})`

/**
 * 一款游戏的评分明细汇总。
 *
 * 一条 GROUP BY 同时给出**分布**和**总量**：前端要画 1~5 星的柱状分布，
 * 而 sum/weight/count 可以从这五行直接算出来，不必再查一次 games。
 * 这里算出来的是权威值，games 上那三列只是给列表排序用的缓存。
 */
export async function ratingStats(gameId) {
  const rows = await query(
    'SELECT score, COUNT(*) AS n, SUM(weight) AS w FROM game_ratings WHERE game_id = ? GROUP BY score',
    [gameId],
  )
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let sum = 0
  let weight = 0
  let count = 0
  for (const r of rows) {
    const score = Number(r.score)
    const n = Number(r.n) || 0
    const w = Number(r.w) || 0
    if (score >= 1 && score <= 5) distribution[score] = n
    count += n
    weight += w
    sum += score * w
  }
  // 一票都没有时 average 是 null 而不是 0 —— 前端要区分「没人评过」和「都给了 0 分」，
  // 后者在 1~5 分制里根本不存在
  const average = weight > 0 ? Math.round((sum / weight) * 10) / 10 : null
  return { average, count, weight: Math.round(weight * 10) / 10, distribution }
}

/**
 * 把 games 上的三列聚合按明细重算。
 *
 * @param {Array<number|string>} gameIds 为空数组时直接返回，不发查询
 */
export async function recomputeGameRatings(gameIds) {
  const ids = [...new Set((gameIds ?? []).map(Number).filter(Number.isFinite))]
  if (!ids.length) return 0
  const r = await query(recomputeSql(ids.length), ids)
  return r?.affectedRows ?? 0
}

/**
 * 重算语句本体。抽成函数是因为**提交评分那条路径必须在同一个事务里重算** ——
 * 用 query() 会另开一条连接，读到的是事务外的旧明细，算出来的聚合正好差自己这一票。
 * 路由那边拿 withTransaction 给的 run 来跑它。
 */
export const recomputeSql = (n = 1) => `UPDATE games g SET
       g.rating_sum    = COALESCE((SELECT SUM(r.score * r.weight) FROM game_ratings r WHERE r.game_id = g.id), 0),
       g.rating_weight = COALESCE((SELECT SUM(r.weight)           FROM game_ratings r WHERE r.game_id = g.id), 0),
       g.rating_count  = COALESCE((SELECT COUNT(*)                FROM game_ratings r WHERE r.game_id = g.id), 0)
     WHERE g.id IN (${Array.from({ length: n }, () => '?').join(', ')})`

/**
 * 这个用户给哪些游戏评过分 —— **删号之前**调，把 id 收好，
 * 级联删完再拿这份 id 去 recomputeGameRatings()。顺序反了就什么都查不到了。
 */
export async function gamesRatedBy(userId) {
  const rows = await query('SELECT DISTINCT game_id FROM game_ratings WHERE user_id = ?', [userId])
  return rows.map((r) => Number(r.game_id))
}

/**
 * 找「某个身份在某款游戏上的那一票」。
 * 登录只认 user_id；匿名先按 anon_id，再按 anon_ip 兜底（见 routes/ratings.js 的说明）。
 *
 * @param {(sql: string, params: any[]) => Promise<any[]>} run 事务里传 withTransaction 的 run，事务外直接传 query
 * @param {boolean} lock 事务里要加 FOR UPDATE，否则并发提交会各自读到对方之前的明细
 */
export async function findRating(run, gameId, { userId, anonId, anonIp }, lock = false) {
  const forUpdate = lock ? ' FOR UPDATE' : ''
  if (userId) {
    return (await run(`SELECT * FROM game_ratings WHERE game_id = ? AND user_id = ?${forUpdate}`, [gameId, userId]))[0] ?? null
  }
  if (anonId) {
    const byId = (await run(`SELECT * FROM game_ratings WHERE game_id = ? AND anon_id = ?${forUpdate}`, [gameId, anonId]))[0]
    if (byId) return byId
  }
  if (anonIp) {
    const byIp = (await run(`SELECT * FROM game_ratings WHERE game_id = ? AND anon_ip = ?${forUpdate}`, [gameId, anonIp]))[0]
    if (byIp) return byIp
  }
  return null
}

/**
 * 写入一票并同步聚合。返回 { created }。
 *
 * 只有这一个实现 —— 独立评分接口和「评论顺带带分」走的是同一条路径。
 * 复制一份给评论用的话，两边的去重规则迟早会分叉，而分叉的表现是
 * 「从评论框打的分和从星星打的分算出两个平均值」，没人会立刻发现。
 *
 * 整件事在一个事务里：先 FOR UPDATE 锁住这一票，写完立刻按明细重算 games 上的聚合列。
 */
export async function submitRating({ gameId, userId = null, anonId = null, anonIp = null, score, country = 'XX' }) {
  return withTransaction(async (run) => {
    const r = await applyRating(run, { gameId, userId, anonId, anonIp, score, country })
    await run(recomputeSql(1), [gameId])
    return r
  })
}

/**
 * 写入那一票本身，不碰聚合列 —— 事务和重算都由调用方管。
 *
 * 拆出来是为了能测：去重规则（谁顶掉谁、什么时候是新票）是这套东西里唯一有真实
 * 出错空间的部分，而它全是 SQL。抽成「收一个 run 就干活」的形状之后，
 * 回归测试可以拿一个内存 SQLite 当 run 直接跑**这段真代码**，
 * 不必在测试里再抄一遍同形的语句 —— 抄的那份和真身迟早会分叉。
 * 见 scripts/test-ratings.mjs。
 */
export async function applyRating(run, { gameId, userId = null, anonId = null, anonIp = null, score, country = 'XX' }) {
  /**
   * 登录用户如果之前在同一个浏览器里匿名评过，把那张匿名票撤掉 ——
   * 不撤的话同一个人在同一款游戏上占着 1.0 + 0.5 两票。
   * 只按 anon_id 撤，**绝不按 anon_ip**：IP 是共用的，按 IP 撤等于顺手删掉室友的票。
   */
  if (userId && anonId) {
    await run('DELETE FROM game_ratings WHERE game_id = ? AND anon_id = ? AND user_id IS NULL', [gameId, anonId])
  }

  const existing = await findRating(run, gameId, { userId, anonId, anonIp }, true)
  const weight = userId ? WEIGHT_USER : WEIGHT_ANON

  /**
   * 匿名票要换 IP 之前，先把这个 IP 从**别人**那一行上摘掉。
   *
   * 不做这一步会撞 uniq_rating_ip，而且是个死循环：某人在家评过一次（anon_id=A、IP=甲），
   * 换到咖啡馆再改分，而这家咖啡馆的 IP（乙）上已经有另一行匿名票。
   * 我们按 anon_id 找到的是他自己那行，把它的 anon_ip 改成乙 —— 正好和那一行撞。
   * 用户看到的是「评分提交失败」，而且重试多少次都一样。
   *
   * 处理办法是「最近这次投票的人占住这个 IP」：把旧的那一行的 anon_ip 置空。
   * 它的票还在（不能删，那是另一个人的），只是不再参与 IP 去重。
   * 不会给刷分放水 —— 每留下一行本来就已经消耗掉一个真实 IP 了。
   */
  if (!userId && anonIp) {
    await run('UPDATE game_ratings SET anon_ip = NULL WHERE game_id = ? AND anon_ip = ? AND id <> ?', [
      gameId,
      anonIp,
      existing?.id ?? 0,
    ])
  }

  if (existing) {
    // 匿名行顺手把 anon_id / anon_ip 刷成这次的值：换浏览器或换网络之后，
    // 下次还能凭新的标识找回同一张票，而不是又插一张
    await run('UPDATE game_ratings SET score = ?, weight = ?, anon_id = ?, anon_ip = ?, country = ? WHERE id = ?', [
      score,
      weight,
      userId ? null : anonId,
      userId ? null : anonIp,
      country,
      existing.id,
    ])
  } else {
    await run(
      'INSERT INTO game_ratings (game_id, user_id, anon_id, anon_ip, score, weight, country) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gameId, userId, userId ? null : anonId, userId ? null : anonIp, score, weight, country],
    )
  }
  return { created: !existing }
}

/** 撤销一票。没有这一票时什么都不做，返回 false */
export async function removeRating({ gameId, userId = null, anonId = null, anonIp = null }) {
  return withTransaction(async (run) => {
    const existing = await findRating(run, gameId, { userId, anonId, anonIp }, true)
    if (!existing) return false
    await run('DELETE FROM game_ratings WHERE id = ?', [existing.id])
    await run(recomputeSql(1), [gameId])
    return true
  })
}
