/**
 * OpenID Connect 的公共部分：取 JWKS、验 id_token。
 *
 * Microsoft 和 Apple 都是标准 OIDC，要验的东西一模一样，只有 issuer / JWKS 地址不同，
 * 所以抽在这儿。以后再加一家（GitHub 那种非 OIDC 的除外）直接复用。
 *
 * 为什么坚持验签，而不是「反正 token 是我从对方 token 端点直接取回来的」：
 * 那个说法只在**这一次**取回来时成立，一旦以后有人把这段代码挪去处理隐式流、
 * 或者加一条「前端把 id_token 传上来」的快捷接口，不验签就是任何人都能伪造身份。
 * 验签的成本只是一个缓存住的 JWKS，没有理由省。
 */
import crypto from 'crypto'
import jwt from 'jsonwebtoken'

const FETCH_TIMEOUT_MS = 10000
/**
 * JWKS 缓存 1 小时。
 * 太短是白白给对方打接口（每次登录一发），太长则密钥轮换后会卡住 ——
 * 不过下面 kid 找不到时会强刷一次，所以轮换本身不依赖这个 TTL。
 */
const JWKS_TTL_MS = 60 * 60 * 1000
const jwksCache = new Map()

/**
 * 对方的错误响应不一定是 JSON：限流、网关故障时会吐 HTML。
 * 直接 resp.json() 会抛 SyntaxError，被全局错误处理兜成 500，真正的原因就此丢掉。
 */
export async function fetchJson(url, init) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = await resp.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { ok: resp.ok, status: resp.status, data, text }
}

async function getJwks(url, force = false) {
  const hit = jwksCache.get(url)
  if (!force && hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys
  const r = await fetchJson(url)
  if (!r.ok || !Array.isArray(r.data?.keys)) throw new Error(`取 JWKS 失败（${r.status}）`)
  jwksCache.set(url, { at: Date.now(), keys: r.data.keys })
  return r.data.keys
}

function keyFor(keys, kid) {
  const jwk = keys.find((k) => k.kid === kid)
  // Node 自带 JWK 导入，不需要 jwks-rsa 之类的依赖
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null
}

/** 只解 header，用来拿 kid。这一步还没验签，拿到的东西除了 kid 一概不能信。 */
function headerOf(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[0] || '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 验一个 id_token，返回它的 payload。任何一项对不上都抛错。
 *
 * @param {string} idToken
 * @param {{jwksUrl: string, audience: string, nonce?: string, issuer?: string|string[]}} opts
 */
export async function verifyIdToken(idToken, { jwksUrl, audience, nonce, issuer }) {
  const { kid } = headerOf(idToken)
  let key = keyFor(await getJwks(jwksUrl), kid)
  // 找不到 kid 基本都是对方刚轮换过密钥，强刷一次再找
  if (!key) key = keyFor(await getJwks(jwksUrl, true), kid)
  if (!key) throw new Error('id_token 的签名密钥不在对方的 JWKS 里')

  const payload = jwt.verify(idToken, key, {
    // 必须显式限定算法：不限的话，攻击者换个 header 就能把验签绕过去
    algorithms: ['RS256', 'ES256'],
    audience,
    ...(issuer ? { issuer } : {}),
    // 两边的机器时钟不会完全一致，给 60 秒余量，免得偶发 "jwt not active"
    clockTolerance: 60,
  })

  /**
   * nonce 把这个 id_token 和**我们自己发起的那一次跳转**绑在一起。
   * 少了它，攻击者可以拿一个在别处骗到的、签名完全合法的 id_token 重放进来。
   */
  if (nonce && payload.nonce !== nonce) throw new Error('id_token 的 nonce 对不上')
  return payload
}
