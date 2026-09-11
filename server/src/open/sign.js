/**
 * 短期凭据：ROM 下载地址与嵌入播放器地址的签名。纯函数 + node:crypto，可直接跑测试。
 *
 * ## 为什么不是「发个 URL 就完了」
 *
 * 这两样东西的地址会离开我们的控制：ROM 地址会进第三方的服务器日志、
 * 嵌入地址会进浏览器历史和 Referer。所以地址本身必须是**自证的、会过期的、绑死用途的**：
 *
 *   · 绑 `app_id`  —— 谁领的谁用，转手给别人也能查出是从哪把 key 漏出去的；
 *   · 绑 `slug` / `object key` —— 换个 slug 就验不过，不能拿一张票下整库；
 *   · 绑 `exp`    —— 分钟级。抄走地址的窗口就是这么长；
 *   · 用**我们自己的密钥**签（`OPEN_ROM_SECRET` / `OPEN_EMBED_SECRET`），
 *     **不是** app secret —— 库里只存 app secret 的 bcrypt 哈希，我们自己都签不出来。
 *
 * ## ⚠️ 这层签名现在还不是真的门
 *
 * `assets.8bitgo.com` 目前是**公开读**：任何人打开一次游戏、从网络面板抄走 ROM 地址，
 * 就能无限次直接下载，跟有没有 appkey 毫无关系。所以在把 ROM 写进开放平台的承诺之前，
 * 必须先做 P-1：对象改为不可公开读、只能经这里发的凭据取。
 * 在那之前，这一层只是「我们不主动给」，**别对外宣传成访问控制**。
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/** ROM 凭据默认寿命。短到抄走也用不了几次，长到够下完一个几十 MB 的包 */
export const ROM_GRANT_TTL_SEC = 300
/** 嵌入地址寿命。比 ROM 长：一个页面可能开着很久才被点开 */
export const EMBED_TTL_SEC = 3600

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest()
}

/**
 * 定长比较。**必须用 timingSafeEqual** —— 普通 `===` 会在第一个不同的字节就返回，
 * 攻击者据此可以一个字节一个字节地把签名试出来。长度不同直接判否（长度本身不是秘密）。
 */
function sameSig(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * 签一张 ROM 凭据。
 *
 * 形状是 `<payload>.<sig>`，payload 是 base64url 的 JSON —— 自包含，服务端不用存任何东西
 * （存的话就要清理、要同步，而这张票的寿命只有五分钟）。
 *
 * @param {object} o
 * @param {string} o.secret   OPEN_ROM_SECRET
 * @param {string} o.appId    领票的应用
 * @param {string} o.slug     游戏
 * @param {string} o.lang     ROM 语言（'*' = 通用件）
 * @param {string} o.key      对象存储 key。**放在 payload 里但绝不单独出现在响应里**
 * @param {number} [o.ttl]
 * @param {number} [o.now]
 */
export function signRomGrant({ secret, appId, slug, lang, key, ttl = ROM_GRANT_TTL_SEC, now }) {
  if (!secret) throw new Error('缺少 OPEN_ROM_SECRET')
  const exp = Math.floor((now ?? Date.now()) / 1000) + Math.max(30, Math.floor(ttl))
  const payload = {
    a: String(appId),
    s: String(slug),
    l: String(lang || '*'),
    k: String(key),
    e: exp,
    // 随机串：同一个应用同一分钟内反复领票，得到的凭据不一样 —— 便于按票追踪单次下载
    n: b64url(randomBytes(6)),
  }
  const body = b64url(JSON.stringify(payload))
  return `${body}.${b64url(hmac(secret, body))}`
}

/**
 * 验一张 ROM 凭据。
 * @returns {{ ok: true, appId, slug, lang, key, exp } | { ok: false, reason: 'malformed'|'bad_signature'|'expired' }}
 */
export function verifyRomGrant(grant, { secret, now } = {}) {
  const [body, sig] = String(grant || '').split('.')
  if (!body || !sig) return { ok: false, reason: 'malformed' }
  if (!sameSig(sig, b64url(hmac(secret, body)))) return { ok: false, reason: 'bad_signature' }
  let p
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!p?.k || !p?.a || !p?.s) return { ok: false, reason: 'malformed' }
  // ⚠️ 先验签再看过期：顺序反了的话，一张改过 e 的票会走到「过期」分支，
  // 攻击者就能从错误码里区分「签名错」和「只是过期」，那是一条信息泄露
  if (Number(p.e) * 1000 <= (now ?? Date.now())) return { ok: false, reason: 'expired' }
  return { ok: true, appId: String(p.a), slug: String(p.s), lang: String(p.l || '*'), key: String(p.k), exp: Number(p.e) }
}

/**
 * 嵌入播放器地址的签名。和 ROM 那张分开用两把密钥、两个函数：
 * 一把密钥泄露不该把另一件事也带走，而且两者的寿命和吊销节奏完全不同。
 */
export function signEmbed({ secret, appId, slug, ttl = EMBED_TTL_SEC, now }) {
  if (!secret) throw new Error('缺少 OPEN_EMBED_SECRET')
  const exp = Math.floor((now ?? Date.now()) / 1000) + Math.max(60, Math.floor(ttl))
  const base = `${appId}|${slug}|${exp}`
  return { sig: b64url(hmac(secret, base)), exp }
}

export function verifyEmbed({ secret, appId, slug, exp, sig, now }) {
  if (!appId || !slug || !exp || !sig) return { ok: false, reason: 'malformed' }
  if (!sameSig(sig, b64url(hmac(secret, `${appId}|${slug}|${exp}`)))) return { ok: false, reason: 'bad_signature' }
  if (Number(exp) * 1000 <= (now ?? Date.now())) return { ok: false, reason: 'expired' }
  return { ok: true }
}
