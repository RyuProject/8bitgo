/**
 * Resend 发信通路的回归测试 —— 不联网，起一个本地 mock 顶替 api.resend.com。
 *
 *   node scripts/test-mail-resend.mjs        （或 npm run test:mail:resend）
 *
 * 测的是 src/mail.js 里那几条「线上很难复现、但一定会遇到」的分支：
 *
 *   ⚠️ 最关键的一条：403 既可能是「发件域没在 Resend 验证」，也可能是「收件地址不合法」。
 *      两者回给用户的提示完全相反 —— 前者叫他换邮箱是白费功夫（换多少个都发不出去），
 *      后者告诉他「邮件服务不可用」会让他一直等一封根本不会发出的信。
 *      所以 kind 必须分对。
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

/** mock 下一次要返回什么，由每个用例设置 */
let next = { status: 200, body: { id: 'mail_1' } }
let lastRequest = null

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    lastRequest = { url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(raw || '{}') }
    res.writeHead(next.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(next.body))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

process.env.RESEND_API_KEY = 're_test_key'
process.env.MAIL_FROM = 'noreply@8bitgo.com'
process.env.MAIL_FROM_NAME = '8BitGo'
process.env.MAIL_TIMEOUT_MS = '3000'
process.env.RESEND_API_BASE = `http://127.0.0.1:${PORT}`
// 别的通路一律关掉，否则本机 .env 里配了什么就测什么
delete process.env.CF_ACCOUNT_ID
delete process.env.CF_EMAIL_TOKEN
delete process.env.SMTP_HOST
delete process.env.SMTP_USER

const { sendLoginCode, mailProvider } = await import('../src/mail.js')

let failed = 0
const ok = (name) => console.log(`  ✅ ${name}`)
const bad = (name, e) => {
  failed++
  console.error(`  ❌ ${name}\n     ${e?.message || e}`)
}

/** 跑一个用例：设置 mock 返回，调 sendLoginCode，断言 kind（null = 期望成功） */
async function testCase(name, mock, expectKind, purpose = 'login') {
  next = mock
  try {
    await sendLoginCode('player@example.com', '123456', purpose)
    if (expectKind === null) return ok(name)
    bad(name, new Error(`本该抛 kind=${expectKind}，结果发送成功了`))
  } catch (e) {
    if (expectKind === null) return bad(name, e)
    if (e?.kind === expectKind) return ok(name)
    bad(name, new Error(`kind 应为 ${expectKind}，实际是 ${e?.kind}（${e?.message}）`))
  }
}

console.log('Resend 通路：')
assert.equal(mailProvider(), 'resend', 'RESEND_API_KEY 配了却没走 Resend —— 优先级判断有问题')
ok('配了 RESEND_API_KEY 时 mailProvider() 是 resend')

console.log('\n返回体分类：')
await testCase('2xx + id = 发送成功', { status: 200, body: { id: 'mail_ok' } }, null)

await testCase(
  '2xx 但没有 id → unknown（不能当成发出去了）',
  { status: 200, body: {} },
  'unknown',
)

await testCase(
  '403 发件域没验证 → sender（部署问题，别叫用户换邮箱）',
  {
    status: 403,
    body: { statusCode: 403, name: 'validation_error', message: 'The 8bitgo.com domain is not verified.' },
  },
  'sender',
)

await testCase(
  '403 试用发件地址只能发给自己 → sender',
  {
    status: 403,
    body: {
      statusCode: 403,
      name: 'validation_error',
      message: 'You can only send testing emails to your own email address (owner@example.com).',
    },
  },
  'sender',
)

await testCase(
  '401 密钥不对 → sender',
  { status: 401, body: { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' } },
  'sender',
)

await testCase(
  '422 收件地址不合法 → suppressed（这个用户换个邮箱就好了）',
  {
    status: 422,
    body: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field. Please use a valid email address.' },
  },
  'suppressed',
)

await testCase(
  '429 限流 → ratelimit',
  { status: 429, body: { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' } },
  'ratelimit',
)

await testCase(
  '每日额度用尽 → ratelimit',
  { status: 429, body: { statusCode: 429, name: 'daily_quota_exceeded', message: 'Daily quota reached' } },
  'ratelimit',
)

await testCase(
  '500 → unknown（可以重试）',
  { status: 500, body: { statusCode: 500, name: 'internal_server_error', message: 'boom' } },
  'unknown',
)

console.log('\n请求内容：')
try {
  next = { status: 200, body: { id: 'mail_2' } }
  await sendLoginCode('player@example.com', '654321')
  assert.equal(lastRequest.method, 'POST')
  assert.equal(lastRequest.auth, 'Bearer re_test_key', 'Authorization 头不对')
  assert.ok(lastRequest.url.endsWith('/emails'), `路径不对：${lastRequest.url}`)
  assert.equal(lastRequest.body.from, '8BitGo <noreply@8bitgo.com>', 'from 字段不对')
  // Resend 的 to 收数组。给字符串它也认，但数组才是文档写的形式，别在这上面赌运气
  assert.deepEqual(lastRequest.body.to, ['player@example.com'], 'to 应该是数组')
  assert.ok(lastRequest.body.text.includes('654321'), '正文里没有验证码')
  assert.ok(lastRequest.body.html.includes('654321'), 'HTML 里没有验证码')
  ok('请求体字段与 Resend 接口一致')
} catch (e) {
  bad('请求体字段与 Resend 接口一致', e)
}

console.log('\n三种用途的文案要能分辨：')
try {
  const subjects = {}
  for (const purpose of ['login', 'bind', 'delete']) {
    next = { status: 200, body: { id: `mail_${purpose}` } }
    await sendLoginCode('player@example.com', '111222', purpose)
    subjects[purpose] = lastRequest.body.subject
  }
  assert.equal(new Set(Object.values(subjects)).size, 3, `三种用途的标题应各不相同：${JSON.stringify(subjects)}`)
  // 注销那封信必须把「不可恢复」说清楚，否则用户会把它当成普通登录码填进去
  next = { status: 200, body: { id: 'mail_del' } }
  await sendLoginCode('player@example.com', '111222', 'delete')
  assert.ok(/永久删除|无法恢复/.test(lastRequest.body.text), '注销确认信里没写清后果')
  // 纯文本正文里不该出现 markdown 的星号
  assert.ok(!lastRequest.body.text.includes('**'), '纯文本正文里漏了 markdown 星号')
  ok('login / bind / delete 三封信各不相同，注销信写明了后果')
} catch (e) {
  bad('login / bind / delete 三封信各不相同', e)
}

console.log('\n网络失败：')
try {
  process.env.RESEND_API_BASE = 'http://127.0.0.1:1'
  const fresh = await import(`../src/mail.js?nocache=${Date.now()}`)
  await fresh.sendLoginCode('player@example.com', '999999')
  bad('连不上时 kind=network', new Error('本该失败'))
} catch (e) {
  if (e?.kind === 'network') ok('连不上时 kind=network（可重试，与「这个邮箱收不了信」区分开）')
  else bad('连不上时 kind=network', new Error(`kind 是 ${e?.kind}：${e?.message}`))
}

server.close()
console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过')
process.exit(failed ? 1 : 0)
