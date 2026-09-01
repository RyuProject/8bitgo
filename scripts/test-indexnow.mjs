import assert from 'node:assert/strict'
import { SITE_LANGUAGES } from '../shared/site-languages.js'
import {
  DEFAULT_INDEXNOW_KEY,
  buildIndexNowPayload,
  gameChangeUrls,
  gameDetailUrls,
  normalizeIndexNowUrls,
  submitIndexNowUrls,
} from '../server/src/indexnow.js'
import { buildGameSitemap } from '../server/src/routes/sitemaps.js'

let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

await check('每款游戏生成全部语言 URL，默认语言使用裸路径', async () => {
  const urls = gameDetailUrls('theme hospital', 'https://8bitgo.com')
  assert.equal(urls.length, SITE_LANGUAGES.length)
  assert.equal(urls[0], 'https://8bitgo.com/games/theme%20hospital')
  assert.ok(urls.includes('https://8bitgo.com/en/games/theme%20hospital'))
})

await check('游戏变更同时覆盖详情、游戏列表、平台与类型页', async () => {
  const urls = gameChangeUrls(
    { slug: 'doom', platform: 'dos', genres: ['action', 'shooting'] },
    'https://8bitgo.com',
  )
  assert.equal(urls.length, 5 * SITE_LANGUAGES.length)
  assert.ok(urls.includes('https://8bitgo.com/games/doom'))
  assert.ok(urls.includes('https://8bitgo.com/ja/platforms/dos'))
  assert.ok(urls.includes('https://8bitgo.com/de/genres/shooting'))
})

await check('只保留本站 URL，并去重和去掉 hash', async () => {
  const urls = normalizeIndexNowUrls([
    'https://8bitgo.com/games/doom#player',
    'https://8bitgo.com/games/doom',
    'https://example.com/games/doom',
    'not-a-url',
  ], 'https://8bitgo.com')
  assert.deepEqual(urls, ['https://8bitgo.com/games/doom'])
})

await check('IndexNow payload 包含根目录 keyLocation', async () => {
  const payload = buildIndexNowPayload(['https://8bitgo.com/games/doom'], {
    siteUrl: 'https://8bitgo.com',
  })
  assert.equal(payload.host, '8bitgo.com')
  assert.equal(payload.key, DEFAULT_INDEXNOW_KEY)
  assert.equal(payload.keyLocation, `https://8bitgo.com/${DEFAULT_INDEXNOW_KEY}.txt`)
})

await check('提交使用批量 JSON，200/202 都视为搜索引擎已接收', async () => {
  let sent
  const result = await submitIndexNowUrls([
    'https://8bitgo.com/games/doom',
    'https://8bitgo.com/games/doom',
  ], {
    enabled: true,
    siteUrl: 'https://8bitgo.com',
    fetchImpl: async (endpoint, options) => {
      sent = { endpoint, options, body: JSON.parse(options.body) }
      return { status: 202, text: async () => '' }
    },
  })
  assert.equal(result.submitted, 1)
  assert.equal(result.batches, 1)
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.body.urlList[0], 'https://8bitgo.com/games/doom')
})

await check('动态游戏 sitemap 使用数据库更新时间和指定语言路径', async () => {
  const xml = buildGameSitemap(
    [{ slug: 'theme-hospital', updated_at: new Date('2026-08-31T12:00:00Z') }],
    'en',
    'https://8bitgo.com',
  )
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/en\/games\/theme-hospital<\/loc>/)
  assert.match(xml, /<lastmod>2026-08-31<\/lastmod>/)
})

console.log(`✅ IndexNow / sitemap：${passed} 项检查通过`)
