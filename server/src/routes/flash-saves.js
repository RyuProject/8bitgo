import { Router } from 'express'
import { query, queryOne, withTransaction } from '../db.js'
import { requireUser, tokenVersionOf } from '../auth.js'
import { take } from '../rateLimit.js'
import {
  agi2SaveKey,
  agi2SaveMap,
  flashGameSlugOk,
  flashSaveBridgeUrl,
  flashSaveGameEnabled,
  flashSaveKey,
  flashSaveProtocol,
  flashSaveQuotaError,
  flashSaveSlot,
  legacyFlashSaveMap,
  validateAgi2Value,
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

/**
 * 账号的 Flash 在线存档总量 = 两张表之和。
 * AGI1（成对槽）和 AGI2（key→value）分表存放，但配额是**按账号算的** ——
 * 只统计其中一张，另一张就成了绕过配额的后门。
 *
 * ⚠️ 两张表**分开查**，不写成一条带两个子查询的 SQL：老库没跑到建 `flash_save_kv`
 * 那一步时，一条 SQL 会因为缺表整个报错，把本来好好的 AGI1 也一起打死（每次保存 500）。
 * 分开查时缺表只当 0，AGI1 照常工作 —— 和 codes.js / routes/me.js 处理「老库没 migrate」
 * 是同一套做法。
 */
async function flashSaveUsedBytes(run, userId) {
  const rows = await run('SELECT COALESCE(SUM(size), 0) AS bytes FROM flash_save_slots WHERE user_id = ?', [userId])
  let bytes = Number(rows[0]?.bytes || 0)
  try {
    const kv = await run('SELECT COALESCE(SUM(size), 0) AS bytes FROM flash_save_kv WHERE user_id = ?', [userId])
    bytes += Number(kv[0]?.bytes || 0)
  } catch (error) {
    if (error?.code !== 'ER_NO_SUCH_TABLE') throw error
  }
  return bytes
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
    /*
      600/小时。原来 120 太紧：重开局、切布局、换语言都会重新挂载播放器，各自申请一次会话，
      打满之后整小时只能退游客态 —— 玩家看到的是「在线槽突然不能用了」，而且没有任何提示。
      前端现在还会按登录令牌复用未过期的会话，这里放宽是给「换设备 / 换标签」这类真需要
      重新申请的路径留余量。签发会话很便宜（只查一次 games 再签个 JWT），放宽的风险很小。
    */
    const gate = take(`flash-save:session:${req.user.id}`, 600, 60 * 60 * 1000)
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
        // 方言由游戏决定（见 flash-save-contract.js 的 GAME_PROTOCOLS）：桥地址和响应形状必须配套
        protocol: flashSaveProtocol(gameSlug),
        bridgeUrl: flashSaveBridgeUrl(gameSlug),
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
    /**
     * AGI2 的读：一次取回全部槽时给 keys 对象；指定 key 时也给 keys 对象，只是里面只有一个。
     * ⚠️ 形状和下面 AGI1 的 `data` 不一样，是两套桥各自约定的 —— 所以这里先按方言分流，
     * 不要试图把两种形状揉进同一个字段。
     */
    if (flashSaveProtocol(gameSlug) === 'agi2') {
      if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
        const key = agi2SaveKey(rawKey)
        if (!key) return fail(res, 400, 'invalid_request', '存档键不合法')
        const row = await queryOne(
          'SELECT save_key, value_json FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?',
          [userId, gameSlug, key],
        )
        // agi2SaveMap 会把不认识的键和不完整的行滤掉：槽不存在时自然就是空对象
        return res.json({ success: true, keys: agi2SaveMap(row ? [row] : []) })
      }
      const rows = await query(
        'SELECT save_key, value_json FROM flash_save_kv WHERE user_id = ? AND game_slug = ? ORDER BY save_key',
        [userId, gameSlug],
      )
      return res.json({ success: true, keys: agi2SaveMap(rows) })
    }
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

/**
 * AGI2 的写入：一次一个 key→value。事务边界、配额锁和 AGI1 完全一致，只是落在另一张表上。
 * 这里没有「成对」问题 —— AGI2 的一份档本来就是一个完整对象，不存在半份。
 */
async function writeAgi2Slot(req, res, next) {
  const checked = validateAgi2Value(req.body || {})
  if (!checked.ok) return fail(res, checked.status, checked.code, checked.message)
  try {
    const { userId, gameSlug, tokenVersion } = req.flashSaveSession
    const saved = await withTransaction(async (run) => {
      const users = await run('SELECT id, status, token_version FROM users WHERE id = ? FOR UPDATE', [userId])
      const user = users[0]
      if (!user || user.status === 'banned' || tokenVersionOf(user) !== tokenVersion) {
        throw new HttpProblem(401, 'invalid_session', '在线存档会话已失效')
      }
      const oldRows = await run(
        'SELECT size FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?',
        [userId, gameSlug, checked.key],
      )
      const totals = await flashSaveUsedBytes(run, userId)
      const quota = flashSaveQuotaError(totals, Number(oldRows[0]?.size || 0), checked.size)
      if (quota) throw new HttpProblem(quota.status, quota.code, quota.message)
      await run(
        `INSERT INTO flash_save_kv
           (user_id, game_slug, save_key, value_json, size, revision, created_at, updated_at)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           value_json = VALUES(value_json), size = VALUES(size),
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP`,
        [userId, gameSlug, checked.key, checked.valueJson, checked.size],
      )
      const rows = await run(
        'SELECT revision, updated_at FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?',
        [userId, gameSlug, checked.key],
      )
      return rows[0]
    })
    res.json({
      success: true,
      data: { key: checked.key, revision: Number(saved.revision), updatedAt: new Date(saved.updated_at).getTime() },
    })
  } catch (error) {
    if (error instanceof HttpProblem) return problem(res, error)
    next(error)
  }
}

flashSavesRouter.post('/:gameSlug/write-slot', requireFlashSession, async (req, res, next) => {
  if (flashSaveProtocol(req.flashSaveSession.gameSlug) === 'agi2') return writeAgi2Slot(req, res, next)
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
      const totals = await flashSaveUsedBytes(run, userId)
      const quota = flashSaveQuotaError(totals, Number(oldRows[0]?.size || 0), checked.size)
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
    const { userId, gameSlug } = req.flashSaveSession
    // AGI2 的删档按 key 走，且同样幂等：删一个不存在的槽也返回成功
    if (flashSaveProtocol(gameSlug) === 'agi2') {
      const key = agi2SaveKey(req.body?.key)
      if (!key) return fail(res, 400, 'invalid_request', '存档键不合法')
      await query('DELETE FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?', [userId, gameSlug, key])
      return res.json({ success: true })
    }
    const slot = flashSaveSlot(req.body?.slot)
    if (slot === null) return fail(res, 400, 'invalid_request', '存档位只能是 0、1、2')
    await query('DELETE FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?', [userId, gameSlug, slot])
    // 两次 deleteUserData 会落到同一槽；删除不存在的行也成功才能保持旧 API 语义。
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})
