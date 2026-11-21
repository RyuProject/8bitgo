/**
 * 后台上传用的短期 Worker 凭据（2026-11-22）。
 *
 * 为什么不把 ADMIN_TOKEN 直接发给浏览器：它是 Worker 的长期主口令，泄露后只能手工轮换；
 * 而后台「Worker 口令」框需要人手填，2026-11-22 就出过管理员把占位词 `ADMIN_TOKEN` 字面填进去、
 * 上传一律 401 的事。现在登录了后台、有 site:manage 的人由服务端签一张几小时就过期的凭据，
 * 页面自动带上；Worker 用同一把 ROM_UPLOAD_SIGNING_SECRET 验签（worker/src/common.js），
 * 主口令照旧只在服务端与 Worker 之间，转换任务也照旧用它。
 *
 * 格式：`8bg1.<过期 Unix 秒>.<随机串>.<HMAC-SHA256(secret, 前三段) 的 base64url>`。
 * 随机串只让每张凭据不同，没有服务端状态；吊销靠轮换签名密钥（旧凭据立刻全部失效）。
 */
import { createHmac, randomBytes } from 'node:crypto'

export const ROM_UPLOAD_CREDENTIAL_PREFIX = '8bg1'
/** 12 小时：一次大 ISO 的分片上传也跑得完；页面在剩 3 小时时续签 */
export const ROM_UPLOAD_CREDENTIAL_TTL_SEC = 12 * 3600
/** 签名密钥太短等于没签：少于 32 字符一律当作没配，接口回 503，页面退回手填 */
export const ROM_UPLOAD_SIGNING_SECRET_MIN = 32

export function romUploadSigningSecret(env = process.env) {
  const secret = String(env.ROM_UPLOAD_SIGNING_SECRET || '').trim()
  return secret.length >= ROM_UPLOAD_SIGNING_SECRET_MIN ? secret : ''
}

export function issueRomUploadCredential({ secret, ttlSec = ROM_UPLOAD_CREDENTIAL_TTL_SEC, now = Date.now() } = {}) {
  if (!secret || secret.length < ROM_UPLOAD_SIGNING_SECRET_MIN) throw new Error('ROM_UPLOAD_SIGNING_SECRET 未配置或太短')
  const exp = Math.floor(now / 1000) + ttlSec
  const body = `${ROM_UPLOAD_CREDENTIAL_PREFIX}.${exp}.${randomBytes(12).toString('base64url')}`
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return { token: `${body}.${sig}`, expiresAt: exp * 1000 }
}
