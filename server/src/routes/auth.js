import { Router } from 'express'
import crypto from 'crypto'
import { query, queryOne } from '../db.js'
import { hashPassword, verifyPassword, signToken, requireUser } from '../auth.js'
import { userRowToPublic } from '../mappers.js'
import { favIds, recentIds } from '../userdata.js'
import { sendLoginCode } from '../mail.js'
import { take, clientKey, isMeaningfulIp } from '../rateLimit.js'

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
const codes = new Map() // email -> { code, expires, lastSent, tries }
const CODE_TTL = 10 * 60_000
const COOLDOWN = 60_000
/** 单个验证码最多能试几次。6 位数字共 100 万种，不限次数等于可以直接爆破进任意账号（含管理员）。 */
const MAX_TRIES = 5
/** Map 的条目上限。发送接口不需要登录，不设上限的话换邮箱刷几百万次就能把内存吃光。 */
const MAX_PENDING = 10_000

/* ---- 发信配额 ----
 * 原来只有「同一邮箱 60 秒一次」，挡得住重复点按钮，挡不住脚本轮着给一万个陌生邮箱发信。
 * 配上 SMTP 之后那就是架在你服务器上的垃圾邮件发射器，代价是域名被拉黑。
 *
 * 两道一起上，缺一不可：
 *   按 IP —— 正常用户一小时发不了十封；但它**只有在 trust proxy 配对时才准**，
 *            配错了所有人都算成反代那一个地址。
 *   全站 —— 不依赖任何代理配置，代理配错时这是唯一还有效的一道。
 * 都可以用环境变量调，多实例部署记得按实例数把上限除一下（状态在各自内存里）。
 */
const HOUR = 3_600_000
const SEND_PER_IP_PER_HOUR = Number(process.env.CODE_SEND_PER_IP_PER_HOUR || 10)
const SEND_GLOBAL_PER_HOUR = Number(process.env.CODE_SEND_GLOBAL_PER_HOUR || 500)
/** 拿不到真实 IP 的警告只打一次，不然每次发码都刷一行 */
let warnedNoRealIp = false

/** 清掉过期条目。每次发码时顺手做一遍，不额外起定时器。 */
function sweepCodes() {
  const now = Date.now()
  for (const [k, v] of codes) if (v.expires < now) codes.delete(k)
}

authRouter.post('/email/request-code', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })

    // 同一邮箱的冷却。retryAfter 一并回给前端 —— 以前只在文案里写秒数，
    // 前端拿不到数字，只能用它自己那份 60 秒常量倒计时，两边一改就对不上了。
    const rec = codes.get(email)
    if (rec && Date.now() - rec.lastSent < COOLDOWN) {
      const wait = Math.ceil((COOLDOWN - (Date.now() - rec.lastSent)) / 1000)
      return res.status(429).json({ error: `发送过于频繁，请 ${wait}s 后再试`, retryAfter: wait })
    }

    // 配额：先看这个 IP，再看全站。放在生成验证码之前 —— 被挡下来时不该产生任何副作用。
    //
    // ⚠️ 只有拿到真实访客 IP 时才按 IP 限。反代没透传时所有人都是 127.0.0.1，
    // 再按 IP 限就成了整站每小时 N 封的总闸，十几个人登录就能把其他人全锁在门外
    // （Cloudflare 在前面时尤其容易踩）。这种情况下只留全站那道兜底。
    const ip = clientKey(req)
    if (isMeaningfulIp(ip)) {
      const byIp = take(`code:ip:${ip}`, SEND_PER_IP_PER_HOUR, HOUR)
      if (!byIp.ok) {
        return res.status(429).json({ error: '发送次数过多，请稍后再试', retryAfter: byIp.retryAfter })
      }
    } else if (!warnedNoRealIp) {
      warnedNoRealIp = true
      console.warn(
        `[auth] 拿到的客户端地址是 ${ip}，按 IP 限流已跳过（只剩全站总量兜底）。` +
          ' 让 nginx 透传真实 IP 即可恢复：proxy_set_header X-Forwarded-For $http_cf_connecting_ip;',
      )
    }
    const global = take('code:global', SEND_GLOBAL_PER_HOUR, HOUR)
    if (!global.ok) {
      console.warn('[auth] 全站发信配额已用尽 —— 可能正在被刷，检查 nginx 是否透传了真实 IP')
      return res.status(429).json({ error: '当前请求过多，请稍后再试', retryAfter: global.retryAfter })
    }

    sweepCodes()
    if (!codes.has(email) && codes.size >= MAX_PENDING) {
      return res.status(429).json({ error: '当前请求过多，请稍后再试' })
    }
    const code = String(100000 + crypto.randomInt(900000))
    codes.set(email, { code, expires: Date.now() + CODE_TTL, lastSent: Date.now(), tries: 0 })
    await sendLoginCode(email, code)
    // 冷却秒数由服务端说了算，前端照着倒计时，不再各存一份常量
    res.json({ ok: true, cooldown: Math.round(COOLDOWN / 1000) })
  } catch (e) {
    next(e)
  }
})

authRouter.post('/email/verify', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const code = String(req.body.code || '').trim()
    const rec = codes.get(email)
    if (!rec || rec.expires < Date.now()) {
      codes.delete(email)
      return res.status(400).json({ error: '验证码已过期，请重新获取' })
    }
    if (rec.code !== code) {
      // 错一次就减一次机会，用完直接作废这个验证码 —— 否则可以慢慢把 6 位数字试穿
      rec.tries += 1
      if (rec.tries >= MAX_TRIES) {
        codes.delete(email)
        return res.status(429).json({ error: '错误次数过多，请重新获取验证码' })
      }
      return res.status(400).json({ error: '验证码不正确' })
    }
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
