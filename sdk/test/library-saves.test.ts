import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BitgoOpenClient, OpenApiError } from '../src/index'
import { mockFetch, OK_TOKEN, oauthError } from './helpers'

/** 用一枚已就绪的用户令牌初始化，省去走授权流程 */
function authedClient(fetchImpl: typeof fetch) {
  return new BitgoOpenClient({
    baseUrl: 'https://example.test',
    clientId: 'cid',
    clientSecret: 'csec',
    fetchImpl,
    userToken: 'utok',
    userTokenExpiresIn: 900,
  })
}

test('library.list: 返回收藏 / 最近在玩', async () => {
  let seen: string | undefined
  const c = authedClient(
    mockFetch((url) => {
      if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
      seen = url
      return { status: 200, body: { favorites: [], recent: [], favorites_total: 0 } }
    }),
  )
  const lib = await c.library.list({ lang: 'ja' })
  assert.ok(seen!.endsWith('/api/open/v1/library?lang=ja'))
  assert.deepEqual(lib, { favorites: [], recent: [], favorites_total: 0 })
})

test('library.list: 没用户令牌会报错', async () => {
  const c = new BitgoOpenClient({ baseUrl: 'https://example.test', clientId: 'c', clientSecret: 's', fetchImpl: mockFetch(() => ({ status: 200, body: {} })) })
  await assert.rejects(() => c.library.list(), /尚未取得用户级令牌/)
})

test('saves.list: 返回元信息清单', async () => {
  let seen: string | undefined
  const c = authedClient(
    mockFetch((url) => {
      if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
      seen = url
      return {
        status: 200,
        body: {
          items: [
            { runtime: 'emulatorjs', game_slug: 'contra', slot: 0, size: 2048, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
          ],
        },
      }
    }),
  )
  const list = await c.saves.list()
  assert.ok(seen!.endsWith('/api/open/v1/saves'))
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].runtime, 'emulatorjs')
})

test('saves.get: 取回二进制 + 更新时间', async () => {
  let seen: string | undefined
  const c = authedClient(
    mockFetch((url) => {
      if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
      seen = url
      return {
        status: 200,
        rawBody: new Uint8Array([1, 2, 3, 4]),
        headers: { 'x-save-updated-at': '1700000000000' },
      }
    }),
  )
  const save = await c.saves.get('emulatorjs', 'contra', { slot: 0 })
  assert.ok(seen!.endsWith('/api/open/v1/saves/emulatorjs/contra?slot=0'))
  assert.deepEqual([...save.data], [1, 2, 3, 4])
  assert.equal(save.updatedAt, 1700000000000)
})

test('saves.get: 404 翻成 OpenApiError', async () => {
  const c = authedClient(
    mockFetch((url) => {
      if (url.endsWith('/api/open/v1/token')) return { status: 200, body: OK_TOKEN }
      return { status: 404, body: oauthError('not_found', '没有这份存档') }
    }),
  )
  await assert.rejects(
    () => c.saves.get('emulatorjs', 'nope'),
    (e: unknown) => e instanceof OpenApiError && (e as OpenApiError).code === 'not_found',
  )
})
