import { Router } from 'express'
import { query, queryOne } from '../db.js'
import { requireAbility, hasAbility } from '../auth.js'
import { isRole, ROLE_LABELS } from '../../../shared/roles.js'
import { userRowToPublic } from '../mappers.js'

export const usersRouter = Router()
usersRouter.use(requireAbility('users:manage'))

/** 全部用户（含收藏 / 最近，供后台展示） */
usersRouter.get('/', async (_req, res, next) => {
  try {
    const users = await query('SELECT * FROM users ORDER BY created_at DESC')
    // v2 里这两张表存的是 game_id，join 回 games 拿 slug（对外一直用 slug）
    const favs = await query(
      'SELECT f.user_id, g.slug AS game_slug FROM favorites f JOIN games g ON g.id = f.game_id ORDER BY f.created_at DESC',
    )
    const recents = await query(
      'SELECT r.user_id, g.slug AS game_slug FROM recents r JOIN games g ON g.id = r.game_id ORDER BY r.played_at DESC',
    )
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
 * 还剩几个能用的管理员（不含被封禁的）。
 *
 * 三处护栏都靠它：封禁、删除、以及**把管理员降级**。最后一条最容易漏 ——
 * 把自己或者仅存的那个管理员改成志愿者，站里就再也没人能改角色了，
 * 只能回数据库里手工 UPDATE。
 */
async function activeAdminCount(excludeId) {
  const r = await queryOne(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
    [excludeId ?? ''],
  )
  return Number(r?.n ?? 0)
}

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
    const target = await queryOne('SELECT id, role, status FROM users WHERE id = ?', [id])
    if (!target) return res.status(404).json({ error: '用户不存在' })
    // 参数校验放在任何写操作之前：同一个请求里带了别的字段时，不能改了一半再报错
    if (req.body.birthDate !== undefined && req.body.birthDate !== null) {
      return res.status(400).json({ error: 'birthDate 只能清除（传 null），不能由后台代填' })
    }

    if (req.body.coinsDelta !== undefined) {
      const delta = Math.trunc(Number(req.body.coinsDelta))
      if (!Number.isFinite(delta)) return res.status(400).json({ error: 'coinsDelta 必须是数字' })
      if (Math.abs(delta) > MAX_COIN_DELTA) {
        return res.status(400).json({ error: `单次调整不能超过 ${MAX_COIN_DELTA.toLocaleString('en-US')} G 币` })
      }
      if (delta !== 0) await query('UPDATE users SET coins = GREATEST(0, coins + ?) WHERE id = ?', [delta, id])
    }

    /**
     * 改角色。单独一道权限点（users:role）—— 能封号的人不一定就该能发权限，
     * 而「发权限」是唯一一个能把权限扩散出去的操作，值得单独卡一道。
     */
    if (req.body.role !== undefined) {
      if (!(await hasAbility(req, 'users:role'))) {
        return res.status(403).json({ error: '权限不足：需要 users:role' })
      }
      const role = req.body.role
      if (!isRole(role)) {
        return res.status(400).json({ error: `role 只能是 ${Object.keys(ROLE_LABELS).join(' / ')}` })
      }
      // 把自己降级 = 当场把自己关在后台外面，而且大概率还是最后一个管理员
      if (req.user?.id === id && role !== 'admin') {
        return res.status(400).json({ error: '不能给自己降级' })
      }
      if (target.role === 'admin' && role !== 'admin' && (await activeAdminCount(id)) === 0) {
        return res.status(400).json({ error: '这是最后一个可用的管理员，不能降级' })
      }
      if (role !== target.role) await query('UPDATE users SET role = ? WHERE id = ?', [role, id])
    }

    if (req.body.status === 'active' || req.body.status === 'banned') {
      if (req.body.status === 'banned') {
        if (req.user?.id === id) return res.status(400).json({ error: '不能封禁自己' })
        if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
          return res.status(400).json({ error: '这是最后一个可用的管理员，不能封禁' })
        }
      }
      await query('UPDATE users SET status = ? WHERE id = ?', [req.body.status, id])
    }

    /**
     * 清除出生日期（成人内容年龄验证）。
     * 用户自己填一次就锁死（见 routes/me.js 的 PUT /birth-date），填错了只能从这里清掉让他重填。
     * 只接受 null —— 后台不代填：出生日期是本人的声明，管理员替人填一个成年日期等于替人担责。
     */
    if (req.body.birthDate === null) {
      await query('UPDATE users SET birth_date = NULL WHERE id = ?', [id])
    }

    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/** 删除用户。favorites / recents 有 ON DELETE CASCADE，会跟着一起删掉。 */
usersRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const target = await queryOne('SELECT id, role FROM users WHERE id = ?', [id])
    if (!target) return res.status(404).json({ error: '用户不存在' })
    if (req.user?.id === id) return res.status(400).json({ error: '不能删除自己' })
    if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
      return res.status(400).json({ error: '这是最后一个可用的管理员，不能删除' })
    }
    await query('DELETE FROM users WHERE id = ?', [id])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
