/**
 * 百度普通收录推送的单元测试。全部用 mock fetch，不会真的发请求。
 * 跑：npm run test:baidu
 */
import assert from 'node:assert/strict'
import { SITE_LANGUAGES } from '../shared/site-languages.js'
import {
  DEFAULT_BAIDU_LANGUAGES,
  baiduPushEndpoint,
  baiduPushLanguages,
  gameBaiduDetailUrls,
  gameBaiduUrls,
  redactEndpoint,
  submitBaiduUrls,
} from '../server/src/baidu-push.js'
import { buildSitemapIndex } from '../server/src/routes/sitemaps.js'

const SITE = 'https://8bitgo.com'
const TOKEN = '3RMhtwFUwGWgy9Ky'

let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

await check('默认只推简体中文，一款游戏 4 条而不是 32 条', async () => {
  const urls = gameBaiduUrls({ slug: 'doom', platform: 'dos', genres: ['action'] }, SITE)
  assert.deepEqual(urls, [
    'https://8bitgo.com/games/doom',
    'https://8bitgo.com/games',
    'https://8bitgo.com/platforms/dos',
    'https://8bitgo.com/genres/action',
  ])
  assert.deepEqual([...DEFAULT_BAIDU_LANGUAGES], ['zh-Hans'])
  // 全语言是 8 倍，配额撑不住 —— 这条断言就是防止哪天默认值被改回全推。
  assert.ok(urls.length * SITE_LANGUAGES.length > urls.length)
})

await check('补交只要详情页，slug 做百分号编码', async () => {
  assert.deepEqual(gameBaiduDetailUrls('theme hospital', SITE), ['https://8bitgo.com/games/theme%20hospital'])
})

await check('BAIDU_PUSH_LANGUAGES 可以扩到繁体，写错的语言码直接报错', async () => {
  assert.deepEqual(baiduPushLanguages({ BAIDU_PUSH_LANGUAGES: 'zh-Hans,zh-Hant' }), ['zh-Hans', 'zh-Hant'])
  assert.deepEqual(baiduPushLanguages({ BAIDU_PUSH_LANGUAGES: '' }), ['zh-Hans'])
  assert.throws(() => baiduPushLanguages({ BAIDU_PUSH_LANGUAGES: 'zh_CN' }), /不支持的语言码/)
})

await check('接口地址带 site 与 token，日志里 token 被抹掉', async () => {
  const href = baiduPushEndpoint({ env: {}, site: SITE, token: TOKEN })
  assert.equal(href, `http://data.zz.baidu.com/urls?site=${encodeURIComponent(SITE)}&token=${TOKEN}`)
  assert.equal(redactEndpoint(href), `http://data.zz.baidu.com/urls?site=${encodeURIComponent(SITE)}&token=***`)
})

await check('token 缺失或格式不对时报错，不会照发', async () => {
  assert.throws(() => baiduPushEndpoint({ env: {}, site: SITE }), /BAIDU_PUSH_TOKEN/)
  assert.throws(() => baiduPushEndpoint({ env: { BAIDU_PUSH_TOKEN: 'x' }, site: SITE }), /BAIDU_PUSH_TOKEN/)
})

await check('请求体是 text/plain、每行一个 URL，并按响应统计', async () => {
  let sent
  const result = await submitBaiduUrls(
    ['https://8bitgo.com/games/doom', 'https://8bitgo.com/games/doom', 'https://8bitgo.com/games'],
    {
      enabled: true,
      site: SITE,
      token: TOKEN,
      env: {},
      fetchImpl: async (endpoint, options) => {
        sent = { endpoint, options }
        return { status: 200, text: async () => JSON.stringify({ remain: 97, success: 2, not_same_site: [], not_valid: [] }) }
      },
    },
  )
  assert.equal(sent.options.headers['Content-Type'], 'text/plain')
  // 去重后 2 条，换行分隔，不是 JSON
  assert.deepEqual(sent.options.body.split('\n'), ['https://8bitgo.com/games/doom', 'https://8bitgo.com/games'])
  assert.equal(result.submitted, 2)
  assert.equal(result.accepted, 2)
  assert.equal(result.remain, 97)
})

await check('外站 URL 被丢掉，不会把服务器变成任意 URL 提交代理', async () => {
  let body
  const result = await submitBaiduUrls(['https://evil.example.com/x', 'https://8bitgo.com/games/doom'], {
    enabled: true,
    site: SITE,
    token: TOKEN,
    env: {},
    fetchImpl: async (_e, o) => {
      body = o.body
      return { status: 200, text: async () => JSON.stringify({ remain: 9, success: 1 }) }
    },
  })
  assert.equal(body, 'https://8bitgo.com/games/doom')
  assert.equal(result.submitted, 1)
})

await check('未开启开关时直接跳过，一个请求都不发', async () => {
  let called = false
  const result = await submitBaiduUrls(['https://8bitgo.com/games/doom'], {
    enabled: false,
    site: SITE,
    token: TOKEN,
    env: {},
    fetchImpl: async () => {
      called = true
      return { status: 200, text: async () => '{}' }
    },
  })
  assert.equal(called, false)
  assert.equal(result.skipped, true)
})

await check('remain 归零后不再继续发后面的批次', async () => {
  // 4001 条 → 三批；第一批就把配额打光，后两批必须不发。
  const urls = Array.from({ length: 4001 }, (_, i) => `https://8bitgo.com/games/g${i}`)
  let calls = 0
  const result = await submitBaiduUrls(urls, {
    enabled: true,
    site: SITE,
    token: TOKEN,
    env: {},
    fetchImpl: async () => {
      calls++
      return { status: 200, text: async () => JSON.stringify({ remain: 0, success: 2000 }) }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.remain, 0)
  assert.equal(result.quotaExhausted, true)
  assert.equal(result.batches, 1)
})

await check('token 错误（401）立刻报出，不做无意义重试', async () => {
  let calls = 0
  await assert.rejects(
    submitBaiduUrls(['https://8bitgo.com/games/doom'], {
      enabled: true,
      site: SITE,
      token: TOKEN,
      env: {},
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls++
        return { status: 401, text: async () => JSON.stringify({ error: 401, message: 'token is not valid' }) }
      },
    }),
    /401：token is not valid/,
  )
  assert.equal(calls, 1)
})

await check('5xx 会重试，成功即止', async () => {
  let calls = 0
  const result = await submitBaiduUrls(['https://8bitgo.com/games/doom'], {
    enabled: true,
    site: SITE,
    token: TOKEN,
    env: {},
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls++
      if (calls < 3) return { status: 500, text: async () => 'oops' }
      return { status: 200, text: async () => JSON.stringify({ remain: 5, success: 1 }) }
    },
  })
  assert.equal(calls, 3)
  assert.equal(result.accepted, 1)
})

await check('not_same_site / not_valid 被原样报出，不当成成功', async () => {
  const result = await submitBaiduUrls(['https://8bitgo.com/games/doom'], {
    enabled: true,
    site: SITE,
    token: TOKEN,
    env: {},
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({ remain: 3, success: 0, not_same_site: ['https://8bitgo.com/games/doom'], not_valid: [] }),
    }),
  })
  assert.equal(result.submitted, 1)
  assert.equal(result.accepted, 0)
  assert.deepEqual(result.notSameSite, ['https://8bitgo.com/games/doom'])
})

await check('sitemap 索引的游戏 lastmod 跟数据库走', async () => {
  const xml = buildSitemapIndex({ siteUrl: SITE, gamesLastmod: '2026-09-02', staticLastmod: '2026-08-30' })
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/sitemaps\/games-zh-Hans\.xml<\/loc>\s*<lastmod>2026-09-02<\/lastmod>/)
  assert.match(xml, /<loc>https:\/\/8bitgo\.com\/sitemap-static\.xml<\/loc>\s*<lastmod>2026-08-30<\/lastmod>/)
  // 1 份静态 + 每种语言各三份（游戏 / 文章 / 平台类型）
  assert.equal((xml.match(/<sitemap>/g) || []).length, SITE_LANGUAGES.length * 3 + 1)
  // 没构建过时不写 lastmod（协议里它是可选的），别输出空标签
  assert.ok(!buildSitemapIndex({ siteUrl: SITE, gamesLastmod: '2026-09-02' }).includes('<lastmod></lastmod>'))
})

console.log(`✅ 百度推送 / sitemap 索引：${passed} 项检查通过`)
