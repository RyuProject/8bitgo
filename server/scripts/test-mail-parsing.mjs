/**
 * 发信返回体解析的回归测试 —— 不联网，起一个本地 mock 顶替 Cloudflare 的接口。
 *
 *   node scripts/test-mail-parsing.mjs
 *
 * 测的是 src/mail.js 里最容易出错、又最难在线上复现的那几条分支：
 *
 *   ⚠️ 最关键的一条：Cloudflare 对**硬退信**返回的是 HTTP 200 + success:true，
 *      收件地址在 result.permanent_bounces 里。只看状态码的话这会被当成发送成功，
 *      用户对着一封永远不会到的邮件干等十分钟 —— 线上几乎不可能注意到，
 *      因为服务器日志里一切正常。
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

/** mock 下一次要返回什么，由每个用例设置 */
let next = { status: 200, body: {} }
let lastRequest = null

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    lastRequest = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') }
    res.writeHead(next.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(next.body))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

process.env.CF_ACCOUNT_ID = 'acct_test'
process.env.CF_EMAIL_TOKEN = 'tok_test'
process.env.MAIL_FROM = 'noreply@8bitgo.com'
process.env.MAIL_FROM_NAME = '8BitGo'
process.env.MAIL_TIMEOUT_MS = '3000'
process.env.CF_API_BASE = `http://127.0.0.1:${PORT}/client/v4`
// 确保不会误走 SMTP 分支
delete process.env.SMTP_HOST
delete process.env.SMTP_USER

const { sendLoginCode, mailProvider } = await import('../src/mail.js')

let failed = 0
const ok = (name) => console.log(`  ✅ ${name}`)
const bad = (name, e) => {
  failed++
  console.error(`  ❌ ${name}\n     ${e?.message || e}`)
}

/** 跑一个用例：设置 mock 返回，调 sendLoginCode，断言结果 */
async function testCase(name, mock, expectKind) {
  next = mock
  try {
    await sendLoginCode('player@example.com', '123456')
    if (expectKind === null) return ok(name)
    bad(name, new Error(`本该抛 kind=${expectKind}，结果发送成功了`))
  } catch (e) {
    if (expectKind === null) return bad(name, e)
    if (e?.kind === expectKind) return ok(name)
    bad(name, new Error(`kind 应为 ${expectKind}，实际 ${e?.kind}（${e?.message}）`))
  }
}

console.log(`通路判定：${mailProvider()}（应为 cloudflare）`)
assert.equal(mailProvider(), 'cloudflare')

console.log('\n发送成功的情形：')
await testCase(
  '200 + delivered 命中 -> 成功',
  { status: 200, body: { success: true, errors: [], result: { delivered: ['player@example.com'], permanent_bounces: [], queued: [] } } },
  null,
)
await testCase(
  '200 + queued 命中 -> 成功（入队也算发出去了）',
  { status: 200, body: { success: true, errors: [], result: { delivered: [], permanent_bounces: [], queued: ['player@example.com'] } } },
  null,
)

console.log('\n失败的情形：')
await testCase(
  '200 + success:true 但落在 permanent_bounces -> suppressed（不能当成功）',
  { status: 200, body: { success: true, errors: [], result: { delivered: [], permanent_bounces: ['player@example.com'], queued: [] } } },
  'suppressed',
)
await testCase(
  'E_RECIPIENT_SUPPRESSED -> suppressed',
  { status: 400, body: { success: false, errors: [{ code: 'E_RECIPIENT_SUPPRESSED', message: 'recipient suppressed' }] } },
  'suppressed',
)
await testCase(
  'E_SENDER_NOT_VERIFIED -> sender（发件域没 onboarding）',
  { status: 403, body: { success: false, errors: [{ code: 'E_SENDER_NOT_VERIFIED', message: 'sender not verified' }] } },
  'sender',
)
await testCase(
  'E_DAILY_LIMIT_EXCEEDED -> ratelimit',
  { status: 429, body: { success: false, errors: [{ code: 'E_DAILY_LIMIT_EXCEEDED', message: 'daily limit' }] } },
  'ratelimit',
)
await testCase('REST 限流码 10004 -> ratelimit', { status: 429, body: { success: false, errors: [{ code: 10004, message: 'throttled' }] } }, 'ratelimit')
await testCase('401 无错误码 -> sender（Token 不对）', { status: 401, body: { success: false, errors: [] } }, 'sender')
await testCase(
  '200 但既没接收也没退回 -> unknown（不装作成功）',
  { status: 200, body: { success: true, errors: [], result: { delivered: [], permanent_bounces: [], queued: [] } } },
  'unknown',
)
await testCase('500 + 非 JSON 响应体 -> unknown（不能崩在 res.json()）', { status: 500, body: null }, 'unknown')

console.log('\n请求本身：')
try {
  next = { status: 200, body: { success: true, errors: [], result: { delivered: ['player@example.com'] } } }
  await sendLoginCode('player@example.com', '654321')
  assert.equal(lastRequest.auth, 'Bearer tok_test', 'Authorization 头不对')
  assert.ok(lastRequest.url.endsWith('/accounts/acct_test/email/sending/send'), `路径不对：${lastRequest.url}`)
  assert.deepEqual(lastRequest.body.from, { email: 'noreply@8bitgo.com', name: '8BitGo' }, 'from 字段不对')
  assert.equal(lastRequest.body.to, 'player@example.com')
  assert.ok(lastRequest.body.text.includes('654321'), '正文里没有验证码')
  assert.ok(lastRequest.body.html.includes('654321'), 'HTML 里没有验证码')
  ok('URL / Authorization / from / to / 正文都对')
} catch (e) {
  bad('请求体检查', e)
}

console.log('\n网络故障：')
try {
  // 指到一个没人监听的端口，验证超时/拒连被归成可重试的 network，而不是 unknown
  process.env.CF_API_BASE = 'http://127.0.0.1:1/client/v4'
  await sendLoginCode('player@example.com', '111111')
  bad('连不上 -> network', new Error('本该抛错'))
} catch (e) {
  e?.kind === 'network' ? ok('连不上 -> network（可重试，不和 unknown 混）') : bad('连不上 -> network', e)
}

server.close()
console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 个用例未通过`)
process.exit(failed === 0 ? 0 : 1)
