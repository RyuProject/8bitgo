import { Router } from 'express'
import { query, queryOne, withTransaction } from '../db.js'
import { requireAdmin, isAdminRequest } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { shouldCount } from '../playcount.js'
import { gameRowToApi, gameApiToRow, gameApiToPartialRow, buildUpsert } from '../mappers.js'

export const gamesRouter = Router()

/**
 * 游戏列表。
 *
 * 默认只返回已上架的（hidden = 0）。加 ?all=1 才返回全部，且需要管理员身份 ——
 * 以前这里无条件返回全部，等于任何人 curl 一下就能看到你下架的游戏，
 * 「下架」这个功能形同虚设。后台自己会带上管理员口令来取全量。
 */
gamesRouter.get('/', async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1'
    if (wantAll && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: '需要管理员权限才能查看全部游戏' })
    }
    const sql = wantAll
      ? 'SELECT * FROM games ORDER BY plays DESC'
      : 'SELECT * FROM games WHERE hidden = 0 ORDER BY plays DESC'
    const rows = await query(sql)
    // 只有公开视角（不带 ?all=1）才可以缓存：管理员视角带着身份，
    // 缓存下来等于把下架游戏 / 草稿发给所有人
    if (!wantAll) publicApi(res)
    res.json(rows.map(gameRowToApi))
  } catch (e) {
    next(e)
  }
})

gamesRouter.get('/:slug', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT * FROM games WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '游戏不存在' })
    // 已下架的对外当作不存在，只有管理员能取到
    if (row.hidden && !(await isAdminRequest(req))) {
      return res.status(404).json({ error: '游戏不存在' })
    }
    // 上架的游戏对所有人一样，可以缓存；下架的（只有管理员看得到）保持 no-store
    if (!row.hidden) publicApi(res)
    res.json(gameRowToApi(row))
  } catch (e) {
    next(e)
  }
})

/**
 * 记录一次真实游玩。前端在模拟器真的跑起来（onReady）时调用，不需要登录。
 *
 * 几点刻意的设计：
 *  - 只对已上架且存在的游戏计数，下架的、不存在的一律当没发生；
 *  - 同一来源 30 分钟内对同一款游戏只算一次（见 playcount.js）；
 *  - **不调 invalidateContent()**。游玩上报是高频写，每次都清 SSR 缓存等于把缓存关掉；
 *    次数本来就允许有一个 TTL 的延迟。
 *  - 无论算没算数都回 200，前端不需要处理失败 —— 这不是一个业务操作。
 */
gamesRouter.post('/:slug/play', async (req, res, next) => {
  try {
    const { slug } = req.params
    if (!shouldCount(req, slug)) return res.json({ ok: true, counted: false })
    const result = await query('UPDATE games SET plays = plays + 1 WHERE slug = ? AND hidden = 0', [slug])
    res.json({ ok: true, counted: Boolean(result.affectedRows) })
  } catch (e) {
    next(e)
  }
})

/** 新增 / 覆盖一款游戏（后台） */
gamesRouter.put('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const body = { ...req.body, slug: req.params.slug }
    const row = gameApiToRow(body)
    const { sql, values } = buildUpsert('games', row, 'slug')
    await query(sql, values)
    const saved = await queryOne('SELECT * FROM games WHERE slug = ?', [row.slug])
    invalidateContent()
    res.json(gameRowToApi(saved))
  } catch (e) {
    next(e)
  }
})

/**
 * 局部更新（如切换上下架 { hidden: true }、绑定 ROM { rom: 'roms/nes/x.zip' }）（后台）
 *
 * 只写请求里带到的列。以前是把整行读出来合并再整行 upsert —— 想改一个 hidden，
 * 却会把 plays / rating / roms 全部按读到的旧值写回去，两个人同时操作后面那次会
 * 把前面那次的改动整行盖掉。
 */
gamesRouter.patch('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const { slug } = req.params
    const patch = gameApiToPartialRow(req.body)
    // slug 是主键，不接受通过 PATCH 改名（改名要用 PUT 建新的再删旧的）
    delete patch.slug
    if (!Object.keys(patch).length) return res.status(400).json({ error: '没有可更新的字段' })

    const sets = Object.keys(patch)
      .map((c) => `\`${c}\` = ?`)
      .join(', ')
    const result = await query(`UPDATE games SET ${sets} WHERE slug = ?`, [...Object.values(patch), slug])
    // affectedRows 为 0 说明这个 slug 根本不存在（值没变时 affectedRows 仍然是 1）
    if (!result.affectedRows) return res.status(404).json({ error: '游戏不存在' })

    const saved = await queryOne('SELECT * FROM games WHERE slug = ?', [slug])
    invalidateContent()
    res.json(gameRowToApi(saved))
  } catch (e) {
    next(e)
  }
})

/**
 * 删除游戏（后台）。
 *
 * favorites / recents 只对 users 做了外键，game_slug 没有约束 —— 直接删 games 会留下
 * 一堆指向已不存在游戏的孤儿行：前台渲染时被静默过滤掉看不出来，但会一直堆在库里，
 * 后台「收藏 / 最近浏览」的计数也会虚高。所以在同一个事务里一并清掉。
 *
 * 注意：R2 里的 ROM / 封面 / 视频文件不会被删除（避免误删多个游戏共用的素材）。
 * 需要清理请到「后台 → ROM 存储 → 列出文件」里手动删。
 */
gamesRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const { slug } = req.params
    const removed = await withTransaction(async (run) => {
      await run('DELETE FROM favorites WHERE game_slug = ?', [slug])
      await run('DELETE FROM recents WHERE game_slug = ?', [slug])
      const r = await run('DELETE FROM games WHERE slug = ?', [slug])
      return r.affectedRows
    })
    if (!removed) return res.status(404).json({ error: '游戏不存在' })
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
