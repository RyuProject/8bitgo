import { Router } from 'express'
import { query, queryOne, withTransaction } from '../db.js'
import { requireUser, tokenVersionOf } from '../auth.js'
import { take } from '../rateLimit.js'
import {
  flashGameSlugOk,
  flashSaveGameEnabled,
  flashSaveKey,
  flashSaveQuotaError,
  flashSaveSlot,
  legacyFlashSaveMap,
  validateFlashSavePair,
} from '../flash-save-contract.js'
import { flashSaveConfigured, signFlashSaveToken, verifyFlashSaveToken } from '../flash-save-token.js'

export const flashSavesRouter = Router()

class HttpProblem extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } })
}

function problem(res, error) {
  return fail(res, error.status || 500, error.code || 'internal_error', error.message || '在线存档失败')
}

flashSavesRouter.use((_req, res, next) => {
  // 会话令牌和存档内容都不该被浏览器、反代或 Cloudflare 缓存。
  res.setHeader('Cache-Control', 'no-store')
  next()
})

/**
 * React 页面拿完整登录 JWT 换短期、逐游戏的 Flash 存档令牌。查询 games.platform 是这道
 * 边界的一部分：不能让任意 slug 都变成可写命名空间，否则一个账号可以制造无限游戏键。
 */
flashSavesRouter.post('/session', requireUser, async (req, res, next) => {
  try {
    if (!flashSaveConfigured()) return fail(res, 503, 'not_configured', '服务端未配置 Flash 在线存档')
    const gameSlug = String(req.body?.gameSlug || '')
    if (!flashGameSlugOk(gameSlug)) return fail(res, 400, 'invalid_request', '游戏标识不合法')
    if (!flashSaveGameEnabled(gameSlug)) {
      return fail(res, 404, 'game_not_enabled', '这款游戏未启用 Flash 在线存档')
    }
    const game = await queryOne('SELECT slug, platform FROM games WHERE slug = ? LIMIT 1', [gameSlug])
    if (!game || game.platform !== 'flash') {
      return fail(res, 404, 'game_not_enabled', '这款游戏未启用 Flash 在线存档')
    }
    const gate = take(`flash-save:session:${req.user.id}`, 120, 60 * 60 * 1000)
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter))
      return fail(res, 429, 'rate_limited', '在线存档会话申请过于频繁')
    }
    const signed = signFlashSaveToken({
      userId: req.user.id,
      gameSlug,
      tokenVersion: tokenVersionOf(req.user),
    })
    const endpoint = `/api/flash-saves/v1/${encodeURIComponent(gameSlug)}`
    res.json({
      success: true,
      data: {
        sessionToken: signed.token,
        expiresAt: signed.expiresAt,
        endpoint,
        bridgeUrl: '/flash-api/armor-games/AGI.swf',
        username: String(req.user.nickname || 'Player'),
        // users.avatar 是 emoji，Flash Loader 不能把它当图片；先用站内同源 PNG 保证加载完成。
        avatar_url: '/ui/logo-mark.png',
      },
    })
  } catch (error) {
    next(error)
  }
})

/** 旧 SWF 请求不带 Authorization；身份只来自 JSON 里的短期会话令牌。 */
async function requireFlashSession(req, res, next) {
  try {
    if (!flashSaveConfigured()) return fail(res, 503, 'not_configured', '服务端未配置 Flash 在线存档')
    const gameSlug = String(req.params.gameSlug || '')
    if (!flashGameSlugOk(gameSlug)) return fail(res, 400, 'invalid_request', '游戏标识不合法')
    const session = verifyFlashSaveToken(req.body?.sessionToken)
    if (!session) return fail(res, 401, 'invalid_session', '在线存档会话已失效')
    if (session.gameSlug !== gameSlug) return fail(res, 403, 'game_mismatch', '会话不能访问这款游戏')
    const user = await queryOne('SELECT id, status, token_version FROM users WHERE id = ? LIMIT 1', [session.userId])
    if (!user || user.status === 'banned' || tokenVersionOf(user) !== session.tokenVersion) {
      return fail(res, 401, 'invalid_session', '在线存档会话已失效')
    }
    const gate = take(`flash-save:data:${session.userId}`, 600, 60 * 1000)
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter))
      return fail(res, 429, 'rate_limited', '在线存档请求过于频繁')
    }
    req.flashSaveSession = session
    next()
  } catch (error) {
    next(error)
  }
}

flashSavesRouter.post('/:gameSlug/read', requireFlashSession, async (req, res, next) => {
  try {
    const { userId, gameSlug } = req.flashSaveSession
    const rawKey = req.body?.key
    if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
      const key = flashSaveKey(rawKey)
      if (!key) return fail(res, 400, 'invalid_request', '存档键不合法')
      const row = await queryOne(
        `SELECT profile_json, data_json
           FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?`,
        [userId, gameSlug, key.slot],
      )
      if (!row || !row.profile_json || !row.data_json) return res.json({ success: true, data: null })
      const value = key.kind === 'profile' ? row.profile_json : row.data_json
      return res.json({ success: true, data: typeof value === 'string' ? JSON.parse(value) : value })
    }
    const rows = await query(
      `SELECT slot, profile_json, data_json
         FROM flash_save_slots WHERE user_id = ? AND game_slug = ? ORDER BY slot`,
      [userId, gameSlug],
    )
    res.json({ success: true, data: legacyFlashSaveMap(rows) })
  } catch (error) {
    next(error)
  }
})

flashSavesRouter.post('/:gameSlug/write-slot', requireFlashSession, async (req, res, next) => {
  const checked = validateFlashSavePair(req.body || {})
  if (!checked.ok) return fail(res, checked.status, checked.code, checked.message)
  try {
    const { userId, gameSlug, tokenVersion } = req.flashSaveSession
    const saved = await withTransaction(async (run) => {
      // 锁 users 行把同一账号的并发写串起来，否则两个请求都可能在旧总量下通过配额。
      const users = await run('SELECT id, status, token_version FROM users WHERE id = ? FOR UPDATE', [userId])
      const user = users[0]
      if (!user || user.status === 'banned' || tokenVersionOf(user) !== tokenVersion) {
        throw new HttpProblem(401, 'invalid_session', '在线存档会话已失效')
      }
      const oldRows = await run(
        'SELECT size FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?',
        [userId, gameSlug, checked.slot],
      )
      const totals = await run('SELECT COALESCE(SUM(size), 0) AS bytes FROM flash_save_slots WHERE user_id = ?', [userId])
      const quota = flashSaveQuotaError(Number(totals[0]?.bytes || 0), Number(oldRows[0]?.size || 0), checked.size)
      if (quota) throw new HttpProblem(quota.status, quota.code, quota.message)
      await run(
        `INSERT INTO flash_save_slots
           (user_id, game_slug, slot, profile_json, data_json, size, revision, created_at, updated_at)
         VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           profile_json = VALUES(profile_json), data_json = VALUES(data_json), size = VALUES(size),
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP`,
        [userId, gameSlug, checked.slot, checked.profileJson, checked.dataJson, checked.size],
      )
      const rows = await run(
        'SELECT revision, updated_at FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?',
        [userId, gameSlug, checked.slot],
      )
      return rows[0]
    })
    res.json({
      success: true,
      data: {
        slot: checked.slot,
        revision: Number(saved.revision),
        updatedAt: new Date(saved.updated_at).getTime(),
      },
    })
  } catch (error) {
    if (error instanceof HttpProblem) return problem(res, error)
    next(error)
  }
})

flashSavesRouter.post('/:gameSlug/delete-slot', requireFlashSession, async (req, res, next) => {
  try {
    const slot = flashSaveSlot(req.body?.slot)
    if (slot === null) return fail(res, 400, 'invalid_request', '存档位只能是 0、1、2')
    const { userId, gameSlug } = req.flashSaveSession
    await query('DELETE FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?', [userId, gameSlug, slot])
    // 两次 deleteUserData 会落到同一槽；删除不存在的行也成功才能保持旧 API 语义。
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})
