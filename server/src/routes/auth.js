import { Router } from 'express'
import crypto from 'crypto'
import { query, queryOne } from '../db.js'
import { hashPassword, verifyPassword, signToken, requireUser, tokenVersionOf } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds } from '../userdata.js'
import { issueCode, verifyCode, sendCodeError } from '../codes.js'

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

/* ---------------- 微博登录 ---------------- */
/**
 * 标准 OAuth2 授权码流程，三步：
 *   1. 前端向 /api/auth/weibo/authorize-url 要授权地址，整页跳到微博
 *   2. 微博带 code 跳回 WEIBO_REDIRECT_URI（**必须与开放平台「授权回调页」一字不差**，
 *      差一个斜杠、差 www、http/https 不同都会被判 redirect_uri_mismatch）
 *   3. 前端把 code 送到 POST /api/auth/weibo，这里拿 App Secret 换 access_token + uid，
 *      再签发本站 JWT
 *
 * App Secret 只在第 3 步用，绝不下发到浏览器 —— 前端全程只见得到一次性的 code。
 * redirect_uri 也一律以服务端配置为准，不采信请求体传上来的：这是签发身份的接口，
 * 能被外部摆布的参数越少越好。
 *
 * 和 Google 那条最大的不同：**微博拿不到邮箱**（开放平台早就不发 email 权限了）。
 * 所以账号以 weibo_uid 为唯一身份，email 列先填一个占位值占住 NOT NULL + UNIQUE；
 * 用户以后在个人中心换绑真实邮箱，weibo_uid 还在，下次微博登录仍然进同一个号。
 */
const WEIBO_AUTHORIZE = 'https://api.weibo.com/oauth2/authorize'
const WEIBO_TOKEN = 'https://api.weibo.com/oauth2/access_token'
const WEIBO_USER_SHOW = 'https://api.weibo.com/2/users/show.json'
/** 微博接口偶尔会挂住不返回。不设超时的话这个请求会一直占着连接，前端只看到「转圈」 */
const WEIBO_TIMEOUT_MS = 10000

function weiboConfig() {
  const appKey = (process.env.WEIBO_APP_KEY || '').trim()
  const appSecret = (process.env.WEIBO_APP_SECRET || '').trim()
  const site = (process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '')
  const redirectUri = (process.env.WEIBO_REDIRECT_URI || (site ? site + '/auth/weibo/callback' : '')).trim()
  return { appKey, appSecret, redirectUri }
}

/**
 * 微博的错误不一定是 JSON：限流和网关故障时会吐 HTML 错误页。
 * 直接 resp.json() 会抛 SyntaxError，被 next(e) 兜成 500 —— 真正的原因（比如
 * redirect_uri 填错）就此丢掉。所以先取 text，解析失败也把原文留给日志。
 */
async function weiboFetchJson(url, init) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(WEIBO_TIMEOUT_MS) })
  const text = await resp.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { ok: resp.ok, status: resp.status, data, text }
}

/** 占位邮箱。域名用 .invalid（RFC 2606 保留，永远不可能是真实邮箱），免得哪天真发信发出去 */
function weiboPlaceholderEmail(uid) {
  return `weibo_${uid}@weibo.invalid`
}

/** 按微博 uid 找到或创建账号。 */
async function findOrCreateByWeibo(uid, nickname) {
  const hit = await queryOne('SELECT * FROM users WHERE weibo_uid = ?', [uid])
  if (hit) return hit

  const email = weiboPlaceholderEmail(uid)
  /**
   * 占位邮箱已经在、但 weibo_uid 是空的：老库里手工建过，或者上一次建号建到一半。
   * 认领它而不是再插一条 —— 否则唯一索引会把这次登录顶掉，而用户永远登不进去。
   */
  const stale = await queryOne('SELECT * FROM users WHERE email = ?', [email])
  if (stale) {
    if (!stale.weibo_uid) await query('UPDATE users SET weibo_uid = ? WHERE id = ?', [uid, stale.id])
    return await queryOne('SELECT * FROM users WHERE id = ?', [stale.id])
  }

  const id = newId()
  const createdAt = new Date().toISOString().slice(0, 10)
  try {
    await query(
      'INSERT INTO users (id, email, nickname, avatar, password_hash, coins, role, status, created_at, weibo_uid) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, email, nickname, '🕹️', '', WELCOME_COINS, 'user', 'active', createdAt, uid],
    )
  } catch (e) {
    // 同一个人同时点了两次登录：两个请求都查不到、都来插。后到的这条撞唯一索引，
    // 直接把先建好的那条读回来就行，不该报错给用户看
    if (e?.code !== 'ER_DUP_ENTRY') throw e
    const raced = await queryOne('SELECT * FROM users WHERE weibo_uid = ?', [uid])
    if (raced) return raced
    throw e
  }
  return await queryOne('SELECT * FROM users WHERE id = ?', [id])
}

/**
 * 拼授权地址。放在服务端而不是前端自己拼，是为了让 redirect_uri 只有一处定义 ——
 * 两边各写一份，改域名时漏掉一个就是线上登录全挂，而且报错只在微博那一侧看得到。
 */
authRouter.get('/weibo/authorize-url', (req, res) => {
  const { appKey, appSecret, redirectUri } = weiboConfig()
  if (!appKey || !appSecret || !redirectUri) {
    return res.status(503).json({ error: '本站未配置微博登录（服务端缺少 WEIBO_APP_KEY / WEIBO_APP_SECRET）' })
  }
  const url = new URL(WEIBO_AUTHORIZE)
  url.searchParams.set('client_id', appKey)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  // state 由前端生成并存在 sessionStorage，回调页自己比对（防登录 CSRF）。
  // 服务端只做透传：它没有会话，存不住这个值，硬存反而要多一张表
  const state = String(req.query.state || '').slice(0, 64)
  if (state) url.searchParams.set('state', state)
  res.json({ url: url.toString() })
})

authRouter.post('/weibo', async (req, res, next) => {
  try {
    const { appKey, appSecret, redirectUri } = weiboConfig()
    if (!appKey || !appSecret || !redirectUri) {
      return res.status(503).json({ error: '本站未配置微博登录（服务端缺少 WEIBO_APP_KEY / WEIBO_APP_SECRET）' })
    }
    const code = String(req.body.code || '').trim()
    if (!code) return res.status(400).json({ error: '缺少微博授权码' })

    const tok = await weiboFetchJson(WEIBO_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appKey,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }).toString(),
    })
    const accessToken = String(tok.data?.access_token || '')
    const uid = String(tok.data?.uid || '')
    if (!accessToken || !uid) {
      // 原文只进服务端日志：里面可能带上 App Key 之类的回显，而且 code 用过即废，
      // 对用户来说唯一有用的动作就是重来一次
      console.warn('[weibo] 换 access_token 失败：', tok.status, tok.text.slice(0, 300))
      return res.status(401).json({ error: '微博授权失败，请重新登录' })
    }

    /**
     * 昵称是锦上添花：users/show.json 需要应用有相应权限，新应用、审核中的应用
     * 都可能直接返回错误。拿不到就退回「微博用户 xxxx」，不能因此把登录整个挡掉。
     */
    let nickname = ''
    try {
      const show = await weiboFetchJson(
        `${WEIBO_USER_SHOW}?access_token=${encodeURIComponent(accessToken)}&uid=${encodeURIComponent(uid)}`,
      )
      if (show.ok) nickname = String(show.data?.screen_name || show.data?.name || '').trim()
    } catch (e) {
      console.warn('[weibo] 取昵称失败（不影响登录）：', e?.message || e)
    }
    // 和 Google 那条一致，截到 16 —— 注册接口的昵称上限就是 16，两边不一致会让
    // 「改昵称」时莫名其妙报太长
    nickname = (nickname || '微博用户' + uid.slice(-4)).slice(0, 16)

    const row = await findOrCreateByWeibo(uid, nickname)
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id, tokenVersionOf(row)), user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

/** 用当前 token 换取用户信息（用于开机恢复登录态） */
authRouter.get('/me', requireUser, async (req, res, next) => {
  try {
    res.json(await publicWithData(req.user))
  } catch (e) {
    next(e)
  }
})
