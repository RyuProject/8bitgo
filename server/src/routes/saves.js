/**
 * 云存档。
 *
 * 存档**跟着账号走**：必须登录才有云存档，换台电脑、换个浏览器都还在。
 * 没登录的用户不走这里 —— 前端会把存档落在浏览器里（IndexedDB）或者让他下载成文件，
 * 见 src/services/saves.ts。
 *
 * 两种引擎的存档不是一回事，所以用 runtime 区分、互不覆盖：
 *   emulatorjs  内存快照（整台机器某一帧的状态），NES 约 20KB、GBA 几十 KB
 *   jsdos       DOS 文件系统的**变更包**（盘上被改过的文件），几 KB 到几百 KB
 *
 * 存档是二进制的，所以这里用 express.raw 收，不走全局的 express.json。
 */
import { Router } from 'express'
import express from 'express'
import { query, queryOne } from '../db.js'
import { requireUser } from '../auth.js'

/** 单份存档上限。GBA 快照几十 KB、DOS 变更包几百 KB，4MB 已经很宽裕 */
export const MAX_SAVE_BYTES = Number(process.env.SAVE_MAX_BYTES || 4 * 1024 * 1024)
/** 每人最多存多少份，防止有人拿它当网盘 */
const MAX_SAVES_PER_USER = Number(process.env.SAVE_MAX_PER_USER || 200)
/**
 * 每人总共能占多少字节。
 *
 * ⚠️ 只数份数是拦不住「拿它当网盘」的：200 份 × 单份 4MB = **一个账号 800MB**，
 * 而账号是邮箱验证码免费注册的。正常存档 20KB～500KB，把每份都撑到 4MB
 * 只有一个目的。份数管的是「别开太多格」，字节数才管得住体积。
 */
const MAX_TOTAL_BYTES = Number(process.env.SAVE_MAX_TOTAL_BYTES || 64 * 1024 * 1024)
/** 每个游戏的存档位。0 是「自动 / 主存档」，DOS 只用 0 */
const MAX_SLOT = 9

/** 只认已知的引擎名，别让人往库里塞任意字符串 */
const RUNTIMES = new Set(['emulatorjs', 'jsdos', 'cloudgame', 'jsnes', 'ruffle', 'webretro', 'j2me'])

/**
 * 存档的 key 是 slug；本地文件没有 slug，前端会给个 `local:文件名` 的形式 ——
 * 而文件名完全可能是中文、日文的（`local:超级马里奥.zip`），
 * 所以这里不能限定 ASCII，只挡真正会出问题的字符：
 * 斜杠（会把路由打断）、反斜杠、空白和控制字符。
 */
const SLUG_RE = /^[^/\\\s\u0000-\u001f]{1,160}$/u

/**
 * 这一次写入放不放行。纯函数，好测（`npm run test:save-quota`）。
 *
 * @param used   {count, bytes} 这个用户当前占用的份数和总字节
 * @param oldSize 要覆盖的那一格原来多大；新开一格传 0
 * @param newSize 这次要写多少字节
 * @returns null = 放行；否则 {status, error}
 *
 * 两条规则：
 *  · 新开一格才查份数 —— 覆盖已有存档不该因为份数满了而失败；
 *  · 体积**只在变大时**才查。玩家玩到一半突然存不上，比拒绝新建难受得多，
 *    所以「存得比原来小或一样大」永远放行 —— 那不会让占用继续涨，
 *    人也不至于被卡在一局里出不来。
 */
export function saveQuotaError(used, oldSize, newSize) {
  const isNew = oldSize === 0
  if (isNew && used.count >= MAX_SAVES_PER_USER) {
    return { status: 409, error: `云存档最多 ${MAX_SAVES_PER_USER} 份，请先删掉一些` }
  }
  if (newSize <= oldSize) return null
  const after = used.bytes - oldSize + newSize
  if (after > MAX_TOTAL_BYTES) {
    const mb = Math.round(MAX_TOTAL_BYTES / 1024 / 1024)
    return { status: 409, error: `云存档总共最多 ${mb}MB，请先删掉一些` }
  }
  return null
}

export const savesRouter = Router()

// 云存档必须登录 —— 这就是它和「浏览器里的存档」最本质的区别
savesRouter.use(requireUser)

/** 把路径参数校验成一份存档的坐标；不合法就直接回错 */
function coords(req, res) {
  const runtime = String(req.params.runtime || '')
  // ⚠️ 这里**不要**再 decodeURIComponent：Express 取路由参数时已经解过一次了。
  // 再解一次的话，名字里带 % 的文件（`local:100%.zip`）会被解坏甚至抛错。
  // 编码本身就坏掉的路径（%zz）Express 会自己按 400 挡掉，轮不到我们。
  const slug = String(req.params.slug || '')
  const slot = Number(req.query.slot ?? 0)
  if (!RUNTIMES.has(runtime)) {
    res.status(400).json({ error: '未知的引擎' })
    return null
  }
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: '游戏标识不合法' })
    return null
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
    res.status(400).json({ error: '存档位不合法' })
    return null
  }
  return { runtime, slug, slot }
}

/** 我的存档清单（只给元信息，不带存档内容 —— 列表页不需要几百 KB 的二进制） */
savesRouter.get('/', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT runtime, game_slug, slot, size, created_at, updated_at
         FROM saves WHERE user_id = ? ORDER BY updated_at DESC`,
      [req.user.id],
    )
    res.json(
      rows.map((r) => ({
        runtime: r.runtime,
        gameSlug: r.game_slug,
        slot: r.slot,
        size: r.size,
        createdAt: new Date(r.created_at).getTime(),
        updatedAt: new Date(r.updated_at).getTime(),
      })),
    )
  } catch (e) {
    next(e)
  }
})

/**
 * 单份存档的元信息。
 * 界面上要显示「云端有存档，3 分钟前」，为这个去下载整份二进制太浪费。
 */
savesRouter.get('/:runtime/:slug/meta', async (req, res, next) => {
  try {
    const c = coords(req, res)
    if (!c) return
    const row = await queryOne(
      'SELECT size, created_at, updated_at FROM saves WHERE user_id = ? AND runtime = ? AND game_slug = ? AND slot = ?',
      [req.user.id, c.runtime, c.slug, c.slot],
    )
    if (!row) return res.status(404).json({ error: '没有存档' })
    res.json({
      size: row.size,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    })
  } catch (e) {
    next(e)
  }
})

/** 取存档（二进制） */
savesRouter.get('/:runtime/:slug', async (req, res, next) => {
  try {
    const c = coords(req, res)
    if (!c) return
    const row = await queryOne(
      'SELECT data, updated_at FROM saves WHERE user_id = ? AND runtime = ? AND game_slug = ? AND slot = ?',
      [req.user.id, c.runtime, c.slug, c.slot],
    )
    if (!row) return res.status(404).json({ error: '没有存档' })
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('x-save-updated-at', String(new Date(row.updated_at).getTime()))
    res.send(row.data)
  } catch (e) {
    next(e)
  }
})

/** 存档（二进制，覆盖同一格） */
/**
 * 收二进制的存档体。
 *
 * express.raw 超限时抛的是 PayloadTooLargeError，直接交给全局错误处理器会变成 500 ——
 * 玩家看到「服务器错误」，完全不知道是自己的存档太大。这里翻译成 413 和一句人话。
 */
const rawSaveBody = express.raw({ type: () => true, limit: MAX_SAVE_BYTES })
function readSaveBody(req, res, next) {
  rawSaveBody(req, res, (err) => {
    if (!err) return next()
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: '存档太大' })
    }
    next(err)
  })
}

savesRouter.put(
  '/:runtime/:slug',
  readSaveBody,
  async (req, res, next) => {
    try {
      const c = coords(req, res)
      if (!c) return
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: '存档是空的' })
      }
      if (req.body.length > MAX_SAVE_BYTES) {
        return res.status(413).json({ error: '存档太大' })
      }

      // 份数 + 总字节一起查，判定交给 saveQuotaError（纯函数，规则写在它头上）
      const existing = await queryOne(
        'SELECT size FROM saves WHERE user_id = ? AND runtime = ? AND game_slug = ? AND slot = ?',
        [req.user.id, c.runtime, c.slug, c.slot],
      )
      const used = await queryOne(
        'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM saves WHERE user_id = ?',
        [req.user.id],
      )
      const denied = saveQuotaError(
        { count: Number(used?.n ?? 0), bytes: Number(used?.bytes ?? 0) },
        Number(existing?.size ?? 0),
        req.body.length,
      )
      if (denied) return res.status(denied.status).json({ error: denied.error })

      /**
       * ⚠️ updated_at 必须显式写，不能指望列上的 ON UPDATE CURRENT_TIMESTAMP。
       *
       * MySQL 在「所有列的新值和旧值都一样」时不会真的更新这一行，
       * ON UPDATE CURRENT_TIMESTAMP 也就不触发。玩家在同一帧反复存档
       * （或者 DOS 的变更包一个字节没变），时间戳就永远停在第一次那一下，
       * 界面上的「最后存档时间」跟着一起卡住。
       */
      await query(
        `INSERT INTO saves (user_id, runtime, game_slug, slot, size, data)
              VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE size = VALUES(size), data = VALUES(data),
                                 updated_at = CURRENT_TIMESTAMP`,
        [req.user.id, c.runtime, c.slug, c.slot, req.body.length, req.body],
      )
      res.json({ ok: true, size: req.body.length, updatedAt: Date.now() })
    } catch (e) {
      next(e)
    }
  },
)

/** 删存档 */
savesRouter.delete('/:runtime/:slug', async (req, res, next) => {
  try {
    const c = coords(req, res)
    if (!c) return
    await query('DELETE FROM saves WHERE user_id = ? AND runtime = ? AND game_slug = ? AND slot = ?', [
      req.user.id,
      c.runtime,
      c.slug,
      c.slot,
    ])
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
