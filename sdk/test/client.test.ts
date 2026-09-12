import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BitgoOpenClient, OpenApiError, buildQuery } from '../src/index'
import { mockFetch, OK_TOKEN, oauthError } from './helpers'

function client(handler: Parameters<typeof mockFetch>[0], overrides: Partial<ConstructorParameters<typeof BitgoOpenClient>[0]> = {}) {
  return new BitgoOpenClient({
    baseUrl: 'https://example.test',
    clientId: 'c',
    clientSecret: 's',
    scopes: ['games.read'],
    fetchImpl: mockFetch(handler),
    ...overrides,
  })
}

test('getAccessToken: 多请求只取一次令牌（缓存）', async () => {
  let tokenCalls = 0
  const c = client((url) => {
    if (url.endsWith('/api/open/v1/token')) {
      tokenCalls++
      return { status: 200, body: OK_TOKEN }
    }
    return { status: 200, body: { items: [], page: 1, page_size: 24, total: 0, total_pages: 0 } }
  })
  await c.games.list()
  await c.games.list()
  assert.equal(tokenCalls, 1)
})

test('getAccessToken: 超过刷新缓冲后重新取令牌', async () => {
  let tokenCalls = 0
  const c = client(
    (url) => {
      if (url.endsWith('/api/open/v1/token')) {
        tokenCalls++
        return { status: 200, body: { ...OK_TOKEN, access_token: 'tok' + tokenCalls } }
      }
      return {
        status: 200,
        body: { client_id: 'c', kind: 'app', scope: 'games.read', expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }
    },
    { tokenRefreshBufferSec: 9999 },
  )
  await c.token.introspect()
  await c.token.introspect()
  assert.equal(tokenCalls, 2)
})

test('request: 挂上 Bearer 并解析 JSON', async () => {
  let auth: string | undefined
  const c = client((url, init) => {
    if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
    auth = (init.headers as Record<string, string>).Authorization
    return {
      status: 200,
      body: { client_id: 'c', kind: 'app', scope: 'games.read', expires_at: new Date().toISOString() },
    }
  })
  await c.token.introspect()
  assert.equal(auth, 'Bearer tok')
})

test('request: 收到 401 清缓存、重取一次、重试成功', async () => {
  let tokenCalls = 0
  let calls = 0
  const c = client((url) => {
    if (url.endsWith('/api/open/v1/token')) {
      tokenCalls++
      return { status: 200, body: { ...OK_TOKEN, access_token: 'tok' + tokenCalls } }
    }
    calls++
    return {
      status: calls === 1 ? 401 : 200,
      body:
        calls === 1
          ? oauthError('invalid_token', '令牌无效或已过期')
          : { client_id: 'c', kind: 'app', scope: 'games.read', expires_at: new Date().toISOString() },
    }
  })
  const info = await c.token.introspect()
  assert.equal(info.client_id, 'c')
  assert.equal(tokenCalls, 2)
  assert.equal(calls, 2)
})

test('request: 连续 401 抛 OpenApiError', async () => {
  let tokenCalls = 0
  const c = client((url) => {
    if (url.endsWith('/api/open/v1/token')) {
      tokenCalls++
      return { status: 200, body: { ...OK_TOKEN, access_token: 'tok' + tokenCalls } }
    }
    return { status: 401, body: oauthError('invalid_token', '令牌无效或已过期') }
  })
  await assert.rejects(
    () => c.token.introspect(),
    (e: unknown) => e instanceof OpenApiError && (e as OpenApiError).isAuthError && (e as OpenApiError).status === 401,
  )
  assert.equal(tokenCalls, 2)
})

test('request: 限流 429 透出 Retry-After', async () => {
  const c = client((url) => {
    if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
    return { status: 429, headers: { 'Retry-After': '42' }, body: oauthError('rate_limited', '请求过于频繁', { retry_after: 42 }) }
  })
  await assert.rejects(
    () => c.games.list(),
    (e: unknown) => {
      const err = e as OpenApiError
      return err instanceof OpenApiError && err.isRateLimited && err.status === 429 && err.retryAfter === 42
    },
  )
})

test('request: 业务 404 翻成带 code 的 OpenApiError', async () => {
  const c = client((url) => {
    if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
    return { status: 404, body: oauthError('not_found', '没有这款游戏') }
  })
  await assert.rejects(
    () => c.games.get('nope'),
    (e: unknown) => e instanceof OpenApiError && (e as OpenApiError).code === 'not_found' && (e as OpenApiError).status === 404,
  )
})

test('buildQuery: 跳过空值/undefined，并做编码', () => {
  assert.equal(buildQuery({ a: 'x', b: '', c: undefined, d: 5 }), '?a=x&d=5')
  assert.equal(buildQuery({ q: 'a b' }), '?q=a+b')
  assert.equal(buildQuery({}), '')
})
