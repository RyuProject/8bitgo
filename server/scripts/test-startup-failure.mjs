/**
 * 真起一次服务端子进程：端口被占用时必须退出，不能在 PM2 下假装在线却不接请求。
 * 不碰数据库；监听失败发生在启动自检之前，缺密钥也会在监听之前拒绝。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))

function child(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd,
      env: {
        ...process.env,
        ADMIN_AUTH_DISABLED: '0',
        JWT_SECRET: 'test-login-secret-for-startup-0123456789',
        ADMIN_TOKEN: 'test-admin-secret-for-startup-0123456789',
        PUBLIC_SITE_URL: 'http://localhost:8788',
        NODE_ENV: 'test',
        IPX_ENABLED: '0',
        TURN_PROBE: 'off',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    proc.stdout.on('data', (data) => { output += data })
    proc.stderr.on('data', (data) => { output += data })
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 8_000)
    proc.on('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, output })
    })
  })
}

// Node 在有 IPv6 的机器默认绑定 ::，没有 IPv6 时会退回 IPv4；测试必须占同一种地址。
const probe = createServer()
await new Promise((resolve) => probe.listen(0, resolve))
const bindAddress = probe.address().address
await new Promise((resolve) => probe.close(resolve))
const blocked = createServer((_req, res) => res.end('occupied'))
await new Promise((resolve) => blocked.listen(0, bindAddress, resolve))
try {
  const port = String(blocked.address().port)
  const r = await child({ PORT: port })
  assert.equal(r.signal, null, `端口被占用后进程仍活着，只能强杀：${r.output.slice(-1000)}`)
  assert.equal(r.code, 1, `监听失败没有以非零状态退出：${r.output.slice(-1000)}`)
  assert.match(r.output, /EADDRINUSE|address already in use/)
  console.log('✅ 端口占用：进程明确失败退出，PM2 能重启或报警')
} finally {
  await new Promise((resolve) => blocked.close(resolve))
}

const secret = await child({ PUBLIC_SITE_URL: 'https://8bitgo.com', JWT_SECRET: 'dev-secret-change-me' })
assert.equal(secret.code, 1, `公开站点带固定密钥仍然启动了：${secret.output.slice(-1000)}`)
assert.match(secret.output, /JWT_SECRET/)
console.log('✅ 固定密钥：公开站点在监听前拒绝启动')

const weakJwt = await child({ PUBLIC_SITE_URL: 'https://8bitgo.com', JWT_SECRET: 'short-secret' })
assert.equal(weakJwt.code, 1, `公开站点带短 JWT 密钥仍然启动了：${weakJwt.output.slice(-1000)}`)
assert.match(weakJwt.output, /JWT_SECRET.*32/)
console.log('✅ 短 JWT 密钥：公开站点在监听前拒绝启动')

const reused = await child({
  PUBLIC_SITE_URL: 'https://8bitgo.com',
  JWT_SECRET: 'same-secret-value-0123456789abcdef',
  ADMIN_TOKEN: 'same-secret-value-0123456789abcdef',
})
assert.equal(reused.code, 1, `登录密钥与后台口令复用时仍然启动了：${reused.output.slice(-1000)}`)
assert.match(reused.output, /复用/)
console.log('✅ 密钥复用：公开站点在监听前拒绝启动')
