import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestToken } from '../src/auth'
import { OpenApiError } from '../src/index'
import { mockFetch, OK_TOKEN, oauthError } from './helpers'

test('requestToken: 成功把响应映射成 TokenResponse，且请求体正确', async () => {
  let body: Record<string, string> | undefined
  const f = mockFetch((url, init) => {
    if (url.endsWith('/api/open/v1/token')) {
      body = JSON.parse(init.body as string) as Record<string, string>
      return { status: 200, body: OK_TOKEN }
    }
    return { status: 404, body: {} }
  })

  const res = await requestToken({
    baseUrl: 'https://example.test',
    clientId: 'cid',
    clientSecret: 'csec',
    scopes: ['games.read'],
    fetchImpl: f,
  })

  assert.equal(res.access_token, 'tok')
  assert.equal(res.token_type, 'Bearer')
  assert.equal(body!.grant_type, 'client_credentials')
  assert.equal(body!.client_id, 'cid')
  assert.equal(body!.client_secret, 'csec')
  assert.equal(body!.scope, 'games.read')
})

test('requestToken: 不传 scope 时请求体里没有 scope 字段', async () => {
  let body: Record<string, unknown> | undefined
  const f = mockFetch((url, init) => {
    if (url.endsWith('/api/open/v1/token')) {
      body = JSON.parse(init.body as string) as Record<string, unknown>
      return { status: 200, body: OK_TOKEN }
    }
    return { status: 404, body: {} }
  })
  await requestToken({ baseUrl: 'https://example.test', clientId: 'c', clientSecret: 's', fetchImpl: f })
  assert.equal(body!.scope, undefined)
})

test('requestToken: invalid_client 翻成 OpenApiError', async () => {
  const f = mockFetch(() => ({ status: 401, body: oauthError('invalid_client', 'AppID 或 key 不正确') }))
  await assert.rejects(
    () => requestToken({ baseUrl: 'https://example.test', clientId: 'c', clientSecret: 's', fetchImpl: f }),
    (e: unknown) => e instanceof OpenApiError && (e as OpenApiError).status === 401 && (e as OpenApiError).code === 'invalid_client',
  )
})
