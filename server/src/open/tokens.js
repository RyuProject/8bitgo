/**
 * 开放平台的 access token：**独立 RSA 密钥 + RS256**，和站内登录令牌互不相认。
 *
 * ## 这是整套开放平台唯一一个「错一次全盘皆输」的地方
 *
 * 站内 `signToken` 是 HS256 + `JWT_SECRET`，payload `{uid, tv}`。本仓库实测过
 * （jsonwebtoken 9）：一个 HS256 签的、payload 里带 `uid` 的令牌，哪怕再多带
 * `aud` / `scope`，现有的 `verifyToken` 也会**原样接受并取出 uid** —— 因为没有任何一处
 * 检查那两个字段。也就是说：开放平台只要图省事复用了 `JWT_SECRET`，
 * 一个「只读昵称」的第三方令牌立刻等价于完整账号令牌，能去调 `/api/me` 改邮箱、
 * 调 `/api/saves` 删存档。
 *
 * 所以这里的三条是硬约束，`server/scripts/test-openapi.mjs` 第一条测的就是它们：
 *
 *   1. 用**独立的 RSA 私钥** RS256 签（`OPEN_JWT_PRIVATE_KEY_PATH`），与 JWT_SECRET 无关；
 *   2. header 带 `typ: 'at+jwt'`（RFC 9068），payload 必带 `aud` / `cid` / `scope` / `kind`；
 *   3. 两边都做**白名单式**判断：站内 verifyToken 写死 `algorithms: ['HS256']` 且拒绝带
 *      `aud`/`scope`/`cid` 的令牌；这里写死 `algorithms: ['RS256']` 且要求 `typ=at+jwt`。
 *      不要写成「不是 A 就当 B」——「密钥是字符串就只认 HS」是 jsonwebtoken 的实现细节，
 *      不是它的承诺，别把安全边界押在上面。
 */
import jwt from 'jsonwebtoken'

/** RFC 9068 给 OAuth access token 定的 JWT 类型 */
export const OPEN_TOKEN_TYP = 'at+jwt'

/**
 * access token 的寿命。
 * 15 分钟不是随便写的：**被封禁的用户、被撤销的授权，最长要过这么久才真正失效**
 * （中间没有任何查库动作，令牌是自包含的）。想更快只能缩短它或者加吊销表查询。
 */
export const OPEN_ACCESS_TTL_SEC = 900

function nowSec(now) {
  return Math.floor((now ?? Date.now()) / 1000)
}

function sign({ privateKey, kid, issuer, appId, sub, kind, scopes, ttl, now, extra }) {
  if (!privateKey) throw new Error('缺少 OPEN_JWT_PRIVATE_KEY')
  if (!appId) throw new Error('缺少 client_id')
  const iat = nowSec(now)
  const exp = iat + Math.max(60, Math.floor(Number(ttl) || OPEN_ACCESS_TTL_SEC))
  const payload = {
    iss: issuer,
    sub: String(sub),
    aud: String(appId),
    cid: String(appId),
    kind,
    scope: (Array.isArray(scopes) ? scopes : []).join(' '),
    iat,
    exp,
    ...(extra || {}),
  }
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    header: { typ: OPEN_TOKEN_TYP, ...(kid ? { kid } : {}) },
  })
}

/**
 * 应用级令牌（`grant_type=client_credentials`）。**背后没有用户**。
 * 按 RFC 9068，这种令牌的 `sub` 就是 client_id —— 但那会让「这是谁的令牌」
 * 要靠 `sub === cid` 去推断，太脆。所以额外带一个显式的 `kind: 'app'`，
 * 中间件按它判断，不做推断。
 */
export function issueAppToken(opts) {
  return sign({ ...opts, sub: opts.appId, kind: 'app' })
}

/** 用户级令牌（授权码换来的）。`sub` = users.id */
export function issueUserToken(opts) {
  return sign({ ...opts, kind: 'user' })
}

/**
 * 验一个开放平台令牌。**失败一律返回 null**，不抛 —— 调用方是中间件，
 * 它只需要「行 / 不行」，而把 jsonwebtoken 的原始报错透给第三方等于告诉攻击者哪一步错了。
 *
 * @returns {{ appId, userId, kind, scopes: string[], exp } | null}
 */
export function verifyOpenToken(token, { publicKey, issuer, now } = {}) {
  if (!token || !publicKey) return null
  let payload
  try {
    payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      ...(issuer ? { issuer } : {}),
      // aud 由调用方按 client_id 自己比对（一把公钥服务所有应用），这里只验签名与时效
      clockTolerance: 5,
      ...(now ? { clockTimestamp: Math.floor(now / 1000) } : {}),
    })
  } catch {
    return null
  }
  // typ 必须对：这是「这枚令牌是开放平台发的」的显式标记
  const header = decodeHeader(token)
  if (header?.typ !== OPEN_TOKEN_TYP) return null
  if (payload.kind !== 'app' && payload.kind !== 'user') return null
  if (!payload.cid || !payload.aud) return null
  return {
    appId: String(payload.cid),
    userId: payload.kind === 'user' ? String(payload.sub) : '',
    kind: payload.kind,
    scopes: String(payload.scope || '').split(/\s+/).filter(Boolean),
    exp: Number(payload.exp) || 0,
  }
}

function decodeHeader(token) {
  try {
    const [h] = String(token).split('.')
    return JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * JWKS 里那一份公钥。接入方的现成 OIDC 库会自己来拉。
 * 轮换时新旧两把**同时挂**，靠 kid 区分 —— 只挂新的那一把，所有在飞的令牌当场全废。
 */
export function jwkFromPublicKey(publicKeyPem, kid, createPublicKey) {
  const key = createPublicKey(publicKeyPem)
  const jwk = key.export({ format: 'jwk' })
  return { ...jwk, use: 'sig', alg: 'RS256', kid }
}
