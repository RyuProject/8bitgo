/**
 * 邮箱验证码状态机的回归测试（src/codes.js）。
 *
 *   cd server && npm run test:codes
 *
 * 需要能连上数据库（.env 的 DB_*）+ login_codes 表已建好；连不上就整体跳过，
 * 不当失败 —— 这个脚本要能在没开 SSH 隧道的机器上跑 `npm test` 而不炸。
 *
 * 发信不出网：用一个本地 mock 顶替 Resend，验证码从请求体里读回来。
 * 这是唯一能拿到「服务端真正生成的那串数字」的办法 —— 换成自己造一个码去验，
 * 测的就不是真实链路了。
 *
 * 重点测三件线上最要命、又最不容易在手点时发现的事：
 *   1. 错 5 次之后验证码必须作废（否则 6 位数字可以慢慢试穿，包括管理员账号）
 *   2. 冷却是服务端说了算，且会把 retryAfter 带出来
 *   3. 换绑 / 注销的码绑定了用户 id —— 不绑的话 A 能拿自己的码去动 B 的账号
 */
import 'dotenv/config'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

/* ---- 本地 mock 顶替 Resend，顺手把验证码截下来 ---- */
let lastCode = null
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    lastCode = (String(body.text || '').match(/\b(\d{6})\b/) || [])[1] || null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'mail_test' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.RESEND_API_KEY = 're_test_key'
process.env.RESEND_API_BASE = `http://127.0.0.1:${server.address().port}`
process.env.MAIL_FROM = 'noreply@8bitgo.com'
delete process.env.CF_ACCOUNT_ID
delete process.env.SMTP_HOST

const { query } = await import('../src/db.js')
const { ping } = await import('../src/db.js')

if (!(await ping().catch(() => false))) {
  console.log('⏭  连不上数据库，整体跳过（先开 SSH 隧道或改 .env 的 DB_*）')
  server.close()
  process.exit(0)
}
try {
  await query('SELECT 1 FROM login_codes LIMIT 1')
} catch (e) {
  if (e?.code === 'ER_NO_SUCH_TABLE') {
    console.log('⏭  还没有 login_codes 表，整体跳过 —— 先跑 npm run migrate')
    server.close()
    process.exit(0)
  }
  throw e
}

const { issueCode, verifyCode, CodeError, MAX_TRIES } = await import('../src/codes.js')

let failed = 0
const ok = (n) => console.log(`  ✅ ${n}`)
const bad = (n, e) => {
  failed++
  console.error(`  ❌ ${n}\n     ${e?.message || e}`)
}

/** 每个用例用自己的邮箱，互相不会被冷却挡住 */
const mail = (tag) => `codes-test-${tag}-${Date.now()}@example.invalid`
/** 不同用例用不同 IP，避免撞上「同一 IP 每小时 10 封」 */
let ipN = 0
const req = () => ({ ip: `203.0.113.${(ipN++ % 250) + 1}` })
const cleanup = (email) => query('DELETE FROM login_codes WHERE email = ?', [email])

/** 期望抛 CodeError，返回它好继续断言 status / retryAfter */
async function throws(fn) {
  try {
    await fn()
  } catch (e) {
    if (e instanceof CodeError) return e
    throw e
  }
  throw new Error('本该抛 CodeError，结果成功了')
}

console.log('验证码状态机：')

try {
  const email = mail('happy')
  const { cooldown } = await issueCode(req(), email, 'login')
  assert.ok(cooldown > 0, '应该回一个冷却秒数给前端倒计时')
  assert.match(String(lastCode), /^\d{6}$/, '没从信里读到 6 位验证码')
  // 落库的必须是哈希，不是明文 —— 一次 mysqldump 就是所有人的账号
  const row = await query('SELECT code_hash FROM login_codes WHERE email = ? AND purpose = ?', [email, 'login'])
  assert.equal(row[0].code_hash.length, 64, 'code_hash 应该是 sha256 的 64 位十六进制')
  assert.ok(!row[0].code_hash.includes(lastCode), '库里存了明文验证码')
  await verifyCode(email, 'login', lastCode)
  // 验过就该消费掉，同一个码不能用两次
  const again = await throws(() => verifyCode(email, 'login', lastCode))
  assert.equal(again.status, 400)
  await cleanup(email)
  ok('发码 → 落哈希 → 验码通过 → 一次性消费')
} catch (e) {
  bad('发码 → 落哈希 → 验码通过 → 一次性消费', e)
}

try {
  const email = mail('cooldown')
  await issueCode(req(), email, 'login')
  const e = await throws(() => issueCode(req(), email, 'login'))
  assert.equal(e.status, 429)
  assert.ok(Number(e.extra.retryAfter) > 0, '429 必须带 retryAfter，前端要靠它倒计时')
  await cleanup(email)
  ok('同一邮箱冷却内再发 → 429 + retryAfter')
} catch (e) {
  bad('同一邮箱冷却内再发 → 429 + retryAfter', e)
}

try {
  const email = mail('brute')
  await issueCode(req(), email, 'login')
  const real = lastCode
  // 前 MAX_TRIES-1 次错误只是「不正确」，最后一次直接作废整个码
  for (let i = 1; i < MAX_TRIES; i++) {
    const e = await throws(() => verifyCode(email, 'login', '000000'))
    assert.equal(e.status, 400, `第 ${i} 次错误应该还是 400`)
  }
  const last = await throws(() => verifyCode(email, 'login', '000000'))
  assert.equal(last.status, 429, '用完次数应该回 429')
  // ⚠️ 这一条是重点：作废之后**正确的码也不能再用**，否则前面的次数限制形同虚设
  const afterBurn = await throws(() => verifyCode(email, 'login', real))
  assert.equal(afterBurn.status, 400)
  await cleanup(email)
  ok(`错 ${MAX_TRIES} 次后验证码作废，正确的码也失效`)
} catch (e) {
  bad(`错 ${MAX_TRIES} 次后验证码作废`, e)
}

try {
  const email = mail('expire')
  await issueCode(req(), email, 'login')
  await query('UPDATE login_codes SET expires_at = 1 WHERE email = ?', [email])
  const e = await throws(() => verifyCode(email, 'login', lastCode))
  assert.equal(e.status, 400)
  const left = await query('SELECT 1 AS x FROM login_codes WHERE email = ?', [email])
  assert.equal(left.length, 0, '过期的记录应该被顺手删掉')
  await cleanup(email)
  ok('过期的码被拒绝并清理')
} catch (e) {
  bad('过期的码被拒绝并清理', e)
}

try {
  const email = mail('bind')
  await issueCode(req(), email, 'bind', 'u_owner')
  // 别人拿着同一封信里的码来用 —— 必须拒绝，否则 A 能把 B 的账号换绑到自己邮箱
  const e = await throws(() => verifyCode(email, 'bind', lastCode, 'u_attacker'))
  assert.equal(e.status, 400)
  await cleanup(email)
  ok('换绑码绑定了用户 id，换个人用不了')
} catch (e) {
  bad('换绑码绑定了用户 id，换个人用不了', e)
}

try {
  const email = mail('purpose')
  await issueCode(req(), email, 'login')
  // 用途也要绑：登录码不能拿去当注销确认码
  const e = await throws(() => verifyCode(email, 'delete', lastCode, 'u_owner'))
  assert.equal(e.status, 400)
  await cleanup(email)
  ok('登录码不能当注销码用（哈希拌了 purpose）')
} catch (e) {
  bad('登录码不能当注销码用', e)
}

server.close()
const { pool } = await import('../src/db.js')
await pool.end()
console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过')
process.exit(failed ? 1 : 0)
