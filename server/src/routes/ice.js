/**
 * ICE 配置下发：GET /api/netplay/ice
 *
 * 为什么要有这个接口 —— 两个原因：
 *
 * 1. **连通率**。P2P 直连要穿 NAT，只靠 STUN 大约有一到两成的组合连不通
 *    （对称型 NAT、部分企业网与移动网络），必须有 TURN 中继兜底。
 *
 * 2. **凭证不能写进前端包**。以前 TURN 账号密码是通过 VITE_NETPLAY_ICE 打进 JS 的，
 *    任何人打开 DevTools 就能抄走，拿你的 TURN 当免费流量中转。
 *    这里改成按请求现算一份**短期凭证**（默认 1 小时过期），照 coturn 的
 *    REST API 约定（static-auth-secret）：
 *        username   = <过期时间戳>:<标签>
 *        credential = base64( HMAC-SHA1(username, TURN_SECRET) )
 *    coturn 侧只要开 `use-auth-secret` + `static-auth-secret=<同一个值>` 即可，
 *    不需要建任何用户。
 *
 * 没配 TURN_SECRET 时退回纯 STUN，功能照常，只是连通率低一些。
 */
import { Router } from 'express'
import { createHmac } from 'node:crypto'

export const iceRouter = Router()

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:global.stun.twilio.com:3478',
]

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** coturn 的短期凭证：用户名里带过期时间，密码是它的 HMAC */
function turnCredentials(secret, ttlSec, label) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec
  const username = `${expiry}:${label}`
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential, expiry }
}

iceRouter.get('/', (req, res) => {
  const stun = list(process.env.STUN_URLS)
  const iceServers = [{ urls: stun.length ? stun : DEFAULT_STUN }]

  const turnUrls = list(process.env.TURN_URLS)
  const secret = (process.env.TURN_SECRET || '').trim()
  const ttl = Math.max(300, Math.min(86400, Number(process.env.TURN_TTL_SEC) || 3600))

  let expiry = 0
  if (turnUrls.length && secret) {
    // 标签只用来在 coturn 日志里区分来源，不参与鉴权，所以放个粗粒度的标识就行
    const label = String(req.query.u || 'guest').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'guest'
    const cred = turnCredentials(secret, ttl, label)
    expiry = cred.expiry
    iceServers.push({ urls: turnUrls, username: cred.username, credential: cred.credential })
  }

  // 凭证会过期，别让 CDN / 浏览器缓存住
  res.set('Cache-Control', 'no-store')
  res.json({
    iceServers,
    /** 有没有 TURN 兜底。前端据此决定要不要提示「可能连不通」 */
    hasTurn: iceServers.length > 1,
    /** 凭证过期时间（unix 秒）；0 表示没有 TURN，无需续期 */
    expiry,
    ttl,
  })
})
