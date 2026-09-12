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
/**
 * ⚠️ **必须是假的。**
 *
 * 这里原来放的是**线上那把真的准入密钥**，而这个文件是提交进 git 的，
 * 仓库又是公开的 —— 等于把它挂在了互联网上。拿到它的人可以用我们的配额
 * 往百度提交任意 8bitgo.com 下的 URL，包括不存在的页面。
 *
 * 密钥是**私密**的（见 server/.env.example 里那段），只能放 .env。
 * 下面「密钥没有出现在仓库里」那条用例就是防这件事再发生的。
 */
const TOKEN = 'testtoken0000000'

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
  /*
    ⚠️ site **不做百分号编码**：百度文档的示例和平台上「API 提交」页面给的地址
    都是 `site=https://8bitgo.com` 这种原样写法。两种按 RFC 3986 等价，
    但 site 对不上的症状是 not_same_site —— 一条都不会收、且对方不会告诉你
    它解出了什么。所以按对方文档的形式发，把这个变量从排查清单里划掉。
  */
  assert.equal(href, `http://data.zz.baidu.com/urls?site=${SITE}&token=${TOKEN}`)
  assert.ok(!href.includes('%3A'), 'site 被百分号编码了')
  assert.equal(redactEndpoint(href), `http://data.zz.baidu.com/urls?site=${SITE}&token=***`)
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

/* ─────────── 「success 一直是 0」要留下线索 ───────────
   百度可以在 HTTP 200、没有 error、not_same_site / not_valid 都是空数组的情况下，
   回一个比提交数小的 success。原来这种响应在我们这边的全部产出是一行
   「已提交 40 个 URL，百度收下 0 个」—— 看上去像在正常工作，实际一条没进去，
   而且日志里没有任何可查的东西。下面三条守的就是这个。 */

const okFetch = (body) => async () => ({ status: 200, text: async () => JSON.stringify(body) })
const push = (urls, body, extra = {}) =>
  submitBaiduUrls(urls, { enabled: true, site: SITE, token: TOKEN, env: {}, fetchImpl: okFetch(body), ...extra })

const TWO = ['https://8bitgo.com/games/doom', 'https://8bitgo.com/games/quake']

await check('⚠️ 收下的比提交的少、百度又不说原因 —— 记成 unexplained', async () => {
  const r = await push(TWO, { remain: 97, success: 0 })
  assert.equal(r.submitted, 2)
  assert.equal(r.accepted, 0)
  assert.equal(r.unexplained, 2, '差额没被记下来 —— 「一直是 0」就又没有线索了')
})

await check('百度自己说明了的那部分，不重复算进 unexplained', async () => {
  const one = await push(TWO, { remain: 97, success: 1, not_same_site: ['https://8bitgo.com/games/quake'] })
  assert.equal(one.notSameSite.length, 1)
  assert.equal(one.unexplained, 0, 'not_same_site 里的那条被重复算了一遍')

  const viaFailed = await push(TWO, { remain: 97, success: 1, failed: 1 })
  assert.equal(viaFailed.failed, 1, 'failed 字段没被读出来')
  assert.equal(viaFailed.unexplained, 0)
})

await check('全收下时 unexplained 是 0（别到处报警）', async () => {
  const r = await push(TWO, { remain: 97, success: 2 })
  assert.equal(r.unexplained, 0)
  assert.equal(r.failed, 0)
})

await check('原始响应**原样**交给调用方（--probe 靠它）', async () => {
  /*
    ⚠️ 必须是原文，不能是「解析完再 JSON.stringify 回去」。
    第一版这条用例就是那么写的，结果是：把实现改成 stringify(解析结果) 之后
    测试照样全绿 —— 因为那个 fixture 恰好能完美往返。
    所以这里换成两个**往返不回去**的响应，它们也正是排查时最需要原文的两种。
  */
  const seen = []
  const opts = (text) => ({
    enabled: true, site: SITE, token: TOKEN, env: {},
    onRawResponse: (r) => seen.push(r),
    fetchImpl: async () => ({ status: 200, text: async () => text }),
  })

  // 1) 合法 JSON，但带着缩进和我们没见过的字段
  const pretty = '{\n  "remain": 97,\n  "success": 0,\n  "这个字段我们没见过": 1\n}'
  await submitBaiduUrls(['https://8bitgo.com/'], opts(pretty))
  assert.equal(seen[0].status, 200)
  assert.equal(seen[0].text, pretty, '响应被重新序列化过了 —— 原文的格式和未知字段都会丢')
  assert.deepEqual(seen[0].batch, ['https://8bitgo.com/'])

  // 2) 根本不是 JSON：中间隔着反代 / WAF 时就是这样，而这时原文是唯一的线索
  const html = '<html><head><title>502 Bad Gateway</title></head></html>'
  await assert.rejects(() => submitBaiduUrls(['https://8bitgo.com/'], opts(html)))
  assert.equal(seen[1].text, html, '非 JSON 的响应体被吞了 —— 那正是最需要看到原文的时候')
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

/* ─────────── 密钥不许进仓库 ───────────
   这几条是 2026-09-12 加的，起因是**线上那把真的准入密钥就写在本文件第 19 行**，
   而这个仓库是公开的 —— 从 2026-09-02 那次提交起，它一直挂在互联网上。
   准入密钥能用我们的配额往百度提交任意 8bitgo.com 下的 URL。
   改掉一次不够，得有东西盯着它别再回来。 */

await check('⚠️ .env.example 里不带任何真密钥值', async () => {
  const fs = await import('node:fs')
  const example = fs.readFileSync(new URL('../server/.env.example', import.meta.url), 'utf8')
  const line = example.split('\n').find((l) => l.trim().startsWith('BAIDU_PUSH_TOKEN='))
  assert.ok(line, '.env.example 里没有 BAIDU_PUSH_TOKEN 这一行了？')
  assert.equal(line.trim(), 'BAIDU_PUSH_TOKEN=', '.env.example 里填了值 —— 示例文件是进 git 的')
})

await check('⚠️ 本机 .env 里那把真密钥，没有出现在任何一个被 git 跟踪的文件里', async () => {
  /*
    只有装了 git、而且本机确实配了密钥时才真的查得动（CI 上通常两者都没有，
    那就跳过 —— 这条守的是**开发机**，密钥泄露正是从开发机出去的）。
    不把密钥拼进错误信息里：那会把它写进 CI 日志，等于换个地方再泄一次。
  */
  const fs = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const envPath = new URL('../server/.env', import.meta.url)
  if (!fs.existsSync(envPath)) {
    console.log('    （本机没有 server/.env，跳过）')
    return
  }
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.trim().startsWith('BAIDU_PUSH_TOKEN='))
  const token = line ? line.split('=').slice(1).join('=').trim() : ''
  if (!token) {
    console.log('    （本机没配 BAIDU_PUSH_TOKEN，跳过）')
    return
  }
  let hits = ''
  try {
    hits = String(execFileSync('git', ['grep', '-I', '-l', '--fixed-strings', '-e', token], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim()
  } catch {
    hits = '' // git grep 没匹配到时退出码是 1，这里就是我们要的结果
  }
  assert.equal(hits, '', `真密钥出现在这些被跟踪的文件里：\n${hits}\n（换掉它，并去搜索资源平台重置准入密钥）`)
})

console.log(`✅ 百度推送 / sitemap 索引：${passed} 项检查通过`)
