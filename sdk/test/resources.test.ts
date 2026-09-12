import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BitgoOpenClient, OpenApiError } from '../src/index'
import { mockFetch, OK_TOKEN, oauthError } from './helpers'

function client(handler: Parameters<typeof mockFetch>[0]) {
  return new BitgoOpenClient({
    baseUrl: 'https://example.test',
    clientId: 'c',
    clientSecret: 's',
    scopes: ['games.read'],
    fetchImpl: mockFetch(handler),
  })
}

const GAME = {
  slug: 'contra',
  title: 'Contra',
  description: '',
  lang_requested: 'en',
  lang_actual: { title: 'und', description: 'und' },
  platform: 'nes',
  genres: [],
  tags: [],
  year: 1987,
  developer: 'Konami',
  players: 2,
  multiplayer: true,
  icon: '🎮',
  cover: null,
  rating: 0,
  rating_count: 0,
  plays: 0,
  added_at: null,
  updated_at: null,
  adult: false,
  rom_langs: ['en'],
}

function tokenOk(url: string) {
  return url.includes('/api/open/v1/token') ? { status: 200, body: OK_TOKEN } : null
}

test('games.list: 打 /v1/games 且查询串正确', async () => {
  let seen: string | undefined
  const c = client((url) => {
    const t = tokenOk(url)
    if (t) return t
    seen = url
    return { status: 200, body: { items: [], page: 1, page_size: 24, total: 0, total_pages: 0 } }
  })
  await c.games.list({ platform: 'nes', pageSize: 10, lang: 'ja' })
  assert.ok(seen!.startsWith('https://example.test/api/open/v1/games?'))
  assert.ok(seen!.includes('platform=nes'))
  assert.ok(seen!.includes('page_size=10'))
  assert.ok(seen!.includes('lang=ja'))
})

test('games.get: 返回 Game；404 翻成 not_found', async () => {
  const c1 = client((url) => {
    const t = tokenOk(url)
    if (t) return t
    return { status: 200, body: GAME }
  })
  const g = await c1.games.get('contra')
  assert.equal(g.slug, 'contra')
  assert.deepEqual(g.lang_actual, { title: 'und', description: 'und' })

  const c2 = client((url) => {
    const t = tokenOk(url)
    if (t) return t
    return { status: 404, body: oauthError('not_found', '没有这款游戏') }
  })
  await assert.rejects(
    () => c2.games.get('nope'),
    (e: unknown) => e instanceof OpenApiError && (e as OpenApiError).code === 'not_found',
  )
})

test('games.rom / games.embed: 路径正确', async () => {
  let romUrl: string | undefined
  let embedUrl: string | undefined
  const c = client((url) => {
    const t = tokenOk(url)
    if (t) return t
    if (url.includes('/api/open/v1/games/contra/rom')) {
      romUrl = url
      return {
        status: 200,
        body: { url: 'https://example.test/api/open/v1/rom/x', expires_in: 600, lang_requested: 'ja', lang_actual: 'ja', filename: 'contra.ja' },
      }
    }
    if (url.includes('/api/open/v1/games/contra/embed')) {
      embedUrl = url
      return { status: 200, body: { url: 'https://example.test/embed/contra', expires_in: 3600, allow: 'fullscreen' } }
    }
    return { status: 200, body: {} }
  })
  await c.games.rom('contra', { lang: 'ja' })
  await c.games.embed('contra')
  assert.ok(romUrl!.endsWith('/api/open/v1/games/contra/rom?lang=ja'))
  assert.ok(embedUrl!.endsWith('/api/open/v1/games/contra/embed'))
})

test('token.introspect: 打 /v1/me', async () => {
  let seen: string | undefined
  const c = client((url) => {
    const t = tokenOk(url)
    if (t) return t
    seen = url
    return { status: 200, body: { client_id: 'c', kind: 'app', scope: 'games.read', expires_at: new Date().toISOString() } }
  })
  await c.token.introspect()
  assert.ok(seen!.endsWith('/api/open/v1/me'))
})
