/**
 * 外部设备开播凭证。
 *
 * 开放平台 access token 只有 15 分钟，而且还能读取用户授权过的数据；把它长期塞在
 * Socket.IO 握手里既容易在日志里泄露，也会让一场直播的重连能力被 15 分钟寿命卡住。
 * 所以设备先用 live.write 换一枚用途单一的发布凭证：它只能连接 /live 当主播，
 * 不能拿去调用任何 REST 用户接口。两类 JWT 共用 RSA 密钥，但 typ / aud / kind 都不同，
 * 任意一边的验证器都不会把另一边当成自己的令牌。
 */
import jwt from 'jsonwebtoken'

export const LIVE_PUBLISHER_TOKEN_TYP = 'live-publisher+jwt'
export const LIVE_PUBLISHER_AUDIENCE = '8bitgo-live-publisher'
/** 一次游戏直播通常远短于 12 小时；同时给网络抖动后的续播留足窗口。 */
export const LIVE_PUBLISHER_TTL_SEC = Math.max(
  900,
  Math.min(86_400, Number(process.env.OPEN_LIVE_PUBLISH_TTL_SEC) || 43_200),
)

const nowSec = (now) => Math.floor((now ?? Date.now()) / 1000)

export function issueLivePublisherToken({ privateKey, kid, issuer, appId, userId, ttl, now }) {
  if (!privateKey) throw new Error('缺少 OPEN_JWT_PRIVATE_KEY')
  if (!appId || !userId) throw new Error('缺少开播身份')
  const iat = nowSec(now)
  const exp = iat + Math.max(900, Math.min(86_400, Math.floor(Number(ttl) || LIVE_PUBLISHER_TTL_SEC)))
  return jwt.sign(
    {
      iss: issuer,
      sub: String(userId),
      aud: LIVE_PUBLISHER_AUDIENCE,
      cid: String(appId),
      kind: 'live-publisher',
      scope: 'live.write',
      iat,
      exp,
    },
    privateKey,
    {
      algorithm: 'RS256',
      header: { typ: LIVE_PUBLISHER_TOKEN_TYP, ...(kid ? { kid } : {}) },
    },
  )
}

/**
 * 只验证设备开播凭证。失败返回 null，避免把验签的细节暴露给远端。
 * @returns {{appId:string,userId:string,exp:number}|null}
 */
export function verifyLivePublisherToken(token, { publicKey, issuer, now } = {}) {
  if (!token || !publicKey) return null
  let decoded
  try {
    decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: LIVE_PUBLISHER_AUDIENCE,
      ...(issuer ? { issuer } : {}),
      clockTolerance: 5,
      ...(now ? { clockTimestamp: Math.floor(now / 1000) } : {}),
      complete: true,
    })
  } catch {
    return null
  }
  const payload = decoded?.payload
  if (decoded?.header?.typ !== LIVE_PUBLISHER_TOKEN_TYP) return null
  if (payload?.kind !== 'live-publisher' || payload?.scope !== 'live.write') return null
  if (!payload.cid || !payload.sub) return null
  return {
    appId: String(payload.cid),
    userId: String(payload.sub),
    exp: Number(payload.exp) || 0,
  }
}
