import { Router } from 'express'
import { query, withTransaction } from '../db.js'
import { requireAbility, hasAbility } from '../auth.js'
import { isRole, ROLE_LABELS } from '../../../shared/roles.js'
import { userRowToPublic } from '../mappers.js'
import { recomputeSql } from '../ratings-repo.js'

export const usersRouter = Router()
usersRouter.use(requireAbility('users:manage'))

/**
 * 后台用户列表一次最多取多少人。
 *
 * 这条是管理员打开后台的**第一个请求**，而它原来是三条不带任何 WHERE / LIMIT 的查询：
 * users 全表、favorites 全表 join games、recents 全表 join games，全部拉进内存。
 * 上万用户时这一个接口就能同时吃满内存和连接池 —— 而且它拦在后台所有页面前面。
 *
 * 2000 对后台列表页绰绰有余（真要查某个具体用户有搜索）。
 */
const MAX_USERS = Number(process.env.ADMIN_USERS_MAX || 2000)

/** 全部用户（含收藏 / 最近，供后台展示） */
usersRouter.get('/', async (_req, res, next) => {
  try {
    const users = await query('SELECT * FROM users ORDER BY created_at DESC LIMIT ?', [MAX_USERS + 1])
    if (users.length > MAX_USERS) {
      console.warn(`[users] 后台用户列表被截断到 ${MAX_USERS} 条（表里还有更多），请改用搜索定位具体用户`)
      users.length = MAX_USERS
    }
    const ids = users.map((u) => u.id)
    // v2 里这两张表存的是 game_id，join 回 games 拿 slug（对外一直用 slug）
    //
    // ⚠️ 必须带上 `WHERE user_id IN (...)`：原来这两句是**全表 join**，
    // 一个有一百万条 recents 的库会把一百万行拖进 Node 的内存里，
    // 结果只用了前 12 条（下面 slice(0, 12)）。
    const holes = ids.map(() => '?').join(',')
    const favs = ids.length
      ? await query(
          `SELECT f.user_id, g.slug AS game_slug FROM favorites f JOIN games g ON g.id = f.game_id
           WHERE f.user_id IN (${holes}) ORDER BY f.created_at DESC`,
          ids,
        )
      : []
    const recents = ids.length
      ? await query(
          `SELECT r.user_id, g.slug AS game_slug FROM recents r JOIN games g ON g.id = r.game_id
           WHERE r.user_id IN (${holes}) ORDER BY r.played_at DESC`,
          ids,
        )
      : []
    const byUser = (rows) => {
      const m = new Map()
      for (const r of rows) {
        if (!m.has(r.user_id)) m.set(r.user_id, [])
        m.get(r.user_id).push(r.game_slug)
      }
      return m
    }
    const fMap = byUser(favs)
    const rMap = byUser(recents)
    res.json(users.map((u) => userRowToPublic(u, fMap.get(u.id) || [], (rMap.get(u.id) || []).slice(0, 12))))
  } catch (e) {
    next(e)
  }
})

/** 单次调整金币的上限，挡住手滑多打几个零 */
const MAX_COIN_DELTA = 1_000_000

/**
 * 调整金币 / 改状态（封禁 / 解封）。
 *
 * 两道护栏，以前都没有：
 *  1. 不能封禁 / 删除自己 —— 封了自己下一次请求就被 requireUser 拦住，直接把自己关在外面；
 *  2. 不能封禁 / 删除最后一个还能用的管理员 —— 同上，只是慢一步发现。
 * 用后台口令（ADMIN_TOKEN）调用时 req.user 为空，第 1 条自然不适用，第 2 条仍然生效。
 */
usersRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const hasCoins = body.coinsDelta !== undefined
    const hasRole = body.role !== undefined
    const hasStatus = body.status !== undefined
    const clearBirthDate = body.birthDate === null

    // 所有校验必须在事务和任何 UPDATE 之前完成。以前 coinsDelta 先落库、role 后校验，
    // `{coinsDelta:100, role:'root'}` 会回 400，但金币已经真的加了——接口陈述与数据库相反。
    if (body.birthDate !== undefined && body.birthDate !== null) {
      return res.status(400).json({ error: 'birthDate 只能清除（传 null），不能由后台代填' })
    }
    let delta = 0
    if (hasCoins) {
      delta = Math.trunc(Number(body.coinsDelta))
      if (!Number.isFinite(delta)) return res.status(400).json({ error: 'coinsDelta 必须是数字' })
      if (Math.abs(delta) > MAX_COIN_DELTA) {
        return res.status(400).json({ error: `单次调整不能超过 ${MAX_COIN_DELTA.toLocaleString('en-US')} G 币` })
      }
    }
    if (hasRole) {
      if (!(await hasAbility(req, 'users:role'))) {
        return res.status(403).json({ error: '权限不足：需要 users:role' })
      }
      if (!isRole(body.role)) {
        return res.status(400).json({ error: `role 只能是 ${Object.keys(ROLE_LABELS).join(' / ')}` })
      }
    }
    if (hasStatus && body.status !== 'active' && body.status !== 'banned') {
      return res.status(400).json({ error: 'status 只能是 active / banned' })
    }

    const result = await withTransaction(async (run) => {
      /*
        所有用户管理事务先按固定顺序锁住“当前可用管理员”集合，再锁目标用户。
        不加锁时，两名管理员可以同时把对方降级/删除：两边都看到“还有另一个管理员”，
        然后一起提交，站点瞬间变成零管理员。固定锁顺序也避免 A 先锁 A、B 先锁 B 的死锁。
      */
      const activeAdmins = await run(
        "SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE",
      )
      const targets = await run('SELECT id, role, status FROM users WHERE id = ? FOR UPDATE', [id])
      const target = targets[0]
      if (!target) return { error: { status: 404, message: '用户不存在' } }

      const otherActiveAdmin = activeAdmins.some((row) => String(row.id) !== String(id))
      const nextRole = hasRole ? body.role : target.role
      const nextStatus = hasStatus ? body.status : target.status

      if (req.user?.id === id && nextRole !== 'admin') {
        return { error: { status: 400, message: '不能给自己降级' } }
      }
      if (req.user?.id === id && nextStatus === 'banned') {
        return { error: { status: 400, message: '不能封禁自己' } }
      }
      if (target.role === 'admin' && target.status === 'active' &&
          (nextRole !== 'admin' || nextStatus !== 'active') && !otherActiveAdmin) {
        const action = nextRole !== 'admin' ? '降级' : '封禁'
        return { error: { status: 400, message: `这是最后一个可用的管理员，不能${action}` } }
      }

      if (hasCoins && delta !== 0) {
        await run('UPDATE users SET coins = GREATEST(0, coins + ?) WHERE id = ?', [delta, id])
      }
      if (hasRole && body.role !== target.role) {
        await run('UPDATE users SET role = ? WHERE id = ?', [body.role, id])
      }
      if (hasStatus && body.status !== target.status) {
        await run('UPDATE users SET status = ? WHERE id = ?', [body.status, id])
      }
      // 用户本人只能填一次；填错时管理员只负责清空，让本人重新声明。
      if (clearBirthDate) await run('UPDATE users SET birth_date = NULL WHERE id = ?', [id])
      return { error: null }
    })
    if (result.error) return res.status(result.error.status).json({ error: result.error.message })

    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/**
 * 删除用户。favorites / recents 有 ON DELETE CASCADE，会跟着一起删掉。
 *
 * ⚠️ 评分要多做一步：game_ratings 也是级联删的，但 games 上的评分聚合列
 * 是冗余缓存，数据库不会替我们降。所以**删之前**先记下他投过哪些游戏，
 * 删完再按明细重算那几款 —— 顺序反了就一条都查不到了。
 */
usersRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    if (req.user?.id === id) return res.status(400).json({ error: '不能删除自己' })

    const result = await withTransaction(async (run) => {
      const activeAdmins = await run(
        "SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE",
      )
      const targets = await run('SELECT id, role, status FROM users WHERE id = ? FOR UPDATE', [id])
      const target = targets[0]
      if (!target) return { error: { status: 404, message: '用户不存在' } }
      if (target.role === 'admin' && target.status === 'active' &&
          !activeAdmins.some((row) => String(row.id) !== String(id))) {
        return { error: { status: 400, message: '这是最后一个可用的管理员，不能删除' } }
      }

      // 评分明细会随用户级联删除；games 上的冗余聚合必须在同一个事务里同步重算。
      const ratedRows = await run('SELECT DISTINCT game_id FROM game_ratings WHERE user_id = ?', [id])
      const rated = [...new Set(ratedRows.map((row) => Number(row.game_id)).filter(Number.isFinite))]
      await run('DELETE FROM users WHERE id = ?', [id])
      if (rated.length) await run(recomputeSql(rated.length), rated)
      return { error: null }
    })
    if (result.error) return res.status(result.error.status).json({ error: result.error.message })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
