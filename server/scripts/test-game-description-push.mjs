import assert from 'node:assert/strict'
import {
  decodeGameDescriptionCursor,
  encodeGameDescriptionCursor,
  gameDescriptionPushConfig,
  isGameDescriptionPushAuthorized,
  validateGameDescriptionListQuery,
  validateGameDescriptionPush,
} from '../src/game-description-push.js'
import { createGameDescriptionPushRouter } from '../src/routes/game-description-push.js'

const secret = 'push-token-for-game-descriptions-0123456789'

assert.equal(gameDescriptionPushConfig({}).enabled, false)
assert.equal(gameDescriptionPushConfig({ GAME_DESCRIPTION_PUSH_TOKEN: 'weak' }).enabled, false)
assert.equal(gameDescriptionPushConfig({ GAME_DESCRIPTION_PUSH_TOKEN: secret, ADMIN_TOKEN: secret }).enabled, false)
assert.equal(gameDescriptionPushConfig({ GAME_DESCRIPTION_PUSH_TOKEN: secret, ADMIN_TOKEN: 'different', JWT_SECRET: 'also-different' }).enabled, true)
assert.equal(isGameDescriptionPushAuthorized(`Bearer ${secret}`, secret), true)
assert.equal(isGameDescriptionPushAuthorized(`Bearer ${secret}x`, secret), false)
assert.equal(isGameDescriptionPushAuthorized(secret, secret), false)

assert.deepEqual(validateGameDescriptionPush({ slug: 'game-test', lang: 'ja', text: '  日本語简介  ' }), {
  value: { slug: 'game-test', lang: 'ja', text: '日本語简介' },
})
for (const body of [
  { slug: '../game', lang: 'ja', text: 'x' },
  { slug: 'game-test', lang: 'en', text: 'x' },
  { slug: 'game-test', lang: 'ja', text: ' ' },
  { slug: 'game-test', lang: 'ja', text: 'x'.repeat(4001) },
  { slug: 'game-test', lang: 'ja', text: 123 },
]) assert.ok(validateGameDescriptionPush(body).error)
assert.deepEqual(validateGameDescriptionListQuery({}).value, {
  status: 'missing', lang: null, limit: 100, cursor: '',
})
assert.ok(validateGameDescriptionListQuery({ status: 'bad' }).error)
assert.ok(validateGameDescriptionListQuery({ lang: 'pt' }).error)
assert.ok(validateGameDescriptionListQuery({ limit: 201 }).error)
const cursorFilters = { status: 'missing', filterLang: 'ja' }
const cursorToken = encodeGameDescriptionCursor({ id: '123', lang: 'ja' }, cursorFilters)
assert.deepEqual(decodeGameDescriptionCursor(cursorToken, cursorFilters).value, { id: '123', lang: 'ja' })
assert.ok(decodeGameDescriptionCursor(cursorToken, { status: 'all', filterLang: 'ja' }).error)
assert.ok(decodeGameDescriptionCursor('not-a-cursor', cursorFilters).error)

const written = []
const invalidated = []
const listed = []
const env = { GAME_DESCRIPTION_PUSH_TOKEN: secret, JWT_SECRET: 'separate-jwt', ADMIN_TOKEN: 'separate-admin' }
const router = createGameDescriptionPushRouter({
  env,
  findGame: async (slug) => slug === 'game-test'
    ? { slug, title: 'Test', roms: { ja: 'roms/game-test.ja.zip.8bg', fr: 'roms/game-test.fr.zip.8bg' }, descriptionLocalized: { fr: 'Ancien texte' } }
    : null,
  listDescriptions: async (filters) => {
    listed.push(filters)
    if (filters.status === 'filled') {
      return [{ cursorId: '12', slug: 'already-translated', lang: 'ja', text: '既存の紹介文', sourceText: 'English text', sourceLang: 'en' }]
    }
    const rows = [
      { cursorId: '10', slug: 'game-test', lang: 'ja', text: null, sourceText: 'English text', sourceLang: 'en' },
      { cursorId: '10', slug: 'game-test', lang: 'zh-Hant', text: null, sourceText: '中文内容', sourceLang: 'zh-Hans' },
    ]
    return filters.after ? rows.slice(1) : rows
  },
  writeDescription: async (...args) => written.push(args),
  afterWrite: (game) => invalidated.push(game),
})
const getHandler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get)?.route.stack[0]?.handle
const putHandler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.put)?.route.stack[0]?.handle
assert.equal(typeof getHandler, 'function', '路由注册了 GET 状态查询处理器')
assert.equal(typeof putHandler, 'function', '路由注册了 PUT 写入处理器')
const request = async (method, { body, query = {}, authorization = `Bearer ${secret}` } = {}) => {
  let status = 200
  let responseBody
  let forwardedError
  const req = {
    body,
    query,
    ip: '198.51.100.22',
    socket: { remoteAddress: '198.51.100.22' },
    get(name) { return name.toLowerCase() === 'authorization' ? authorization : undefined },
  }
  const res = {
    status(value) { status = value; return this },
    json(value) { responseBody = value; return this },
  }
  await (method === 'get' ? getHandler : putHandler)(req, res, (error) => { forwardedError = error })
  if (forwardedError) throw forwardedError
  return { status, json: async () => responseBody }
}

const unauthorized = await request('put', { body: { slug: 'game-test', lang: 'ja', text: '译文' }, authorization: 'Bearer wrong-token' })
assert.equal(unauthorized.status, 401)

const missingGame = await request('put', { body: { slug: 'missing-game', lang: 'ja', text: '译文' } })
assert.equal(missingGame.status, 404)

const missingRom = await request('put', { body: { slug: 'game-test', lang: 'de', text: '译文' } })
assert.equal(missingRom.status, 409)

const invalidLang = await request('put', { body: { slug: 'game-test', lang: 'en', text: '译文' } })
assert.equal(invalidLang.status, 400)

const success = await request('put', { body: { slug: 'game-test', lang: 'ja', text: '新しい日本語紹介' } })
assert.equal(success.status, 200)
assert.deepEqual(await success.json(), { ok: true, slug: 'game-test', lang: 'ja', characters: 8 })
assert.deepEqual(written, [['game-test', 'ja', '新しい日本語紹介']])
assert.equal(invalidated.length, 1)
assert.deepEqual(invalidated[0].descriptionLocalized, { fr: 'Ancien texte', ja: '新しい日本語紹介' })

const listPage1 = await request('get', { query: { status: 'missing', limit: '1' } })
assert.equal(listPage1.status, 200)
const listBody1 = await listPage1.json()
assert.deepEqual(listBody1.items, [{
  slug: 'game-test', lang: 'ja', text: null, missing: true,
  sourceText: 'English text', sourceLang: 'en', translatable: true,
}])
assert.equal(listBody1.hasMore, true)
assert.ok(listBody1.nextCursor)
const listPage2 = await request('get', { query: { status: 'missing', limit: '1', cursor: listBody1.nextCursor } })
assert.equal(listPage2.status, 200)
assert.deepEqual((await listPage2.json()).items, [{
  slug: 'game-test', lang: 'zh-Hant', text: null, missing: true,
  sourceText: '中文内容', sourceLang: 'zh-Hans', translatable: true,
}])
assert.deepEqual(listed[0].after, null)
assert.deepEqual(listed[1].after, { id: '10', lang: 'ja' })
const filledPage = await request('get', { query: { status: 'filled', lang: 'ja' } })
assert.deepEqual((await filledPage.json()).items, [{
  slug: 'already-translated', lang: 'ja', text: '既存の紹介文', missing: false,
  sourceText: 'English text', sourceLang: 'en', translatable: true,
}])

const disabledRouter = createGameDescriptionPushRouter({ env: {} })
const disabledHandler = disabledRouter.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get)?.route.stack[0]?.handle
const disabledResponse = { statusCode: 200, body: null }
const disabledRes = {
  status(value) { this.statusCode = value; return this },
  json(value) { this.body = value; return this },
}
await disabledHandler({ body: {}, query: {}, get: () => undefined }, disabledRes, (error) => { throw error })
assert.equal(disabledRes.statusCode, 503)

console.log('✅ game description push API authentication, validation, language binding, and write isolation pass')
