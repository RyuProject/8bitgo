/**
 * 应用与密钥：`client_id` + `client_secret`（站长口中的 AppID + key）的校验。
 *
 * 密钥**只存 bcrypt 哈希**，和用户密码同一套（`auth.js` 的 hashPassword）。
 * 库被拖走时，里面的东西不能直接拿去换令牌。
 */
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { query, queryOne } from '../db.js'
import { parseScopes } from './scopes.js'

/** client_id 的形状。`app_` 前缀让它在日志里一眼可辨 */
export const APP_ID_RE = /^app_[0-9a-f]{24}$/

export function newAppId() {
  return `app_${randomBytes(12).toString('hex')}`
}

/** 32 字节随机。**只在创建/轮换时显示一次**，之后库里只有哈希 */
export function newAppSecret() {
  return randomBytes(32).toString('base64url')
}

/** 列表里用来认出「这是哪一把」的末 6 位。不是秘密，也不足以反推 */
export function secretHint(secret) {
  return String(secret).slice(-6)
}

export async function hashSecret(secret) {
  return bcrypt.hash(String(secret), 10)
}

/**
 * 认一个应用。**失败一律返回 null**，不区分「没这个应用」和「密钥不对」——
 * 区分开就成了「这个 AppID 存不存在」的探针。
 *
 * ⚠️ 允许同时有两把有效密钥（轮换期）：新建一把 → 两边都能用 → 换完再撤旧的。
 * 不支持轮换的后果别处见过：密钥一到期所有接入方同时挂，而且没有回退路径。
 */
export async function authenticateApp(clientId, clientSecret) {
  const id = String(clientId || '')
  if (!APP_ID_RE.test(id)) return null
  const app = await queryOne(
    'SELECT id, name, client_type, status, approved_scopes, rate_tier, embed_origins FROM oauth_apps WHERE id = ?',
    [id],
  )
  if (!app || app.status === 'suspended') return null

  const secret = String(clientSecret || '')
  if (!secret) return null
  const rows = await query(
    'SELECT id, secret_hash FROM oauth_app_secrets WHERE app_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
    [id],
  )
  let matched = null
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- 最多两把，串行比并发发起两次 bcrypt 更省
    if (await bcrypt.compare(secret, String(row.secret_hash))) {
      matched = row
      break
    }
  }
  if (!matched) return null

  // 用过就记一下：轮换时靠它判断「旧的那把还有人在用吗」
  void query('UPDATE oauth_app_secrets SET last_used_at = NOW() WHERE id = ?', [matched.id]).catch(() => {})

  return {
    id: app.id,
    name: app.name,
    clientType: app.client_type,
    status: app.status,
    approvedScopes: parseScopes(app.approved_scopes).scopes,
    rateTier: app.rate_tier || 'sandbox',
    embedOrigins: safeList(app.embed_origins),
  }
}

function safeList(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  try {
    const v = JSON.parse(String(raw || '[]'))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * 从请求里取出 client_id / client_secret。两种写法都要认：
 *   · `Authorization: Basic base64(id:secret)` —— RFC 6749 规定的那一种，现成库默认发这个；
 *   · 请求体里的 `client_id` / `client_secret` —— 很多人手写 curl 时用这个。
 * 只支持其中一种的话，接入方会卡在一个「明明照文档写了却 401」的地方。
 */
export function readClientCredentials(req) {
  const h = String(req.headers?.authorization || '')
  if (h.startsWith('Basic ')) {
    try {
      const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8')
      const i = raw.indexOf(':')
      if (i > 0) {
        // RFC 6749 §2.3.1：Basic 里的两段是 application/x-www-form-urlencoded 编码过的
        return { clientId: decodeURIComponent(raw.slice(0, i)), clientSecret: decodeURIComponent(raw.slice(i + 1)) }
      }
    } catch {
      /* 解不开就当没有，往下走 body */
    }
  }
  return {
    clientId: String(req.body?.client_id || ''),
    clientSecret: String(req.body?.client_secret || ''),
  }
}
