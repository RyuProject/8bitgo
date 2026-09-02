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

/** 用当前 token 换取用户信息（用于开机恢复登录态） */
authRouter.get('/me', requireUser, async (req, res, next) => {
  try {
    res.json(await publicWithData(req.user))
  } catch (e) {
    next(e)
  }
})
