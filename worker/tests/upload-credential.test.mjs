import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import worker from '../src/index.js'
import { uploadCredentialValid } from '../src/common.js'
import { environment, req } from './fixtures.mjs'
// 用服务端真正的签发函数：两边的格式 / 签名算法一旦漂开，这里先红，而不是后台上传 401
import { issueRomUploadCredential } from '../../server/src/rom-upload-credential.js'

const SECRET = 'test-signing-secret-0123456789abcdefghijklmn'
const env = () => ({ ...environment(), ROM_UPLOAD_SIGNING_SECRET: SECRET })
const ctx = { waitUntil() {} }
const listWith = (token) => req('/list', 'GET', undefined, { Authorization: `Bearer ${token}` })

test('a credential issued by the server is accepted for admin operations', async () => {
  const { token, expiresAt } = issueRomUploadCredential({ secret: SECRET })
  assert.ok(expiresAt > Date.now())
  const r = await worker.fetch(listWith(token), env(), ctx)
  assert.equal(r.status, 200)
})

test('ADMIN_TOKEN keeps working (server conversion jobs and manual entry)', async () => {
  const r = await worker.fetch(req('/list', 'GET', undefined, {}, true), env(), ctx)
  assert.equal(r.status, 200)
})

test('expired, tampered, wrong-secret and far-future credentials are rejected', async () => {
  const now = Date.now()
  const expired = issueRomUploadCredential({ secret: SECRET, ttlSec: -10 }).token
  const good = issueRomUploadCredential({ secret: SECRET }).token
  const parts = good.split('.')
  const tamperedExp = [parts[0], String(Number(parts[1]) + 60), parts[2], parts[3]].join('.')
  const otherSecret = issueRomUploadCredential({ secret: 'another-secret-0123456789abcdefghijklmnop' }).token
  // 签名正确但过期时间在 13 小时以外：服务端只发 12 小时的，这种只可能是密钥泄露后伪造的长寿凭据
  const farExp = Math.floor(now / 1000) + 48 * 3600
  const farBody = `8bg1.${farExp}.abc`
  const farFuture = `${farBody}.${createHmac('sha256', SECRET).update(farBody).digest('base64url')}`
  for (const token of [expired, tamperedExp, otherSecret, farFuture, 'ADMIN_TOKEN', '8bg1.x.y.z', '']) {
    const r = await worker.fetch(listWith(token), env(), ctx)
    assert.equal(r.status, 401, `应拒绝：${token.slice(0, 24)}`)
  }
})

test('without a signing secret on the Worker, credentials are ignored (old behaviour)', async () => {
  const { token } = issueRomUploadCredential({ secret: SECRET })
  const e = environment()
  assert.equal((await worker.fetch(listWith(token), e, ctx)).status, 401)
  assert.equal(await uploadCredentialValid(token, { ROM_UPLOAD_SIGNING_SECRET: 'too-short' }), false)
})

test('credentials also authorize writes and private staging reads', async () => {
  const { token } = issueRomUploadCredential({ secret: SECRET })
  const e = env()
  const put = await worker.fetch(req('/roms/nes/test.nes', 'PUT', new Uint8Array([1, 2, 3]), { Authorization: `Bearer ${token}` }), e, ctx)
  assert.ok(put.status === 200 || put.status === 201, `PUT 应成功，实际 ${put.status}`)
  const staging = await worker.fetch(req('/psp-staging/none.iso', 'HEAD', undefined, { Authorization: `Bearer ${token}` }), e, ctx)
  assert.notEqual(staging.status, 401)
})
