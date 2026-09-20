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
  parseFlashSaveOptions,
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

/* ---------------- 写入代次：条件更新 + 幂等重放 ---------------- */
/*
  为什么需要这张表（而不是直接用存档行上的 revision）：
  删除是把行**删掉**的，版本号跟着没了；下一次写入又从 1 开始。于是「删掉再存」之后，
  一个基于旧版本（1）的迟到请求恰好又能通过 —— 这正是 ABA。版本号必须存在别处，
  且删除也要推进它。表结构见 schema-v2.sql 的 flash_save_seqs。
*/

/** 代次表里的槽键：AGI1 是 "0"~"2"，AGI2 是 "slot1"~"slot3" */
const seqKeyOf = (slot) => String(slot)

async function readSaveSeq(run, userId, gameSlug, saveKey) {
  const rows = await run(
    'SELECT revision, last_op_id FROM flash_save_seqs WHERE user_id = ? AND game_slug = ? AND save_key = ?',
    [userId, gameSlug, saveKey],
  )
  return { revision: Number(rows[0]?.revision || 0), lastOpId: rows[0]?.last_op_id ?? null }
}

/** 推进一格并记下这次的操作 ID，返回新版本号 */
async function bumpSaveSeq(run, userId, gameSlug, saveKey, opId) {
  await run(
    `INSERT INTO flash_save_seqs (user_id, game_slug, save_key, revision, last_op_id, updated_at)
       VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE revision = revision + 1, last_op_id = VALUES(last_op_id), updated_at = CURRENT_TIMESTAMP`,
    [userId, gameSlug, saveKey, opId],
  )
  const rows = await run(
    'SELECT revision FROM flash_save_seqs WHERE user_id = ? AND game_slug = ? AND save_key = ?',
    [userId, gameSlug, saveKey],
  )
  return Number(rows[0]?.revision || 1)
}

/**
 * 条件更新 + 幂等重放，两个方言共用。返回值：
 *
 *   { replay: true, revision }  —— 这个 opId 已经写过了（客户端超时重试），直接回当前版本，不再写
 *   { replay: false, revision } —— 放行；revision 是写入前的版本，写成功后是 revision + 1
 *
 * 抛出 HttpProblem(409, stale_write) —— 客户端基于的版本已经不是最新（迟到的旧请求）
 */
async function checkSaveWrite(run, { userId, gameSlug, saveKey, opId, expectedRevision }) {
  const seq = await readSaveSeq(run, userId, gameSlug, saveKey)
  if (opId && seq.lastOpId === opId) return { replay: true, revision: seq.revision }
  /*
    比的是「客户端以为的版本」和「当前版本」，不相等就拒。
    ⚠️ 这里不能用单调比较（`expectedRevision > 当前` 也放行）：客户端手上的版本比服务端新，
    只可能是它自己的另一次写入已经生效（重试场景），放行会写出顺序颠倒的档。
    没带 expectedRevision 的写入不做检查 —— 旧客户端照样能写，代价写在 docs 的 R01 一节。
  */
  if (expectedRevision !== null && expectedRevision !== seq.revision) {
    throw new HttpProblem(409, 'stale_write', '这次保存基于的版本已经过期，新存档不会被它覆盖')
  }
  return { replay: false, revision: seq.revision }
}

/**
 * 这个账号在这款游戏下各槽的当前代次，随读档一起下发。
 *
 * 客户端（桥）要靠它才能做条件更新：先读一次拿到 revision，之后每次写入带上来。
 * 空槽没有行 → 不出现（客户端按 0 处理）。AGI1 的键是 "0"~"2"，AGI2 是 "slot1"~"slot3"。
 *
 * ⚠️ 表不存在时**只降级、不报错**：老库还没迁移到 flash_save_seqs 时，读档本身不该失败，
 * 只是客户端拿不到代次、无法做条件更新（写入那边会因为缺少这张表而报错，迁移是必须的）。
 */
async function saveRevisions(userId, gameSlug) {
  let rows = []
  try {
    rows = await query(
      'SELECT save_key, revision FROM flash_save_seqs WHERE user_id = ? AND game_slug = ?',
      [userId, gameSlug],
    )
  } catch (error) {
    if (error?.code !== 'ER_NO_SUCH_TABLE') throw error
  }
  const revisions = Object.create(null)
  for (const row of rows) revisions[String(row.save_key)] = Number(row.revision || 0)
  return revisions
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
    /*
      每次请求都复核一次白名单 —— 签发时查过不算数。
      会话令牌有 8 小时有效期，这期间这款游戏完全可能被停用（比如发现兼容问题要紧急下线，
      或者账号所属的游戏被下架）；只在签发时查，旧令牌就能继续读写满 8 小时。
    */
    if (!flashSaveGameEnabled(gameSlug)) {
      return fail(res, 404, 'game_not_enabled', '这款游戏未启用 Flash 在线存档')
    }
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
        return res.json({
          success: true,
          keys: agi2SaveMap(row ? [row] : []),
          revisions: await saveRevisions(userId, gameSlug),
        })
      }
      const rows = await query(
        'SELECT save_key, value_json FROM flash_save_kv WHERE user_id = ? AND game_slug = ? ORDER BY save_key',
        [userId, gameSlug],
      )
      return res.json({ success: true, keys: agi2SaveMap(rows), revisions: await saveRevisions(userId, gameSlug) })
    }
    if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
      const key = flashSaveKey(rawKey)
      if (!key) return fail(res, 400, 'invalid_request', '存档键不合法')
      const row = await queryOne(
        `SELECT profile_json, data_json
           FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?`,
        [userId, gameSlug, key.slot],
      )
      if (!row || !row.profile_json || !row.data_json) {
        return res.json({ success: true, data: null, revisions: await saveRevisions(userId, gameSlug) })
      }
      const value = key.kind === 'profile' ? row.profile_json : row.data_json
      return res.json({
        success: true,
        data: typeof value === 'string' ? JSON.parse(value) : value,
        revisions: await saveRevisions(userId, gameSlug),
      })
    }
    const rows = await query(
      `SELECT slot, profile_json, data_json
         FROM flash_save_slots WHERE user_id = ? AND game_slug = ? ORDER BY slot`,
      [userId, gameSlug],
    )
    // revisions 是给桥用的（顶层字段，游戏侧不看）：它拿这些版本号做后续写入的条件更新
    res.json({ success: true, data: legacyFlashSaveMap(rows), revisions: await saveRevisions(userId, gameSlug) })
  } catch (error) {
    next(error)
  }
})

/**
 * AGI2 的写入：一次一个 key→value。事务边界、配额锁、写入代次和 AGI1 完全一致，只是落在另一张表上。
 * 这里没有「成对」问题 —— AGI2 的一份档本来就是一个完整对象，不存在半份。
 */
async function writeAgi2Slot(req, res, next) {
  const checked = validateAgi2Value(req.body || {})
  if (!checked.ok) return fail(res, checked.status, checked.code, checked.message)
  const options = parseFlashSaveOptions(req.body || {})
  if (!options.ok) return fail(res, options.status, options.code, options.message)
  try {
    const { userId, gameSlug, tokenVersion } = req.flashSaveSession
    const saved = await withTransaction(async (run) => {
      const users = await run('SELECT id, status, token_version FROM users WHERE id = ? FOR UPDATE', [userId])
      const user = users[0]
      if (!user || user.status === 'banned' || tokenVersionOf(user) !== tokenVersion) {
        throw new HttpProblem(401, 'invalid_session', '在线存档会话已失效')
      }
      const decision = await checkSaveWrite(run, {
        userId,
        gameSlug,
        saveKey: seqKeyOf(checked.key),
        opId: options.opId,
        expectedRevision: options.expectedRevision,
      })
      if (decision.replay) {
        const rows = await run(
          'SELECT revision, updated_at FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?',
          [userId, gameSlug, checked.key],
        )
        return {
          revision: Number(rows[0]?.revision ?? decision.revision),
          updatedAt: rows[0]?.updated_at || new Date(),
        }
      }
      const oldRows = await run(
        'SELECT size FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?',
        [userId, gameSlug, checked.key],
      )
      const totals = await flashSaveUsedBytes(run, userId)
      const quota = flashSaveQuotaError(totals, Number(oldRows[0]?.size || 0), checked.size)
      if (quota) throw new HttpProblem(quota.status, quota.code, quota.message)
      const revision = await bumpSaveSeq(run, userId, gameSlug, seqKeyOf(checked.key), options.opId)
      await run(
        `INSERT INTO flash_save_kv
           (user_id, game_slug, save_key, value_json, size, revision, created_at, updated_at)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           value_json = VALUES(value_json), size = VALUES(size),
           revision = VALUES(revision), updated_at = CURRENT_TIMESTAMP`,
        [userId, gameSlug, checked.key, checked.valueJson, checked.size, revision],
      )
      const rows = await run(
        'SELECT updated_at FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?',
        [userId, gameSlug, checked.key],
      )
      return { revision, updatedAt: rows[0]?.updated_at || new Date() }
    })
    res.json({
      success: true,
      data: { key: checked.key, revision: Number(saved.revision), updatedAt: new Date(saved.updatedAt).getTime() },
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
  const options = parseFlashSaveOptions(req.body || {})
  if (!options.ok) return fail(res, options.status, options.code, options.message)
  try {
    const { userId, gameSlug, tokenVersion } = req.flashSaveSession
    const saved = await withTransaction(async (run) => {
      // 锁 users 行把同一账号的并发写串起来，否则两个请求都可能在旧总量下通过配额。
      const users = await run('SELECT id, status, token_version FROM users WHERE id = ? FOR UPDATE', [userId])
      const user = users[0]
      if (!user || user.status === 'banned' || tokenVersionOf(user) !== tokenVersion) {
        throw new HttpProblem(401, 'invalid_session', '在线存档会话已失效')
      }
      const saveKey = seqKeyOf(checked.slot)
      const decision = await checkSaveWrite(run, {
        userId,
        gameSlug,
        saveKey,
        opId: options.opId,
        expectedRevision: options.expectedRevision,
      })
      if (decision.replay) {
        /*
          重试：同一份档已经写进去了。回**当前**版本号（不是当时那个），
          让客户端的本地版本对齐 —— 下次写入带着它才不会被条件更新拒掉。
          这里不碰配额也不写库：重放不能变成双写。
        */
        const rows = await run(
          'SELECT revision, updated_at FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?',
          [userId, gameSlug, checked.slot],
        )
        return { revision: Number(rows[0]?.revision ?? decision.revision), updatedAt: rows[0]?.updated_at || new Date() }
      }
      const oldRows = await run(
        'SELECT size FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?',
        [userId, gameSlug, checked.slot],
      )
      const totals = await flashSaveUsedBytes(run, userId)
      const quota = flashSaveQuotaError(totals, Number(oldRows[0]?.size || 0), checked.size)
      if (quota) throw new HttpProblem(quota.status, quota.code, quota.message)
      // 版本号来自代次表，而不是本行的 revision + 1 —— 删除会把行删掉，版本号必须活得比它久
      const revision = await bumpSaveSeq(run, userId, gameSlug, saveKey, options.opId)
      await run(
        `INSERT INTO flash_save_slots
           (user_id, game_slug, slot, profile_json, data_json, size, revision, created_at, updated_at)
         VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           profile_json = VALUES(profile_json), data_json = VALUES(data_json), size = VALUES(size),
           revision = VALUES(revision), updated_at = CURRENT_TIMESTAMP`,
        [userId, gameSlug, checked.slot, checked.profileJson, checked.dataJson, checked.size, revision],
      )
      const rows = await run(
        'SELECT updated_at FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?',
        [userId, gameSlug, checked.slot],
      )
      return { revision, updatedAt: rows[0]?.updated_at || new Date() }
    })
    res.json({
      success: true,
      data: {
        slot: checked.slot,
        revision: Number(saved.revision),
        updatedAt: new Date(saved.updatedAt).getTime(),
      },
    })
  } catch (error) {
    if (error instanceof HttpProblem) return problem(res, error)
    next(error)
  }
})

flashSavesRouter.post('/:gameSlug/delete-slot', requireFlashSession, async (req, res, next) => {
  try {
    const { userId, gameSlug, tokenVersion } = req.flashSaveSession
    const isAgi2 = flashSaveProtocol(gameSlug) === 'agi2'
    // AGI2 按 key 删、AGI1 按槽删。两代的删档都幂等：删不存在的槽也返回成功
    const target = isAgi2 ? agi2SaveKey(req.body?.key) : flashSaveSlot(req.body?.slot)
    if (isAgi2 ? !target : target === null) {
      return fail(res, 400, 'invalid_request', isAgi2 ? '存档键不合法' : '存档位只能是 0、1、2')
    }
    /*
      删除也进事务，并在锁住用户行之后**重新验一次会话**。
      中间件确实已经验过，但那是事务外的一次读：账号注销 / 被封 / 令牌被吊销（token_version 变了）
      完全可能就发生在那一步和这一步之间。删除不可逆，宁可多付一次行锁。
    */
    const revision = await withTransaction(async (run) => {
      const users = await run('SELECT id, status, token_version FROM users WHERE id = ? FOR UPDATE', [userId])
      const user = users[0]
      if (!user || user.status === 'banned' || tokenVersionOf(user) !== tokenVersion) {
        throw new HttpProblem(401, 'invalid_session', '在线存档会话已失效')
      }
      await run(
        isAgi2
          ? 'DELETE FROM flash_save_kv WHERE user_id = ? AND game_slug = ? AND save_key = ?'
          : 'DELETE FROM flash_save_slots WHERE user_id = ? AND game_slug = ? AND slot = ?',
        [userId, gameSlug, target],
      )
      /*
        删档也要推进代次（opId 传 null = 顺手清掉重放标记）。
        不推进的话：删掉 → 再存（版本号又从 1 开始）→ 一个基于旧版本 1 的迟到请求
        恰好又能通过条件更新，把新档盖掉。这就是 ABA —— 代次必须活得比存档行长。
      */
      return bumpSaveSeq(run, userId, gameSlug, seqKeyOf(target), null)
    })
    /*
      回传删除后的版本号：客户端（桥）本地还记着删除**之前**的版本，
      不告诉它的话，删档之后的下一次正常保存会带着过期版本撞条件更新，
      白白丢掉一次保存（游戏是忽略错误的，玩家只会觉得「刚才那关没存上」）。
      AGI1 的游戏会为 profile/data 连调两次、落到同一槽：删不存在的行也成功才符合旧 API 语义。
    */
    res.json({ success: true, data: { revision: Number(revision) } })
  } catch (error) {
    if (error instanceof HttpProblem) return problem(res, error)
    next(error)
  }
})
