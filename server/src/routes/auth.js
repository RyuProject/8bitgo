import { Router } from 'express'
import crypto from 'crypto'
import { query, queryOne } from '../db.js'
import { hashPassword, verifyPassword, signToken, requireUser } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds } from '../userdata.js'
import { sendLoginCode } from '../mail.js'

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
    res.json({ token: signToken(id), user: await publicWithData(row) })
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
    const ok = await verifyPassword(password, row.password_hash)
    if (!ok) return res.status(401).json({ error: '邮箱或密码不正确' })
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id), user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- 邮箱验证码登录 ---------------- */
// 验证码暂存在内存（单进程足够；多实例部署请改用 Redis / 数据表）。
const codes = new Map() // email -> { code, expires, lastSent }
const CODE_TTL = 10 * 60_000
const COOLDOWN = 60_000

authRouter.post('/email/request-code', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })
    const rec = codes.get(email)
    if (rec && Date.now() - rec.lastSent < COOLDOWN) {
      const wait = Math.ceil((COOLDOWN - (Date.now() - rec.lastSent)) / 1000)
      return res.status(429).json({ error: `发送过于频繁，请 ${wait}s 后再试` })
    }
    const code = String(100000 + crypto.randomInt(900000))
    codes.set(email, { code, expires: Date.now() + CODE_TTL, lastSent: Date.now() })
    await sendLoginCode(email, code)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

authRouter.post('/email/verify', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const code = String(req.body.code || '').trim()
    const rec = codes.get(email)
    if (!rec || rec.expires < Date.now()) return res.status(400).json({ error: '验证码已过期，请重新获取' })
    if (rec.code !== code) return res.status(400).json({ error: '验证码不正确' })
    codes.delete(email)
    const row = await findOrCreateByEmail(email, nicknameFromEmail(email))
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id), user: await publicWithData(row) })
  } catch (e) {
    next(e)
  }
})

/* ---------------- Google 登录 ---------------- */
// 前端用 Google Identity Services 拿到 ID token（credential），这里校验后签发本站 JWT。
authRouter.post('/google', async (req, res, next) => {
  try {
    const credential = String(req.body.credential || '')
    if (!credential) return res.status(400).json({ error: '缺少 Google 凭证' })
    const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential))
    if (!resp.ok) return res.status(401).json({ error: 'Google 凭证无效' })
    const info = await resp.json()
    const clientId = process.env.GOOGLE_CLIENT_ID || ''
    if (clientId && info.aud !== clientId) return res.status(401).json({ error: 'Google 凭证与本站不匹配' })
    if (info.email_verified === 'false' || info.email_verified === false) {
      return res.status(401).json({ error: 'Google 邮箱未验证' })
    }
    const email = String(info.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(401).json({ error: '无法获取 Google 邮箱' })
    const nickname = String(info.name || nicknameFromEmail(email)).slice(0, 16)
    const row = await findOrCreateByEmail(email, nickname)
    if (row.status === 'banned') return res.status(403).json({ error: '该账号已被封禁，请联系管理员' })
    res.json({ token: signToken(row.id), user: await publicWithData(row) })
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
