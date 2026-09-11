/**
 * 开放平台应用的读写。**判断一律在 review.js**（那份是纯函数、能测），这里只管：
 * 取行、落库、留痕、以及「对外该露哪些字段」。
 *
 * ## 两种视角，字段面不一样
 *
 *   appForOwner(app)   申请人自己看：包括 review_note / review_reason / requested_scopes
 *   appForReviewer(app) 审核人看：再加上 owner 的昵称邮箱、提交时间、流水
 *
 * ⚠️ 两个都**不含 secret**。secret 只在创建和轮换那一刻返回一次，库里只有 bcrypt 哈希 ——
 * 「再给我看一眼 key」这个需求必须用轮换来满足，不能用查询。
 */
import { randomBytes } from 'node:crypto'
import { query, queryOne } from '../db.js'
import { hashSecret, newAppId, newAppSecret, secretHint } from './apps.js'
import { limitsFor, parseUriList, SANDBOX_LIMITS } from './review.js'
import { parseScopes } from './scopes.js'

const APP_COLS = `id, owner_id, name, description, homepage, logo, privacy_url, client_type,
  redirect_uris, embed_origins, approved_scopes, requested_scopes, status, review_state,
  review_note, review_reason, rate_tier, submitted_at, reviewed_by, reviewed_at, suspended_from,
  created_at, updated_at`

export async function getApp(id) {
  return queryOne(`SELECT ${APP_COLS} FROM oauth_apps WHERE id = ?`, [String(id)])
}

/**
 * 审核视角取一行：**必须 join users**。
 *
 * 直接用 getApp 的话，`appForReviewer` 拿不到 owner 的昵称和邮箱，
 * 审核详情页上「申请人是谁」那一栏是空的 —— 而那正是审核最要看的一条。
 * 症状很轻（只是空白），所以没测试的话会一直没人发现（实测就是测试抓出来的）。
 */
export async function getAppForReview(id) {
  return queryOne(
    `SELECT ${APP_COLS.replace(/(^|,)\s*/g, '$1a.')}, u.nickname AS owner_nickname, u.email AS owner_email
       FROM oauth_apps a LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = ?`,
    [String(id)],
  )
}

export async function listAppsOfOwner(ownerId) {
  return query(`SELECT ${APP_COLS} FROM oauth_apps WHERE owner_id = ? ORDER BY created_at DESC`, [String(ownerId)])
}

/**
 * 审核队列。默认只看 pending，按**提交时间正序** —— 先交的先审，
 * 倒序会让一个早上交的申请永远压在下面。
 */
export async function listForReview({ state = 'pending', status = '', limit = 50 } = {}) {
  const where = []
  const params = []
  if (state) {
    where.push('a.review_state = ?')
    params.push(state)
  }
  if (status) {
    where.push('a.status = ?')
    params.push(status)
  }
  const sql = `SELECT ${APP_COLS.replace(/(^|,)\s*/g, '$1a.')},
      u.nickname AS owner_nickname, u.email AS owner_email
    FROM oauth_apps a LEFT JOIN users u ON u.id = a.owner_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.submitted_at IS NULL, a.submitted_at ASC, a.created_at ASC
    LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`
  return query(sql, params)
}

/** 一个人手里最多几个应用。挡的是「批量建号刷 key」，不是节约资源 */
export const MAX_APPS_PER_OWNER = 10

export async function countAppsOfOwner(ownerId) {
  const r = await queryOne('SELECT COUNT(*) AS n FROM oauth_apps WHERE owner_id = ?', [String(ownerId)])
  return Number(r?.n ?? 0)
}

/**
 * 建应用。**当场发第一把 key 并返回明文**（这是唯一一次能看到它的机会）。
 *
 * 公开客户端（纯前端 / 移动端）**不发 secret**：前端藏不住密钥，发了只会制造
 * 假的安全感。它靠 PKCE + 精确回调地址。
 */
export async function createApp(ownerId, input, granted) {
  const id = newAppId()
  const isPublic = input.clientType === 'public'
  await query(
    `INSERT INTO oauth_apps
      (id, owner_id, name, description, homepage, privacy_url, client_type,
       redirect_uris, embed_origins, approved_scopes, requested_scopes, status, review_state, rate_tier, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'sandbox','none','sandbox',NOW())`,
    [
      id,
      String(ownerId),
      input.name,
      input.description ?? '',
      input.homepage ?? '',
      input.privacyUrl ?? '',
      isPublic ? 'public' : 'confidential',
      JSON.stringify(input.redirectUris ?? []),
      JSON.stringify(input.embedOrigins ?? []),
      granted.join(' '),
      (input.requestedScopes ?? []).join(' '),
    ],
  )
  const secret = isPublic ? '' : await issueSecret(id)
  return { id, secret }
}

/**
 * 发一把新 key，返回明文。
 *
 * **最多两把并存**（轮换期：新建一把 → 两边都能用 → 换完撤销旧的）。
 * 已经有两把还要发第三把时报错，而不是默默把最旧的那把撤掉 ——
 * 那会在接入方毫无察觉的情况下让他的线上服务挂掉。
 */
export async function issueSecret(appId) {
  const alive = await query(
    'SELECT id FROM oauth_app_secrets WHERE app_id = ? AND revoked_at IS NULL',
    [String(appId)],
  )
  if (alive.length >= 2) {
    const err = new Error('最多同时有两把有效密钥，先撤销一把再新建')
    err.code = 'too_many_secrets'
    throw err
  }
  const secret = newAppSecret()
  await query(
    'INSERT INTO oauth_app_secrets (id, app_id, secret_hash, hint, created_at) VALUES (?,?,?,?,NOW())',
    [`sec_${randomBytes(8).toString('hex')}`, String(appId), await hashSecret(secret), secretHint(secret)],
  )
  return secret
}

/** 列出这个应用的密钥（只有提示位和时间，**没有明文也没有哈希**） */
export async function listSecrets(appId) {
  const rows = await query(
    `SELECT id, hint, created_at, expires_at, revoked_at, last_used_at
       FROM oauth_app_secrets WHERE app_id = ? ORDER BY created_at DESC`,
    [String(appId)],
  )
  return rows.map((r) => ({
    id: r.id,
    hint: r.hint,
    createdAt: iso(r.created_at),
    revokedAt: iso(r.revoked_at),
    lastUsedAt: iso(r.last_used_at),
    active: !r.revoked_at,
  }))
}

/**
 * 撤销一把。**不许撤销最后一把有效的**（机密客户端）——
 * 那会让这个应用彻底没法换令牌，而界面上看不出为什么。要停用整个应用请走「停用」。
 */
export async function revokeSecret(appId, secretId, { clientType } = {}) {
  const alive = await query(
    'SELECT id FROM oauth_app_secrets WHERE app_id = ? AND revoked_at IS NULL',
    [String(appId)],
  )
  if (clientType !== 'public' && alive.length <= 1 && alive.some((r) => r.id === secretId)) {
    const err = new Error('这是最后一把有效密钥，撤销之后应用将无法取令牌。请先新建一把')
    err.code = 'last_secret'
    throw err
  }
  const r = await query(
    'UPDATE oauth_app_secrets SET revoked_at = NOW() WHERE app_id = ? AND id = ? AND revoked_at IS NULL',
    [String(appId), String(secretId)],
  )
  return Number(r?.affectedRows ?? 0) > 0
}

/** 按 review.js 给出的 patch 落库。列名白名单，别让调用方往里塞任意字段 */
const PATCHABLE = new Set([
  'name', 'description', 'homepage', 'logo', 'privacy_url', 'client_type',
  'redirect_uris', 'embed_origins', 'approved_scopes', 'requested_scopes',
  'status', 'review_state', 'review_note', 'review_reason', 'rate_tier',
  'submitted_at', 'reviewed_by', 'reviewed_at', 'suspended_from',
])

export async function patchApp(appId, patch) {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k))
  if (!keys.length) return false
  const sets = keys.map((k) => `\`${k}\` = ?`).join(', ')
  const r = await query(`UPDATE oauth_apps SET ${sets} WHERE id = ?`, [...keys.map((k) => patch[k]), String(appId)])
  return Number(r?.affectedRows ?? 0) > 0
}

/** 记一条审核流水。**和状态变更同一个请求里写**，漏了就查不出「当初凭什么发的」 */
export async function logReview(appId, actorId, action, detail) {
  await query(
    'INSERT INTO oauth_app_reviews (app_id, actor_id, action, detail, created_at) VALUES (?,?,?,?,NOW())',
    [String(appId), String(actorId), String(action), detail == null ? null : String(detail).slice(0, 4000)],
  )
}

export async function listReviews(appId) {
  const rows = await query(
    `SELECT r.id, r.action, r.detail, r.created_at, r.actor_id, u.nickname AS actor_nickname
       FROM oauth_app_reviews r LEFT JOIN users u ON u.id = r.actor_id
      WHERE r.app_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 100`,
    [String(appId)],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    detail: r.detail || '',
    at: iso(r.created_at),
    actor: r.actor_nickname || r.actor_id,
  }))
}

/* ---------------- 沙箱测试账号白名单 ---------------- */

export async function listTesters(appId) {
  const rows = await query(
    `SELECT t.user_id, t.added_at, u.nickname, u.email
       FROM oauth_app_testers t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.app_id = ? ORDER BY t.added_at ASC`,
    [String(appId)],
  )
  return rows.map((r) => ({ id: r.user_id, nickname: r.nickname || '', email: maskEmail(r.email), addedAt: iso(r.added_at) }))
}

/**
 * 加一个测试账号（按邮箱找人）。
 *
 * ⚠️ 复用 `/api/im/lookup` 那条铁律：**查不到和被封禁回同一个结果**，
 * 否则这里就顺带变成了「某个邮箱有没有注册 / 是不是被封了」的探针。
 */
export async function addTester(appId, email) {
  const row = await queryOne('SELECT id, status FROM users WHERE email = ?', [String(email).trim().toLowerCase()])
  if (!row || row.status !== 'active') return { ok: false, code: 'not_found' }
  const count = await queryOne('SELECT COUNT(*) AS n FROM oauth_app_testers WHERE app_id = ?', [String(appId)])
  if (Number(count?.n ?? 0) >= SANDBOX_LIMITS.testers) return { ok: false, code: 'too_many' }
  await query(
    'INSERT IGNORE INTO oauth_app_testers (app_id, user_id, added_at) VALUES (?,?,NOW())',
    [String(appId), String(row.id)],
  )
  return { ok: true, userId: String(row.id) }
}

export async function removeTester(appId, userId) {
  const r = await query('DELETE FROM oauth_app_testers WHERE app_id = ? AND user_id = ?', [String(appId), String(userId)])
  return Number(r?.affectedRows ?? 0) > 0
}

/**
 * 这个用户能不能给这个应用授权。
 *
 * **沙箱应用只认申请人自己 + 白名单** —— 这一条是「先沙箱后审核」这个模型的立足点：
 * 没有它，一把没审过的 key 就能拿去向任意用户要授权（钓鱼）。
 * OIDC 那半实现时，同意页必须调它。
 */
export async function canAuthorize(app, userId) {
  if (!app || app.status === 'suspended') return false
  if (app.status === 'live') return true
  if (String(app.owner_id) === String(userId)) return true
  const r = await queryOne('SELECT 1 AS x FROM oauth_app_testers WHERE app_id = ? AND user_id = ?', [app.id, String(userId)])
  return Boolean(r)
}

/* ---------------- 对外形状 ---------------- */

function iso(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** 邮箱只给审核人看个大概：`ab***@qq.com`。全量邮箱没必要出现在列表里 */
function maskEmail(raw) {
  const s = String(raw || '')
  const at = s.indexOf('@')
  if (at <= 0) return ''
  const head = s.slice(0, at)
  return `${head.slice(0, 2)}***${s.slice(at)}`
}

/** 申请人自己看到的形状 */
export function appForOwner(app) {
  const limits = limitsFor(app.status)
  return {
    id: app.id,
    name: app.name,
    description: app.description || '',
    homepage: app.homepage || '',
    privacyUrl: app.privacy_url || '',
    clientType: app.client_type,
    redirectUris: parseUriList(app.redirect_uris),
    embedOrigins: parseUriList(app.embed_origins),
    /** 现在真的能用的 */
    approvedScopes: parseScopes(app.approved_scopes).scopes,
    /** 申请了、还没批的 */
    requestedScopes: parseScopes(app.requested_scopes).scopes,
    status: app.status,
    reviewState: app.review_state,
    reviewNote: app.review_note || '',
    /** 打回 / 停用的理由。**原样显示给申请人** */
    reviewReason: app.review_reason || '',
    rateTier: app.rate_tier,
    limits,
    submittedAt: iso(app.submitted_at),
    reviewedAt: iso(app.reviewed_at),
    createdAt: iso(app.created_at),
  }
}

/** 审核人看到的形状：多了申请人是谁 */
export function appForReviewer(app) {
  return {
    ...appForOwner(app),
    owner: { id: app.owner_id, nickname: app.owner_nickname || '', email: maskEmail(app.owner_email) },
  }
}
