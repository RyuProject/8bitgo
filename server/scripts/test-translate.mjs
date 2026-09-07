/**
 * 翻译服务的不联网自测。
 *
 *   node scripts/test-translate.mjs     （或 npm run test:translate）
 *
 * 测三件事：
 *   1. translatePlan 站点语言 → 火山语言的映射。**签名是 (target, source) 两个参数**
 *      —— 源语言由调用方按「我这次真的拿了哪个字段」传入，不能硬编码（详 translate.js）
 *      同一个目标语言在「源文是中文」和「源文是英文」两种情况下计划**不同**，这是重点
 *   2. V4 签名的规范化环节（headers、CanonicalRequest、StringToSign、时间格式）
 *   3. 端到端：起一个本地 HTTP mock（火山替身），调 translateText 后看请求体形状对不对、
 *      限流错误和签名错误能被正确解析成 Error 的 code
 *
 * 不真打火山，CI 里也能跑。
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

process.env.VOLC_AK = 'AK_TEST'
process.env.VOLC_SK = 'SK_TEST'

const { isTranslateConfigured, translatePlan, translateText, volcCode, isLocalConversion } = await import('../src/translate.js')

let failed = 0
const ok = (name) => console.log(`  ✅ ${name}`)
const bad = (name, e) => {
  failed++
  console.error(`  ❌ ${name}\n     ${e?.message || e}`)
}

/** 抓错误并断言：assert.rejects 第二参数在 Node 22 接受 predicate 但校验有点琐碎，
 *  改成显式 try/catch 让意图更清楚 */
async function assertError(fn, { code, message } = {}) {
  let err
  try {
    await fn()
  } catch (e) {
    err = e
  }
  assert.ok(err, '应该抛错')
  if (code !== undefined) assert.equal(err.code, code, `error.code`)
  if (message) assert.match(err.message, message)
  return err
}

/* ---------------- translatePlan：繁体走本地转换 ---------------- */
try {
  /**
   * ⚠️ 这一节 2026-09-07 整体改过。以前断言的是
   *   translatePlan('zh-Hant').source === 'en' && .target === 'zh'
   * 也就是「把英文版翻成 zh 再当繁体用」。那个方案有两个致命处：火山不认 BCP-47，
   * zh-Hans / zh-Hant 在它眼里都是 zh，「把 zh 翻成 zh」是空操作；而没填英文版的
   * 条目直接放弃，于是繁体读者一直在看简体原文 —— GSC 把 /zh-Hant/* 判成
   * /zh-Hans 的重复页，根子就在这里。现在繁体走 zh-convert.js 的 OpenCC。
   */
  assert.deepEqual(translatePlan('zh-Hant', 'zh-Hans'), { convert: true, effective: 'zh-Hant' })
  assert.ok(isLocalConversion('zh-Hant'), 'zh-Hant 必须被认成本地转换')
  assert.ok(!isLocalConversion('fr'), '别的语言不能被认成本地转换')
  // 火山语言表里刻意没有 zh-Hant —— 有的话就说明有人把它加回去了
  assert.equal(volcCode('zh-Hant'), null, 'VOLC_LANG 里不许出现 zh-Hant')
  assert.equal(volcCode('zh-Hans'), 'zh')
  // 源文是英文时繁体读者该看翻译，不是把英文原样搬过去 —— 退回让火山把 en 翻成 zh
  assert.deepEqual(translatePlan('zh-Hant', 'en'), { source: 'en', target: 'zh', effective: 'zh-Hant' })
  ok('繁体走本地简繁转换，不再拿英文中转')
} catch (e) {
  bad('繁体走本地简繁转换，不再拿英文中转', e)
}

/* ---------------- translatePlan：passthrough 跟着源语言变 ---------------- */
try {
  /**
   * 这一组是这次改动的核心：**同一个目标语言，源文不同则计划不同**。
   *
   * `en` 以前无条件 passthrough，于是 POST /api/posts/:slug/translate 对英文一律 400 ——
   * posts 表根本没有英文列，`/en/blog` 因此永远显示中文，而且没有任何入口能改。
   */
  // 文章：源文一律中文 → en 必须真翻一次
  assert.deepEqual(translatePlan('en', 'zh-Hans'), { source: 'zh', target: 'en', effective: 'en' })
  // 游戏：填了 description_en → 源文就是英文 → en 才是 passthrough
  assert.deepEqual(translatePlan('en', 'en'), { passthrough: true })
  // 基准语言对自己永远 passthrough
  assert.deepEqual(translatePlan('zh-Hans', 'zh-Hans'), { passthrough: true })

  // 其余五种：两种源文下都要有计划，且 source 跟着源文走
  for (const lang of ['es', 'fr', 'it', 'de', 'ja']) {
    const fromZh = translatePlan(lang, 'zh-Hans')
    const fromEn = translatePlan(lang, 'en')
    assert.ok(fromZh && !fromZh.passthrough && !fromZh.convert, `${lang} 从中文必须有翻译计划`)
    assert.equal(fromZh.source, 'zh', `${lang}：源文是中文时 source 必须是 zh，不能是硬编码的 en`)
    assert.equal(fromEn.source, 'en', `${lang}：源文是英文时 source 必须是 en`)
    assert.equal(fromZh.effective, lang, `${lang}.effective 必须就是 lang 自身`)
  }

  // 未知语种 / 取空
  assert.equal(translatePlan('klingon', 'zh-Hans'), null)
  assert.equal(translatePlan('', 'zh-Hans'), null)
  ok('passthrough 与 source 都跟着源语言变，不再硬编码 en')
} catch (e) {
  bad('passthrough 与 source 都跟着源语言变，不再硬编码 en', e)
}

/* ---------------- isTranslateConfigured ---------------- */
try {
  assert.equal(isTranslateConfigured(), true)
  delete process.env.VOLC_AK
  assert.equal(isTranslateConfigured(), false)
  process.env.VOLC_AK = 'AK_TEST'
  ok('isTranslateConfigured 在缺 AK / SK 时返回 false')
} catch (e) {
  bad('isTranslateConfigured 在缺 AK / SK 时返回 false', e)
}

/* ---------------- V4 签名 + 端到端（起本地 mock） ---------------- */

/**
 * 下一次 mock 返回这个。setUp() 之后 await 调用端点就能拿到。
 * 同时记录最后一次请求的形状，供测试断言用。
 *
 * raw=true: 用例 4 故意测「不是 JSON 响应」，body 原样发回，不再 JSON.stringify 包一层。
 */
let nextMock = null
let lastMock = null

const mockServer = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    lastMock = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: raw,
    }
    // 必须有 Authorization 才回，否则请求肯定到不了
    if (!req.headers.authorization) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: 'AuthFailure', Message: 'no auth header' } } }))
      return
    }
    if (nextMock.raw) {
      res.writeHead(nextMock.status, { 'Content-Type': 'text/html' })
      res.end(String(nextMock.body))
      return
    }
    res.writeHead(nextMock.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(nextMock.body))
  })
})
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r))
const PORT = mockServer.address().port
// 翻译模块每次调用重读这个环境变量。这里设一次就够。
process.env.VOLC_TRANSLATE_BASE_URL = `http://127.0.0.1:${PORT}`

async function mockCall(handler) {
  nextMock = handler()
  return translateText('Hello world', 'en', 'es')
}

/* —— 用例 1：成功路径 —— */
try {
  const out = await mockCall(() => ({
    status: 200,
    body: {
      ResponseMetadata: { RequestId: 'r1', Action: 'TranslateText', Version: '2020-06-01', Service: 'translate', Region: 'cn-north-1' },
      Result: { TextList: [{ Translation: 'Hola mundo', DetectedSourceLanguage: 'en' }] },
    },
  }))
  assert.equal(out, 'Hola mundo')

  // 请求体形状：Method = POST, Action + Version 在 query, body 是合法 JSON
  assert.equal(lastMock.method, 'POST')
  assert.match(lastMock.url, /\?Action=TranslateText&Version=2020-06-01$/)
  const body = JSON.parse(lastMock.body)
  assert.deepEqual(body, { SourceLanguage: 'en', TargetLanguage: 'es', TextList: ['Hello world'] })

  // 签名头必须齐全
  assert.match(lastMock.headers.authorization, /^HMAC-SHA256 Credential=AK_TEST\/\d{8}\/cn-north-1\/translate\/request, /)
  assert.match(lastMock.headers['x-date'], /^\d{8}T\d{6}Z$/)
  assert.match(lastMock.headers['x-content-sha256'], /^[a-f0-9]{64}$/)
  ok('V4 签名头 + 请求体形状')
} catch (e) {
  bad('V4 签名头 + 请求体形状', e)
}

/* —— 用例 2：火山的 AuthFailure —— */
try {
  nextMock = { status: 401, body: { ResponseMetadata: { Error: { Code: 'AuthFailure', Message: 'AK/SK wrong' } } } }
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'AuthFailure', message: /AK\/SK/i })
  ok('AuthFailure 错误码透传')
} catch (e) {
  bad('AuthFailure 错误码透传', e)
}

/* —— 用例 3：LimitExceeded —— */
try {
  nextMock = { status: 429, body: { ResponseMetadata: { Error: { Code: 'LimitExceeded', Message: 'qps' } } } }
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'LimitExceeded' })
  ok('LimitExceeded 错误码透传')
} catch (e) {
  bad('LimitExceeded 错误码透传', e)
}

/* —— 用例 4：返回不是 JSON（HTML 错误页） —— */
try {
  nextMock = { status: 502, raw: true, body: '<html>nginx error</html>' }
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'BAD_RESPONSE' })
  ok('非 JSON 响应翻成 BAD_RESPONSE')
} catch (e) {
  bad('非 JSON 响应翻成 BAD_RESPONSE', e)
}

/* —— 用例 5：返回结构没有 TextList —— */
try {
  nextMock = { status: 200, body: { ResponseMetadata: { RequestId: 'r2' }, Result: {} } }
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'EMPTY_TRANSLATION' })
  ok('空译文翻成 EMPTY_TRANSLATION')
} catch (e) {
  bad('空译文翻成 EMPTY_TRANSLATION', e)
}

/* —— 用例 6：缺 AK / SK 时不去真打火山 —— */
try {
  // 关掉配置，立刻调用应该直接抛 NOT_CONFIGURED，根本不该动 mock
  const beforeBody = lastMock ? lastMock.body : null
  delete process.env.VOLC_AK
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'NOT_CONFIGURED' })
  process.env.VOLC_AK = 'AK_TEST'
  // mock 没被动过 —— 防止有人改了入口逻辑顺路发了请求
  const afterBody = lastMock ? lastMock.body : null
  assert.equal(afterBody, beforeBody, '缺 AK 时不应该再发请求')
  ok('缺 AK / SK 时不去发请求')
} catch (e) {
  process.env.VOLC_AK = 'AK_TEST'
  bad('缺 AK / SK 时不去发请求', e)
}

mockServer.close()

/* ---------------- translateMarkdown ----------------
 * 这一组是在 mock server 关闭之后做的——上面的 mock 已经 listen 住了所有调用，
 * 重启一个用别的端口，免得和之前的 mock 互相干扰。
 */
const { translateMarkdown } = await import('../src/translate.js')

let mockCalls = 0
let mockRouteByText = () => 'TRANSLATED'
const mdMock = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    mockCalls++
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* ignore */
    }
    const list = Array.isArray(body.TextList) ? body.TextList : []
    const translations = list.map((t) => mockRouteByText(t))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ResponseMetadata: { RequestId: 'md' },
        Result: { TextList: translations.map((tr) => ({ Translation: tr })) },
      }),
    )
  })
})
await new Promise((r) => mdMock.listen(0, '127.0.0.1', r))
process.env.VOLC_TRANSLATE_BASE_URL = `http://127.0.0.1:${mdMock.address().port}`

/* —— 用例 7：空字符串直接返回 —— */
try {
  assert.equal(await translateMarkdown('', 'zh', 'en'), '')
  assert.equal(await translateMarkdown('   \n\n  ', 'zh', 'en'), '   \n\n  ')  // 全空白视作"无内容"原样返回
  ok('translateMarkdown 空输入原样返回')
} catch (e) {
  bad('translateMarkdown 空输入原样返回', e)
}

/* —— 用例 8：单段只发一次请求 —— */
try {
  mockCalls = 0
  mockRouteByText = (t) => `[${t}]`
  const out = await translateMarkdown('一段', 'zh', 'en')
  assert.equal(out, '[一段]')
  assert.equal(mockCalls, 1)
  ok('translateMarkdown 单段 = 一次调用')
} catch (e) {
  bad('translateMarkdown 单段 = 一次调用', e)
}

/* —— 用例 9：多段按段落切，**保留双换行** —— */
try {
  mockCalls = 0
  mockRouteByText = (t) => `T(${t})`
  const md = `第一段

第二段


第四段（中间空两行）`
  const out = await translateMarkdown(md, 'zh', 'en')
  // 分隔符原样保留：第一段↔第二段之间是 2 个换行，第二段↔第四段之间是 3 个换行（中间空两行）
  assert.equal(out, 'T(第一段)\n\nT(第二段)\n\n\nT(第四段（中间空两行）)')
  assert.equal(mockCalls, 3, '应该发 3 次请求（一段一次）')
  ok('translateMarkdown 多段保留双换行、并各自翻译')
} catch (e) {
  bad('translateMarkdown 多段保留双换行、并各自翻译', e)
}

/* —— 用例 10：单段失败抛错（整篇视为失败） —— */
try {
  mockRouteByText = () => {
    throw new Error('mock 应该没被调用')
  }
  // 直接 mock network 失败：随便一个非 2xx
  mockRouteByText = () => ({ translation: 'x' })
  // 让第二次失败：用一个会拒绝的 base url 即可
  process.env.VOLC_TRANSLATE_BASE_URL = 'http://127.0.0.1:1'  // 不可达
  await assertError(() => translateMarkdown('one\n\ntwo', 'zh', 'en'))
  process.env.VOLC_TRANSLATE_BASE_URL = `http://127.0.0.1:${mdMock.address().port}`  // 恢复
  ok('translateMarkdown 单段失败会冒泡（整篇失败）')
} catch (e) {
  process.env.VOLC_TRANSLATE_BASE_URL = `http://127.0.0.1:${mdMock.address().port}`
  bad('translateMarkdown 单段失败会冒泡（整篇失败）', e)
}

/* —— 用例 11：自定义并发上限不被顶破 —— */
let realRoute = null
try {
  mockCalls = 0
  mockRouteByText = (t) => ({ Translation: `c(${t})` })
  let peakConcurrent = 0
  let current = 0
  realRoute = mdMock.listeners('request')[0]
  mdMock.removeListener('request', realRoute)
  mdMock.on('request', (req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      current++
      peakConcurrent = Math.max(peakConcurrent, current)
      // 模拟火山响应延迟
      setTimeout(() => {
        current--
        mockCalls++
        const body = JSON.parse(raw || '{}')
        const list = body.TextList || []
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ResponseMetadata: {},
            Result: {
              TextList: list.map((t) => ({ Translation: 'OK_' + t.slice(0, 3) })),
            },
          }),
        )
      }, 50)
    })
  })
  // 10 段、并发 2
  const ten = Array.from({ length: 10 }, (_, i) => `P${i + 1}`).join('\n\n')
  await translateMarkdown(ten, 'zh', 'en', 2)
  assert.equal(mockCalls, 10, '10 段都应该被翻译')
  assert.ok(peakConcurrent <= 2, `并发上限 2 时峰值应该是 2，实测 ${peakConcurrent}`)
  // 恢复 mock：后面的测试可能还会用（虽然现在就最后一个了，留个干净状态）
  mdMock.removeAllListeners('request')
  mdMock.on('request', realRoute)
  ok('translateMarkdown 不会顶破并发上限')
} catch (e) {
  bad('translateMarkdown 不会顶破并发上限', e)
} finally {
  // 不管上面成不成功，都把原始 handler 装回去，避免污染下一次跑测试
  if (realRoute && !mdMock.listeners('request').includes(realRoute)) {
    mdMock.removeAllListeners('request')
    mdMock.on('request', realRoute)
  }
}

mdMock.close()

console.log(failed ? `\n${failed} 项断言失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
