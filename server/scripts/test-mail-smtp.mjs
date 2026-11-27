/** SMTP 发信回归：本机假 SMTP 服务，不连接外网。 */
import net from 'node:net'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.MAIL_FROM = 'noreply@example.com'
process.env.SMTP_HOST = '127.0.0.1'
process.env.SMTP_USER = 'mailer@example.com'
process.env.SMTP_PASS = 'test-password'
process.env.MAIL_TIMEOUT_MS = '250'
delete process.env.RESEND_API_KEY
delete process.env.RESEND_API_BASE
delete process.env.CF_ACCOUNT_ID
delete process.env.CF_EMAIL_TOKEN

let mode = 'stall'
let authLoginStep = 0
const server = net.createServer((socket) => {
  if (mode === 'stall') return
  socket.write('220 local.test ESMTP\r\n')
  let buffer = ''
  let dataMode = false
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (dataMode) {
        if (line === '.') {
          dataMode = false
          socket.write('250 2.0.0 queued\r\n')
        }
        continue
      }
      const command = line.toUpperCase()
      if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250-local.test\r\n250 AUTH PLAIN LOGIN\r\n')
      else if (command.startsWith('AUTH PLAIN ')) socket.write('235 2.7.0 authenticated\r\n')
      else if (command === 'AUTH PLAIN') socket.write('334 \r\n')
      else if (command.startsWith('AUTH LOGIN')) {
        authLoginStep = 1
        socket.write('334 VXNlcm5hbWU6\r\n')
      } else if (authLoginStep === 1) {
        authLoginStep = 2
        socket.write('334 UGFzc3dvcmQ6\r\n')
      } else if (authLoginStep === 2) {
        authLoginStep = 0
        socket.write('235 2.7.0 authenticated\r\n')
      } else if (command.startsWith('MAIL FROM:') && mode === 'sender-reject') socket.write('550 5.7.1 sender denied\r\n')
      else if (command.startsWith('MAIL FROM:')) socket.write('250 2.1.0 sender ok\r\n')
      else if (command.startsWith('RCPT TO:') && mode === 'recipient-reject') socket.write('550 5.1.1 no such user\r\n')
      else if (command.startsWith('RCPT TO:')) socket.write('250 2.1.5 recipient ok\r\n')
      else if (command === 'DATA') {
        dataMode = true
        socket.write('354 end with dot\r\n')
      } else if (command === 'QUIT') socket.end('221 bye\r\n')
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env.SMTP_PORT = String(server.address().port)
const { sendRawMail, MailError } = await import('../src/mail.js')
const send = () => sendRawMail({ to: 'player@example.com', subject: 'test', text: 'test', provider: 'smtp' })
const expectKind = async (expected) => {
  try {
    await send()
  } catch (error) {
    assert.ok(error instanceof MailError)
    assert.equal(error.kind, expected, error.message)
    return
  }
  assert.fail(`预期 SMTP 错误类型 ${expected}`)
}

try {
  const start = Date.now()
  await expectKind('network')
  assert.ok(Date.now() - start < 2_000, 'SMTP 无响应不应继续占住请求')
  mode = 'recipient-reject'
  await expectKind('suppressed')
  mode = 'sender-reject'
  await expectKind('sender')
  console.log('✅ SMTP 超时、收件拒绝与发件拒绝回归通过')
} finally {
  server.closeAllConnections?.()
  server.close()
}
