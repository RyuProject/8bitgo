/**
 * 邮箱验证码：签发、发信、校验、限流。
 *
 * 为什么单独一个模块：验证码不再只给「登录」用了 —— 换绑邮箱、注销账号都要发一封码，
 * 而这三处需要的冷却、发信配额、爆破防护完全一样。之前这套逻辑长在 routes/auth.js 里，
 * 再抄两遍必然会漏掉其中一道（最可能漏的是「发信失败要把刚写下的码撤掉」）。
 *
 * ── 为什么存数据库而不是内存 ──
 * 原来验证码放在一个模块级 Map 里。单进程时能用，但有两个真实的坑：
 *   1. `pm2 restart` / 部署重启会把所有待验证的码清空 —— 用户刚收到信，回来填却被告知
 *      「验证码已过期，请重新获取」。
 *   2. 将来这个服务多开几个实例（或者搬去 Cloudflare），发码的实例和验码的实例不是同一个，
 *      登录会随机失败一半。
 * 所以落到 MySQL 的 login_codes 表。表还没建时（老库没跑 migrate）自动退回内存版，
 * 只在日志里喊一声 —— 缺一张表不该让整站登录不了。
 *
 * ── 为什么存哈希而不是明文 ──
 * 明文存着，任何能看到这张表的人（一次 mysqldump、一条注入、一个开着的运维面板）
 * 就能在 10 分钟内登进任意邮箱，包括管理员。哈希里拌上 email + purpose：
 * 单看哈希值没法拿去别的邮箱或者别的用途上重放。
 */
import crypto from 'crypto'
import { query, queryOne } from './db.js'
import { sendLoginCode } from './mail.js'
import { take, clientKey, isMeaningfulIp } from './rateLimit.js'

/** 验证码有效期 */
export const CODE_TTL_MS = 10 * 60_000
/** 同一个（邮箱 + 用途）再次发送的冷却 */
export const COOLDOWN_MS = 60_000
/** 单个验证码最多能试几次。6 位数字共 100 万种，不限次数等于可以直接爆破进任意账号（含管理员） */
export const MAX_TRIES = 5
/** 内存兜底版的条目上限。发送接口不需要登录，不设上限的话换邮箱刷几百万次就能把内存吃光 */
const MAX_PENDING = 10_000

/* ---- 发信配额 ----
 * 三种用途共用同一份额度 —— 限的是「这台服务器往外发了多少信」，
 * 按用途各给一份等于把总量翻三倍，域名照样会被拉黑。
 *
 * 两道一起上，缺一不可：
 *   按 IP —— 正常用户一小时发不了十封；但它**只有在 trust proxy 配对时才准**，
 *            配错了所有人都算成反代那一个地址。
 *   全站 —— 不依赖任何代理配置，代理配错时这是唯一还有效的一道。
 * 多实例部署记得按实例数把上限除一下（状态在各自内存里）。
 */
const HOUR = 3_600_000
const SEND_PER_IP_PER_HOUR = Number(process.env.CODE_SEND_PER_IP_PER_HOUR || 10)
const SEND_GLOBAL_PER_HOUR = Number(process.env.CODE_SEND_GLOBAL_PER_HOUR || 500)
/** 拿不到真实 IP 的警告只打一次，不然每次发码都刷一行 */
let warnedNoRealIp = false

/** 带 HTTP 状态码的验证码错误。路由层用 sendCodeError 直接翻成响应 */
export class CodeError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.name = 'CodeError'
    this.status = status
    this.extra = extra
  }
}

/* ------------------------------------------------------------------ */
/*  存储：MySQL 优先，缺表时退回内存                                    */
/* ------------------------------------------------------------------ */

/** null = 还没试过 */
let useDb = null
/** 内存兜底。key = `${purpose}:${email}` */
const mem = new Map()

function memKey(email, purpose) {
  return `${purpose}:${email}`
}

/** 表不存在。老库没跑 migrate 时就是这个错，不该当成故障 */
function isNoTable(e) {
  return e?.code === 'ER_NO_SUCH_TABLE' || /login_codes.*doesn't exist/i.test(e?.message || '')
}

function fallback(e) {
  if (!isNoTable(e)) throw e
  if (useDb !== false) {
    useDb = false
    console.warn(
      '[codes] login_codes 表不存在，验证码退回内存存储（重启会丢、多实例会对不上）。' +
        ' 补法：cd server && npm run migrate',
    )
  }
  return null
}

/**
 * 验证码的哈希。拌上 email + purpose，
 * 这样一条哈希只在「这个邮箱的这个用途」上成立，拿不去别处重放。
 */
function hashCode(email, purpose, code) {
  return crypto.createHash('sha256').update(`${email} ${purpose} ${code}`).digest('hex')
}

/** 定长十六进制串的恒定时间比较。用 === 比的话，比较耗时会泄露前缀对了几位 */
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

async function readRec(email, purpose) {
  if (useDb !== false) {
    try {
      const row = await queryOne(
        'SELECT user_id, code_hash, tries, expires_at, sent_at FROM login_codes WHERE email = ? AND purpose = ?',
        [email, purpose],
      )
      useDb = true
      if (!row) return null
      return {
        userId: row.user_id || null,
        hash: row.code_hash,
        tries: Number(row.tries),
        expires: Number(row.expires_at),
        sentAt: Number(row.sent_at),
      }
    } catch (e) {
      fallback(e)
    }
  }
  return mem.get(memKey(email, purpose)) ?? null
}

async function writeRec(email, purpose, rec) {
  if (useDb !== false) {
    try {
      await query(
        `INSERT INTO login_codes (email, purpose, user_id, code_hash, tries, expires_at, sent_at)
              VALUES (?, ?, ?, ?, 0, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), code_hash = VALUES(code_hash),
                                 tries = 0, expires_at = VALUES(expires_at), sent_at = VALUES(sent_at)`,
        [email, purpose, rec.userId, rec.hash, rec.expires, rec.sentAt],
      )
      useDb = true
      return
    } catch (e) {
      fallback(e)
    }
  }
  // 只有内存兜底才需要自己限条目数：数据库那边主键是 (email, purpose)，
  // 涨得再多也有发信配额和下面的 sweep 兜着
  if (!mem.has(memKey(email, purpose)) && mem.size >= MAX_PENDING) {
    throw new CodeError(429, '当前请求过多，请稍后再试')
  }
  mem.set(memKey(email, purpose), { ...rec, tries: 0 })
}

async function dropRec(email, purpose) {
  if (useDb !== false) {
    try {
      await query('DELETE FROM login_codes WHERE email = ? AND purpose = ?', [email, purpose])
      useDb = true
      return
    } catch (e) {
      fallback(e)
    }
  }
  mem.delete(memKey(email, purpose))
}

/** 错一次减一次机会，返回累计错误次数 */
async function bumpTries(email, purpose, rec) {
  if (useDb !== false) {
    try {
      await query('UPDATE login_codes SET tries = tries + 1 WHERE email = ? AND purpose = ?', [email, purpose])
      const row = await queryOne('SELECT tries FROM login_codes WHERE email = ? AND purpose = ?', [email, purpose])
      useDb = true
      return Number(row?.tries ?? rec.tries + 1)
    } catch (e) {
      fallback(e)
    }
  }
  const m = mem.get(memKey(email, purpose))
  if (!m) return MAX_TRIES
  m.tries += 1
  return m.tries
}

/** 清掉过期条目。每次发码时顺手做一遍，不额外起定时器。 */
async function sweep() {
  const now = Date.now()
  if (useDb !== false) {
    try {
      await query('DELETE FROM login_codes WHERE expires_at < ?', [now])
      useDb = true
    } catch (e) {
      fallback(e)
    }
  }
  for (const [k, v] of mem) if (v.expires < now) mem.delete(k)
}

/* ------------------------------------------------------------------ */
/*  签发                                                               */
/* ------------------------------------------------------------------ */

/**
 * 发一封验证码邮件。成功返回 { cooldown }（秒，前端照着倒计时）。
 *
 * 冷却秒数由服务端说了算 —— 两边各存一份常量的话，改了一边就会出现
 * 「按钮已经可以点了，服务端还在 429」这种对不上的情况。
 *
 * @param {import('express').Request} req 取客户端 IP 用
 * @param {string} email   收件地址（已 trim + 小写）
 * @param {'login'|'bind'|'delete'} purpose
 * @param {string|null} [userId] 换绑 / 注销时绑定到这个用户，校验时必须对得上
 */
export async function issueCode(req, email, purpose, userId = null) {
  // 1. 同一个（邮箱 + 用途）的冷却。retryAfter 一并回给前端 ——
  //    以前只在文案里写秒数，前端拿不到数字，只能用它自己那份 60 秒常量倒计时。
  const rec = await readRec(email, purpose)
  if (rec && Date.now() - rec.sentAt < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - rec.sentAt)) / 1000)
    throw new CodeError(429, `发送过于频繁，请 ${wait}s 后再试`, { retryAfter: wait })
  }

  /* 2. 配额：先看这个 IP，再看全站。放在生成验证码之前 —— 被挡下来时不该产生任何副作用。
   *
   * ⚠️ 只有拿到真实访客 IP 时才按 IP 限。反代没透传时所有人都是 127.0.0.1，
   * 再按 IP 限就成了整站每小时 N 封的总闸，十几个人登录就能把其他人全锁在门外
   * （Cloudflare 在前面时尤其容易踩）。这种情况下只留全站那道兜底。
   */
  const ip = clientKey(req)
  if (isMeaningfulIp(ip)) {
    const byIp = take(`code:ip:${ip}`, SEND_PER_IP_PER_HOUR, HOUR)
    if (!byIp.ok) throw new CodeError(429, '发送次数过多，请稍后再试', { retryAfter: byIp.retryAfter })
  } else if (!warnedNoRealIp) {
    warnedNoRealIp = true
    console.warn(
      `[codes] 拿到的客户端地址是 ${ip}，按 IP 限流已跳过（只剩全站总量兜底）。` +
        ' 让 nginx 透传真实 IP 即可恢复：proxy_set_header X-Forwarded-For $http_cf_connecting_ip;',
    )
  }
  const global = take('code:global', SEND_GLOBAL_PER_HOUR, HOUR)
  if (!global.ok) {
    console.warn('[codes] 全站发信配额已用尽 —— 可能正在被刷，检查 nginx 是否透传了真实 IP')
    throw new CodeError(429, '当前请求过多，请稍后再试', { retryAfter: global.retryAfter })
  }

  await sweep()

  const code = String(100000 + crypto.randomInt(900000))
  const now = Date.now()
  await writeRec(email, purpose, {
    userId,
    hash: hashCode(email, purpose, code),
    expires: now + CODE_TTL_MS,
    sentAt: now,
  })

  /**
   * 发信失败必须把刚写进去的验证码撤掉。
   *
   * 早先这里是裸 await，异常一路冒到 Express 的兜底处理器变成一句「服务器内部错误」——
   * 而记录还在，sentAt 也已经打上了。结果是用户既收不到信，又被冷却挡在门外一分钟，
   * 重试还是同样一句没用的报错。
   *
   * 顺带按失败原因分开回：地址收不了信是用户能自己解决的（换一个邮箱），
   * 配额和配置问题是我们自己的事，别让用户以为是他填错了。
   */
  try {
    await sendLoginCode(email, code, purpose)
  } catch (e) {
    await dropRec(email, purpose)
    switch (e?.kind) {
      case 'suppressed':
        // 这个地址退过信 / 被标过垃圾邮件，再发多少次都不会到
        throw new CodeError(400, '这个邮箱地址无法投递，请换一个邮箱')
      case 'ratelimit':
        console.error('[codes] 发信服务配额已用尽：', e.message)
        throw new CodeError(429, '当前发信繁忙，请稍后再试', { retryAfter: 60 })
      case 'sender':
        // 发件域没验证、密钥没权限、依赖没装 —— 都是部署问题。
        // 细节只进日志：回给客户端等于把配置状况告诉所有人。
        console.error('[codes] 发信配置有问题：', e.message)
        throw new CodeError(500, '邮件服务暂时不可用，请稍后再试')
      default:
        console.error('[codes] 验证码邮件发送失败：', e)
        throw new CodeError(502, '邮件发送失败，请稍后再试')
    }
  }

  return { cooldown: Math.round(COOLDOWN_MS / 1000) }
}

/* ------------------------------------------------------------------ */
/*  校验                                                               */
/* ------------------------------------------------------------------ */

/**
 * 校验并**消费**一个验证码。通过就直接返回，不通过抛 CodeError。
 *
 * @param {string} email
 * @param {'login'|'bind'|'delete'} purpose
 * @param {string} code
 * @param {string|null} [userId] 签发时绑过用户的话必须对得上 —— 否则 A 能拿自己那封
 *                               「换绑到 x@y」的码，去把 B 的账号换绑成 x@y
 */
export async function verifyCode(email, purpose, code, userId = null) {
  if (!/^\d{6}$/.test(String(code || '').trim())) {
    throw new CodeError(400, '验证码是 6 位数字')
  }
  const rec = await readRec(email, purpose)
  if (!rec || rec.expires < Date.now()) {
    await dropRec(email, purpose)
    throw new CodeError(400, '验证码已过期，请重新获取')
  }
  // 签发时绑了用户，校验时就必须是同一个人
  if (rec.userId && rec.userId !== userId) {
    await dropRec(email, purpose)
    throw new CodeError(400, '验证码与当前账号不匹配，请重新获取')
  }
  if (!sameHash(rec.hash, hashCode(email, purpose, String(code).trim()))) {
    const tries = await bumpTries(email, purpose, rec)
    // 用完机会直接作废这个验证码 —— 否则可以慢慢把 6 位数字试穿
    if (tries >= MAX_TRIES) {
      await dropRec(email, purpose)
      throw new CodeError(429, '错误次数过多，请重新获取验证码')
    }
    throw new CodeError(400, '验证码不正确')
  }
  await dropRec(email, purpose)
}

/** 把 CodeError 翻成 HTTP 响应；不是 CodeError 就交回给 Express 的兜底处理器 */
export function sendCodeError(res, next, e) {
  if (e instanceof CodeError) return res.status(e.status).json({ error: e.message, ...e.extra })
  return next(e)
}
