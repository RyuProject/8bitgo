/** 验证码并发回归：纯内存后端 + 本机邮件 mock，不连接数据库或真实邮件服务。 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.RESEND_API_KEY = 're_test_key'
process.env.MAIL_FROM = 'noreply@8bitgo.com'
process.env.MAIL_TIMEOUT_MS = '3000'
delete process.env.CF_ACCOUNT_ID
delete process.env.CF_EMAIL_TOKEN
delete process.env.SMTP_HOST
delete process.env.SMTP_USER

const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const requests = []
const started = Array.from({ length: 5 }, deferred)
const releases = [null, deferred(), deferred()]
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}')
    const code = (String(body.text || '').match(/\b(\d{6})\b/) || [])[1]
    requests.push({ body, code })
    const n = requests.length
    started[n]?.resolve()
    if (n <= 2) await releases[n].promise
    const status = n === 2 || n === 4 ? 500 : 200
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? { id: `mail_${n}` } : { name: 'internal_server_error', message: 'mock failure' }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env.RESEND_API_BASE = `http://127.0.0.1:${server.address().port}`

const { issueCode, verifyCode, CodeError, useMemoryCodeStoreForTest } = await import('../src/codes.js')
useMemoryCodeStoreForTest()

const originalNow = Date.now
let now = originalNow()
Date.now = () => now
let ip = 1
const req = () => ({ ip: `203.0.113.${ip++}` })
const expectCodeError = async (promise, status) => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof CodeError)
    assert.equal(error.status, status)
    return error
  }
  assert.fail(`预期 CodeError ${status}`)
}

try {
  // 两个同邮箱请求同时进来，只能有一封信获准发送。
  const first = issueCode(req(), 'parallel@example.invalid', 'login')
  await started[1].promise
  await expectCodeError(issueCode(req(), 'parallel@example.invalid', 'login'), 429)
  releases[1].resolve()
  await first
  assert.equal(requests.length, 1)
  await verifyCode('parallel@example.invalid', 'login', requests[0].code)

  // 第一封的 HTTP 结果迟到且失败；冷却已过后第二封成功，新码不能被第一封的清理删掉。
  const staleFailure = issueCode(req(), 'replacement@example.invalid', 'login')
  await started[2].promise
  now += 60_001
  await issueCode(req(), 'replacement@example.invalid', 'login')
  assert.equal(requests.length, 3)
  releases[2].resolve()
  await expectCodeError(staleFailure, 502)
  await verifyCode('replacement@example.invalid', 'login', requests[2].code)

  // 上游返回错误时仍可能已经接收邮件；保留码并回传冷却时间，已到达的邮件仍可使用。
  const uncertain = await expectCodeError(issueCode(req(), 'uncertain@example.invalid', 'login'), 502)
  assert.equal(uncertain.extra.retryAfter, 60)
  await verifyCode('uncertain@example.invalid', 'login', requests[3].code)
  console.log('✅ 并发冷却和迟到失败清理回归通过')
} finally {
  Date.now = originalNow
  server.closeAllConnections?.()
  server.close()
}
