/**
 * 直播身份回归：旧 JWT 的身份环不能比站内登录中间件更宽松。
 * 不连库，用户行由测试提供；签名和验签仍走真实实现。
 */
import assert from 'node:assert/strict'

process.env.JWT_SECRET = 'live-identity-test-secret-2026'
const { signToken } = await import('../src/auth.js')
const { chatIdentity } = await import('../src/live.js')

let queries = 0
const user = { nickname: '主播', role: 'admin', status: 'active', token_version: 2 }
const lookup = async (sql, params) => {
  queries++
  assert.match(sql, /token_version/)
  assert.deepEqual(params, ['u1'])
  return user
}
const socket = (token) => ({ id: 'live-viewer-1234', data: {}, handshake: { auth: { token } } })
const s = socket(signToken('u1', 2))

assert.deepEqual(await chatIdentity(s, lookup), { name: '主播', role: 'admin' })
assert.equal(queries, 1, '有效令牌取得账号身份')
assert.deepEqual(await chatIdentity(s, lookup), { name: '主播', role: 'admin' })
assert.equal(queries, 1, '短时间内复用结果，不给每条弹幕都查库')

user.token_version = 3
s.data.chatIdentityAt = 0
assert.deepEqual(await chatIdentity(s, lookup), { guest: '1234' }, '退出所有设备后旧 JWT 只能当游客')

user.token_version = 2
user.status = 'banned'
s.data.chatIdentityAt = 0
assert.deepEqual(await chatIdentity(s, lookup), { guest: '1234' }, '封号后旧连接不能继续挂管理员身份环')

const bad = socket('not-a-jwt')
const before = queries
assert.deepEqual(await chatIdentity(bad, lookup), { guest: '1234' }, '伪造令牌只能当游客')
assert.equal(queries, before, '伪造令牌不查用户表')

console.log('✅ 直播身份：有效账号、缓存、会话作废、封号、伪造令牌全部通过')
