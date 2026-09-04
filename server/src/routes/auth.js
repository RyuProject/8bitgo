import express, { Router } from 'express'
import crypto from 'crypto'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'
import { query, queryOne } from '../db.js'
import { hashPassword, verifyPassword, signToken, requireUser, tokenVersionOf } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds } from '../userdata.js'
import { issueCode, verifyCode, sendCodeError } from '../codes.js'
import { fetchJson, verifyIdToken } from '../oidc.js'

export const authRouter = Router()

const WELCOME_COINS = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function newId() {
  return 'u_' + crypto.randomBytes(6).toString('hex')
}

function nicknameFromEmail(email) {
  const base = email.split('@')[0].replace(/[^\w.-]/g, '').slice(0, 16)
  return base.length >= 2 ? base : '玩家'
}

async function publicWithData(userRow) {
  const [f, r] = await Promise.all([favIds(userRow.id), recentIds(userRow.id)])
  return userRowToPublic(userRow, f, r)
}

/** 找到或按邮箱创建一个「无密码」用户（验证码 / 第三方登录用）。 */
async function findOrCreateByEmail(email, nickname) {
  let row = await queryOne('SELECT * FROM users WHERE email = ?', [email])
  if (!row) {
    const id = newId()
    const createdAt = new Date().toISOString().slice(0, 10)
    await query(
      'INSERT INTO users (id, email, nickname, avatar, password_hash, coins, role, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, email, nickname, '🕹️', '', WELCOME_COINS, 'user', 'active', createdAt],
    )
    row = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  }
  return row
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const nickname = String(req.body.nickname || '').trim()
    const password = String(req.body.password || '')
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })
    if (nickname.length < 2 || nickname.length > 16) return res.status(400).json({ error: '昵称需要 2–16 个字符' })
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })

    const exists = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    if (exists) return res.status(409).json({ error: '该邮箱已注册，请直接登录' })

    const id = newId()
    const hash = await hashPassword(password)
    const createdAt = new Date().toISOString().slice(0, 10)
    await query(
      'INSERT INTO users (id, email, nickname, avatar, password_hash, coins, role, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, email, nickname, '🕹️', hash, WELCOME_COINS, 'user', 'active', createdAt],
    )
    const row = await queryOne('SELECT * FROM users WHERE id = ?', [id])
    res.json({ token: signToken(id, tokenVersionOf(row)), user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

authRouter.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const password = String(req.body.password || '')
    const row = await queryOne('SELECT * FROM users WHERE email = ?', [email])
    if (!row) return res.status(401).json({ error: '邮箱或密码不正确' })
    /**
     * 验证码 / Google 创建的账号 password_hash 是空串。
     * 直接扔给 bcrypt.compare 的话它对着一个非法哈希返回 false，用户看到的是
     * 「邮箱或密码不正确」—— 他会以为自己记错了密码，反复试一个从来不存在的东西。
     * 这里单独说清楚：这个账号还没有密码，走验证码就能进，进去之后可以在个人中心设一个。
     */
    if (!row.password_hash) {
      return res.status(401).json({ error: '这个账号还没有设置密码，请用邮箱验证码登录（登录后可在个人中心设置密码）' })
    }
    const ok = await verifyPassword(password, row.password_hash)
    if (!ok) return res.status(401).json({ error: '邮箱或密码不正确' })
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id, tokenVersionOf(row)), user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 邮箱验证码登录 ---------------- */
/**
 * 冷却、爆破防护、发信配额、存哪儿，全在 ../codes.js 里 ——
 * 换绑邮箱和注销账号也要发同样的一封码（见 routes/me.js），
 * 三处抄三遍必然会漏掉其中一道。
 */

authRouter.post('/email/request-code', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })
    res.json({ ok: true, ...(await issueCode(req, email, 'login')) })
  } catch (e) {
    sendCodeError(res, next, e)
  }
})

authRouter.post('/email/verify', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })
    await verifyCode(email, 'login', String(req.body.code || ''))
    const row = await findOrCreateByEmail(email, nicknameFromEmail(email))
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id, tokenVersionOf(row)), user: await publicWithData(row) })
  } catch (e) {
    sendCodeError(res, next, e)
  }
})

/* ---------------- Google 登录 ---------------- */
// 前端用 Google Identity Services 拿到 ID token（credential），这里校验后签发本站 JWT。
authRouter.post('/google', async (req, res, next) => {
  try {
    // aud 必须校验：它标明这个 ID token 是签给**哪个应用**的。
    // 之前写成 `if (clientId && ...)`，没配 GOOGLE_CLIENT_ID 时整段被短路 ——
    // 那样任何人拿自己应用（或别的网站）的 Google token 都能登进本站的任意邮箱账号。
    // 没配就直接拒绝，也顺手省掉一次对 Google 的请求。
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim()
    if (!clientId) {
      return res.status(503).json({ error: '本站未配置 Google 登录（服务端缺少 GOOGLE_CLIENT_ID）' })
    }
    const credential = String(req.body.credential || '')
    if (!credential) return res.status(400).json({ error: '缺少 Google 凭证' })
    const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential))
    if (!resp.ok) return res.status(401).json({ error: 'Google 凭证无效' })
    const info = await resp.json()
    if (info.aud !== clientId) return res.status(401).json({ error: 'Google 凭证与本站不匹配' })
    // 字段缺失时也拒绝：拿不到「邮箱已验证」的证据就不能凭这个邮箱发身份
    if (info.email_verified !== true && info.email_verified !== 'true') {
      return res.status(401).json({ error: 'Google 邮箱未验证' })
    }
    const email = String(info.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(401).json({ error: '无法获取 Google 邮箱' })
    const nickname = String(info.name || nicknameFromEmail(email)).slice(0, 16)
    const row = await findOrCreateByEmail(email, nickname)
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id, tokenVersionOf(row)), user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- Microsoft / Apple 登录（OIDC 授权码） ---------------- */
/**
 * 两家都是标准 OIDC 授权码流程，走的是**整页跳转 + 服务端回调**：
 *
 *   点按钮 → GET /api/auth/oauth/<provider>/start（302 跳到对方）
 *   → 用户在对方那边同意
 *   → 对方回调 /api/auth/oauth/<provider>/callback（Microsoft 是 GET，Apple 是 POST）
 *   → 这里换 id_token、验签、按邮箱找到或建号、签本站 JWT
 *   → 302 回前端 /auth/callback#token=…，由前端存下登录态
 *
 * 为什么回调落在**后端**而不是前端路由：
 * Apple 在 scope 带 name/email 时强制 `response_mode=form_post` —— 它是 POST 过来的，
 * 前端路由根本收不到。既然 Apple 必须走后端，Microsoft 也一起走，省得两套流程各有各的坑。
 *
 * client secret 全程只在服务端用，浏览器连一次都见不到。
 */

/** state 用本站 JWT 自封装，不落库。加个用途后缀，免得它被当成会话令牌用 */
const STATE_SECRET = (process.env.JWT_SECRET || 'dev-secret-change-me') + ':oauth-state'
/** 用户在对方页面上磨蹭的时间。太短会让「先去收验证码再回来同意」这类操作白跑一趟 */
const STATE_TTL = '15m'

/** 个人 Microsoft 账号（Outlook/Hotmail/Live）所在的租户，邮箱由微软自己管，天然可信 */
const MS_CONSUMER_TID = '9188040d-6c67-4c5b-b112-36a304b66dad'

function trimEnv(name) {
  return (process.env[name] || '').trim()
}

/** 回调地址的根。默认就是站点自己；前后端分域部署时用 OAUTH_REDIRECT_BASE 覆盖 */
function oauthBase() {
  return (trimEnv('OAUTH_REDIRECT_BASE') || trimEnv('PUBLIC_SITE_URL')).replace(/\/+$/, '')
}
/** 注册到对方后台的「重定向 URI」。三处（对方后台 / 这里 / 实际路由）必须一字不差 */
function redirectUri(provider) {
  return `${oauthBase()}/api/auth/oauth/${provider}/callback`
}
/** 登完把人送回的前端页面 */
function landingUrl() {
  return `${trimEnv('PUBLIC_SITE_URL').replace(/\/+$/, '')}/auth/callback`
}

function msTenant() {
  return trimEnv('MICROSOFT_TENANT') || 'common'
}

/**
 * Apple 的 client_secret 不是一个固定字符串，而是**用 .p8 私钥现签的 ES256 JWT**，
 * 最长只能有效 6 个月。所以每次换 token 前现签一个短期的，不缓存也不入库。
 */
function applePrivateKey() {
  const inline = trimEnv('APPLE_PRIVATE_KEY')
  // .env 里换行只能写成 \n，这里还原回真正的换行，否则 PEM 解析不了
  if (inline) return inline.replace(/\\n/g, '\n')
  const file = trimEnv('APPLE_PRIVATE_KEY_PATH')
  return file ? readFileSync(file, 'utf8') : ''
}

const PROVIDERS = {
  microsoft: {
    label: 'Microsoft',
    scope: 'openid email profile',
    responseMode: 'query',
    needs: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    config: () => ({ clientId: trimEnv('MICROSOFT_CLIENT_ID') }),
    authorizeUrl: () => `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/token`,
    jwksUrl: () => `https://login.microsoftonline.com/${msTenant()}/discovery/v2.0/keys`,
    clientSecret: () => trimEnv('MICROSOFT_CLIENT_SECRET'),
    /**
     * ⚠️ 这里是整条链路上最容易出安全事故的一步。
     *
     * 本站按「已验证的邮箱」合并账号（同一个邮箱，Google 登和 Microsoft 登是同一个人）。
     * 但 Entra 里，**任何一个租户的管理员**都能把自己用户的 email 属性填成 victim@gmail.com ——
     * 只认 email 这个字段的话，等于谁都能冒领本站账号。
     *
     * 微软给的判据是可选声明 `xms_edov`（邮箱域名是否已被该租户验证所有权）。
     * 它默认不下发，必须在应用注册里显式加上（见 .env.example 的说明）。
     * 个人账号那个租户（MSA）由微软自己管邮箱，可以直接采信。
     * 两条都不满足就拒绝，宁可让人换一种方式登录，也不能把账号发错人。
     */
    profile: (payload) => ({
      email: String(payload.email || payload.preferred_username || '').trim().toLowerCase(),
      verified:
        payload.xms_edov === true ||
        payload.xms_edov === 1 ||
        payload.xms_edov === '1' ||
        payload.tid === MS_CONSUMER_TID,
      name: String(payload.name || ''),
    }),
  },
  apple: {
    label: 'Apple',
    scope: 'name email',
    // 带 name/email 的 scope 时 Apple 只支持 form_post，这不是可选项
    responseMode: 'form_post',
    needs: ['APPLE_SERVICES_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY(_PATH)'],
    config: () => ({ clientId: trimEnv('APPLE_SERVICES_ID') }),
    authorizeUrl: () => 'https://appleid.apple.com/auth/authorize',
    tokenUrl: () => 'https://appleid.apple.com/auth/token',
    jwksUrl: () => 'https://appleid.apple.com/auth/keys',
    ready: () =>
      Boolean(trimEnv('APPLE_SERVICES_ID') && trimEnv('APPLE_TEAM_ID') && trimEnv('APPLE_KEY_ID') && applePrivateKey()),
    clientSecret: (cfg) =>
      jwt.sign({}, applePrivateKey(), {
        algorithm: 'ES256',
        keyid: trimEnv('APPLE_KEY_ID'),
        issuer: trimEnv('APPLE_TEAM_ID'),
        audience: 'https://appleid.apple.com',
        subject: cfg.clientId,
        expiresIn: '30m',
      }),
    issuer: 'https://appleid.apple.com',
    /**
     * Apple 的邮箱一律是验证过的（要么是 Apple ID 本身，要么是它代发的中转地址）。
     * 用户勾了「隐藏邮箱」时给的是 xxx@privaterelay.appleid.com —— 那是个能收信的真地址，
     * 而且对本站是稳定且唯一的，当账号用没有问题。
     *
     * 名字只有**第一次授权**时才会给，还不在 id_token 里，而在表单的 user 字段上。
     * 第二次起就没有了，所以拿到就得用，指望以后再查是查不到的。
     */
    profile: (payload, form) => {
      let name = ''
      try {
        const u = JSON.parse(String(form.user || ''))
        name = [u?.name?.firstName, u?.name?.lastName].filter(Boolean).join(' ').trim()
      } catch {
        name = ''
      }
      return {
        email: String(payload.email || '').trim().toLowerCase(),
        verified: payload.email_verified === true || payload.email_verified === 'true',
        name,
      }
    },
  },
}

function providerReady(p) {
  return p.ready ? p.ready() : Boolean(p.config().clientId && p.clientSecret(p.config()))
}

/** 配置齐不齐。缺东西时直接 503，不去打对方接口 */
function notConfigured(res, key, p) {
  if (!oauthBase() || !landingUrl().startsWith('http')) {
    return res.status(503).json({ error: '本站未配置站点地址（服务端缺少 PUBLIC_SITE_URL）' })
  }
  if (!providerReady(p)) {
    return res.status(503).json({ error: `本站未配置 ${p.label} 登录（服务端缺少 ${p.needs.join(' / ')}）` })
  }
  return null
}

/**
 * 失败也回前端那一页，用 # 上的 error 码说明原因。
 * 不在这里吐 JSON：用户此刻正站在一次整页跳转的落点上，看到一段裸 JSON 会以为站崩了。
 */
function failBack(res, cst, code) {
  const url = `${landingUrl()}#error=${encodeURIComponent(code)}&cst=${encodeURIComponent(cst)}`
  return res.set('Cache-Control', 'no-store').redirect(302, url)
}

authRouter.get('/oauth/:provider/start', (req, res) => {
  const key = String(req.params.provider)
  const p = PROVIDERS[key]
  if (!p) return res.status(404).json({ error: '未知的登录方式' })
  const stop = notConfigured(res, key, p)
  if (stop) return stop

  const cfg = p.config()
  const nonce = crypto.randomBytes(16).toString('hex')
  /**
   * cst 是**前端**生成、存在自己 sessionStorage 里的随机串。
   * 它跟着 state 走一圈再回到前端，由前端比对 —— 这样一次登录才算真正绑在
   * 「发起它的那个浏览器」上。只验服务端签的 state 挡不住登录 CSRF：
   * 攻击者也能从 /start 拿到一个合法 state。
   */
  const cst = String(req.query.cst || '').slice(0, 64)
  const state = jwt.sign({ p: key, n: nonce, c: cst }, STATE_SECRET, { expiresIn: STATE_TTL })

  const url = new URL(p.authorizeUrl())
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri(key))
  url.searchParams.set('scope', p.scope)
  url.searchParams.set('response_mode', p.responseMode)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  res.set('Cache-Control', 'no-store').redirect(302, url.toString())
})

async function oauthCallback(req, res, next) {
  const key = String(req.params.provider)
  const p = PROVIDERS[key]
  if (!p) return res.status(404).json({ error: '未知的登录方式' })
  // Apple 是 form_post，Microsoft 是 query
  const src = req.method === 'POST' ? req.body || {} : req.query || {}

  // 先验 state：合法的 state 只可能由本站 /start 签出来，伪造的回调到这里就断了。
  // 它同时载着 nonce 和 cst，所以必须在碰任何别的参数之前验
  let claims
  try {
    claims = jwt.verify(String(src.state || ''), STATE_SECRET)
  } catch {
    return failBack(res, '', 'state')
  }
  const cst = String(claims.c || '')
  if (claims.p !== key) return failBack(res, cst, 'state')

  const stop = notConfigured(res, key, p)
  if (stop) return stop

  try {
    // 用户在对方页面点了「取消」
    if (src.error) return failBack(res, cst, 'denied')
    const code = String(src.code || '')
    if (!code) return failBack(res, cst, 'nocode')

    const cfg = p.config()
    const tok = await fetchJson(p.tokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: p.clientSecret(cfg),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(key),
      }).toString(),
    })
    const idToken = String(tok.data?.id_token || '')
    if (!idToken) {
      // 原文只进服务端日志：里面可能回显 client_id 之类，而且 code 用过即废，
      // 对用户来说唯一有用的动作就是重来一次
      console.warn(`[oauth:${key}] 换 id_token 失败：`, tok.status, tok.text.slice(0, 300))
      return failBack(res, cst, 'token')
    }

    let payload
    try {
      payload = await verifyIdToken(idToken, {
        jwksUrl: p.jwksUrl(),
        audience: cfg.clientId,
        nonce: claims.n,
        issuer: p.issuer,
      })
    } catch (e) {
      console.warn(`[oauth:${key}] id_token 验签失败：`, e?.message || e)
      return failBack(res, cst, 'token')
    }

    const { email, verified, name } = p.profile(payload, src)
    if (!EMAIL_RE.test(email)) return failBack(res, cst, 'noemail')
    // 拿不到「这个邮箱确实归他」的证据就不能凭它发身份 —— 本站是按邮箱合并账号的
    if (!verified) return failBack(res, cst, 'unverified')

    const row = await findOrCreateByEmail(email, (name || nicknameFromEmail(email)).slice(0, 16))
    if (row.status === 'banned') return failBack(res, cst, 'banned')

    /**
     * 令牌放在 **#** 后面：fragment 不会跟着请求发给任何服务器，也不进反代和 CDN 的访问日志。
     * 前端拿到后立刻 replaceState 把它从地址栏抹掉。
     */
    const out =
      `${landingUrl()}#token=${encodeURIComponent(signToken(row.id, tokenVersionOf(row)))}` +
      `&cst=${encodeURIComponent(cst)}`
    res.set('Cache-Control', 'no-store').redirect(302, out)
  } catch (e) {
    next(e)
  }
}

authRouter.get('/oauth/:provider/callback', oauthCallback)
// Apple 用 form_post 回调，全站只挂了 express.json()，这条得自己解表单
authRouter.post('/oauth/:provider/callback', express.urlencoded({ extended: false }), oauthCallback)

/** 用当前 token 换取用户信息（用于开机恢复登录态） */
authRouter.get('/me', requireUser, async (req, res, next) => {
  try {
    res.json(await publicWithData(req.user))
  } catch (e) {
    next(e)
  }
})
