import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BitgoOpenClient, UserFlows, DEVICE_GRANT, OpenApiError } from '../src/index'
import { mockFetch, OK_TOKEN } from './helpers'

function client(fetchImpl: typeof fetch) {
  return new BitgoOpenClient({ baseUrl: 'https://example.test', clientId: 'cid', clientSecret: 'csec', fetchImpl })
}

/** postForm 发的是 form-urlencoded，不是 JSON */
function formBody(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init.body ?? '')))
}

const DEVICE_CODE_BODY = {
  device_code: 'dc',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://example.test/open/device',
  verification_uri_complete: 'https://example.test/open/device?code=ABCD-EFGH',
  expires_in: 900,
  interval: 5,
}

test('device flow: 要码 -> 轮询到批准 -> 用户令牌生效 -> library 可调用', async () => {
  let polls = 0
  const f = mockFetch((url, init) => {
    if (url.endsWith('/api/open/v1/device/code')) return { status: 200, body: DEVICE_CODE_BODY }
    if (url.endsWith('/api/open/v1/token')) {
      const body = formBody(init)
      if (body.grant_type === DEVICE_GRANT) {
        polls++
        if (polls < 2) return { status: 400, body: { error: 'authorization_pending', error_description: '等用户确认' } }
        return { status: 200, body: { access_token: 'utok', token_type: 'Bearer', expires_in: 900, scope: 'library.read' } }
      }
      return { status: 200, body: OK_TOKEN }
    }
    if (url.endsWith('/api/open/v1/library')) return { status: 200, body: { favorites: [], recent: [], favorites_total: 0 } }
    return { status: 404, body: {} }
  })

  const c = client(f)
  const da = await c.user.startDeviceAuthorization({ scopes: ['library.read'] })
  assert.equal(da.device_code, 'dc')
  assert.equal(da.user_code, 'ABCD-EFGH')
  assert.equal(da.interval, 5)

  const tok = await c.user.pollDeviceToken(da.device_code, { interval: 0 })
  assert.equal(tok.access_token, 'utok')
  // 写回了 client，后续 library/saves 自动带上
  assert.equal(await c.getUserAccessToken(), 'utok')
  const lib = await c.library.list()
  assert.deepEqual(lib, { favorites: [], recent: [], favorites_total: 0 })
})

test('device flow: slow_down 加大轮询间隔', async () => {
  let polls = 0
  let lastInterval = 0
  const f = mockFetch((url, init) => {
    if (url.endsWith('/api/open/v1/device/code')) return { status: 200, body: DEVICE_CODE_BODY }
    if (url.endsWith('/api/open/v1/token')) {
      const body = formBody(init)
      if (body.grant_type === DEVICE_GRANT) {
        polls++
        if (polls === 1) return { status: 400, body: { error: 'slow_down', error_description: '太快', interval: 10 } }
        return { status: 200, body: { access_token: 'utok', token_type: 'Bearer', expires_in: 900, scope: 'library.read' } }
      }
      return { status: 200, body: OK_TOKEN }
    }
    return { status: 404, body: {} }
  })

  const c = client(f)
  const da = await c.user.startDeviceAuthorization()
  await c.user.pollDeviceToken(da.device_code, { interval: 0, onPending: (i) => (lastInterval = i.interval) })
  assert.equal(lastInterval, 10)
})

test('device flow: access_denied 抛错', async () => {
  const f = mockFetch((url, init) => {
    if (url.endsWith('/api/open/v1/device/code')) return { status: 200, body: DEVICE_CODE_BODY }
    if (url.endsWith('/api/open/v1/token')) {
      const body = formBody(init)
      if (body.grant_type === DEVICE_GRANT) return { status: 400, body: { error: 'access_denied', error_description: '用户拒绝' } }
      return { status: 200, body: OK_TOKEN }
    }
    return { status: 404, body: {} }
  })
  const c = client(f)
  const da = await c.user.startDeviceAuthorization()
  await assert.rejects(
    () => c.user.pollDeviceToken(da.device_code, { interval: 0 }),
    (e: unknown) => e instanceof OpenApiError && (e as OpenApiError).code === 'access_denied',
  )
})

test('auth-code + PKCE: 生成、拼 URL、换令牌', async () => {
  const { codeVerifier, codeChallenge } = await UserFlows.generatePkce()
  // challenge 必须等于 SHA256(verifier) 的 base64url
  const expected = createHash('sha256').update(codeVerifier).digest('base64url')
  assert.equal(codeChallenge, expected)

  let exchangeBody: Record<string, string> | undefined
  const f = mockFetch((url, init) => {
    if (url.endsWith('/api/oauth/token')) {
      exchangeBody = formBody(init) as Record<string, string>
      return { status: 200, body: { access_token: 'utok2', token_type: 'Bearer', expires_in: 900, scope: 'saves.read' } }
    }
    if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
    return { status: 404, body: {} }
  })

  const c = client(f)
  const url = c.user.authorizationCodeUrl({
    scopes: ['saves.read'],
    redirectUri: 'https://app.test/cb',
    state: 'xyz',
    codeChallenge,
  })
  assert.ok(url.includes('/api/oauth/authorize'))
  assert.ok(url.includes('client_id=cid'))
  assert.ok(url.includes('code_challenge=' + codeChallenge))
  assert.ok(url.includes('code_challenge_method=S256'))
  assert.ok(url.includes('redirect_uri=' + encodeURIComponent('https://app.test/cb')))
  assert.ok(url.includes('state=xyz'))
  assert.ok(url.includes('scope=saves.read'))

  const tok = await c.user.exchangeAuthorizationCode({ code: 'thecode', codeVerifier, redirectUri: 'https://app.test/cb' })
  assert.equal(tok.access_token, 'utok2')
  assert.equal(exchangeBody!.grant_type, 'authorization_code')
  assert.equal(exchangeBody!.code, 'thecode')
  assert.equal(exchangeBody!.code_verifier, codeVerifier)
  assert.equal(await c.getUserAccessToken(), 'utok2')
})
