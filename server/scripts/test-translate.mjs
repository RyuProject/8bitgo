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

const { isTranslateConfigured, translatePlan, translateText, volcCode, isLocalConversion, splitOversized, planBatches } =
  await import('../src/translate.js')

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

/* ---------------- translatePlan：繁体的两条路 ---------------- */
try {
  /**
   * ⚠️ 这一节被改过**两次**，两次的前提都要记住，别再绕回去：
   *
   * 最早：`translatePlan('zh-Hant').source === 'en' && .target === 'zh'`
   *   —— 「把英文版翻成 zh 再当繁体用」。没填英文版的条目直接放弃，
   *   于是繁体读者一直看简体原文，GSC 把 /zh-Hant/* 判成 /zh-Hans 的重复页。
   *
   * 第一次改：改走 OpenCC，理由写的是「火山不认 BCP-47，zh-Hans / zh-Hant
   *   在它眼里都是 zh」。**这个理由是错的** —— 那是照抄了代码里一句没核实的旧注释。
   *   查官方语言支持表（docs 4640/35107）：`zh-Hant` 是一等语言，
   *   还有 `zh-Hant-tw` / `zh-Hant-hk` 两个地区变体。
   *
   * 现在：简体源文**仍然**走 OpenCC，但理由换成真的那几条 —— 免费、结果可复现、
   *   档位可控（s2twp 的用词和 zh-Hant.ts 的界面文案对齐）。而源文不是中文时
   *   让上游翻，目标是 **zh-Hant**（以前写 zh，等于给繁体读者发简体）。
   */
  // 简体源文 → 本地转换，不花配额
  assert.deepEqual(translatePlan('zh-Hant', 'zh-Hans'), { convert: true, effective: 'zh-Hant' })
  assert.ok(isLocalConversion('zh-Hant'), 'zh-Hant 必须被认成本地转换')
  assert.ok(!isLocalConversion('fr'), '别的语言不能被认成本地转换')

  // zh-Hant **在**语言表里（这一条以前是反着断言的，是个错）
  assert.equal(volcCode('zh-Hant'), 'zh-Hant', 'zh-Hant 是官方支持的语言码，必须在表里')
  assert.equal(volcCode('zh-Hans'), 'zh')

  // 源文是英文 → 让上游翻，目标必须是 zh-Hant 而不是 zh
  assert.deepEqual(translatePlan('zh-Hant', 'en'), { source: 'en', target: 'zh-Hant', effective: 'zh-Hant' })
  // 简繁不能被当成同一种语言而 passthrough 掉
  assert.notEqual(volcCode('zh-Hans'), volcCode('zh-Hant'))
  ok('繁体：简体源文走 OpenCC，英文源文走 API 且目标是 zh-Hant')
} catch (e) {
  bad('繁体：简体源文走 OpenCC，英文源文走 API 且目标是 zh-Hant', e)
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
      // ⚠️ 官方形状是**顶层** TranslationList，不是 Result.TextList（见 translateBatch 的注释）
      TranslationList: [{ Translation: 'Hola mundo', DetectedSourceLanguage: 'en' }],
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

/* —— 用例 5：空响应 —— */
try {
  nextMock = { status: 200, body: { ResponseMetadata: { RequestId: 'r2' } } }
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'EMPTY_TRANSLATION' })
  ok('空译文翻成 EMPTY_TRANSLATION')
} catch (e) {
  bad('空译文翻成 EMPTY_TRANSLATION', e)
}

/* —— 用例 5b：**旧的错形状必须被判为无译文** —— */
try {
  /**
   * 2026-09-07 之前解析的是 `json.Result.TextList[0].Translation`，而官方返回的是
   * 顶层 `TranslationList` —— 那个路径永远不存在，功能一次都没成功过。
   * 而当时的 mock 照着错形状写，测试一直是绿的：**测试把 bug 一起固化了。**
   * 这条断言就是防再犯 —— 谁把解析改回 Result.TextList，这里会红。
   */
  nextMock = {
    status: 200,
    body: { ResponseMetadata: { RequestId: 'r3' }, Result: { TextList: [{ Translation: '不该被读到' }] } },
  }
  await assertError(() => translateText('Hi', 'en', 'es'), { code: 'EMPTY_TRANSLATION' })
  ok('Result.TextList 那种旧形状不被认，防止解析改回去')
} catch (e) {
  bad('Result.TextList 那种旧形状不被认，防止解析改回去', e)
}

/* —— 用例 5c：SourceLanguage 留空 = 让上游自动识别 —— */
try {
  // 官方文档：SourceLanguage 可选，不填则自动识别。宁可不填也不要填错。
  nextMock = { status: 200, body: { ResponseMetadata: {}, TranslationList: [{ Translation: 'auto' }] } }
  await translateText('Hi', undefined, 'es')
  const body = JSON.parse(lastMock.body)
  assert.equal('SourceLanguage' in body, false, '源语言留空时 body 里不该出现 SourceLanguage')
  assert.deepEqual(body, { TargetLanguage: 'es', TextList: ['Hi'] })
  ok('源语言留空时不发 SourceLanguage 字段')
} catch (e) {
  bad('源语言留空时不发 SourceLanguage 字段', e)
}

/* —— 用例 5d：-429 自动退避重试 —— */
try {
  let hits = 0
  nextMock = { status: 200, body: { ResponseMetadata: {}, TranslationList: [{ Translation: 'ok' }] } }
  // 用一个自增的 mock：第一次回 -429，第二次成功
  const prev = mockServer.listeners('request')[0]
  mockServer.removeListener('request', prev)
  mockServer.on('request', (req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      hits += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        hits === 1
          ? JSON.stringify({ ResponseMetadata: { Error: { Code: -429, Message: '请求频率过高' } } })
          : JSON.stringify({ ResponseMetadata: {}, TranslationList: [{ Translation: '重试成功' }] }),
      )
    })
  })
  const out = await translateText('Hi', 'en', 'es')
  assert.equal(out, '重试成功')
  assert.equal(hits, 2, '应该正好重试一次')
  mockServer.removeAllListeners('request')
  mockServer.on('request', prev)
  ok('-429 退避重试（错误码是数字也认）')
} catch (e) {
  bad('-429 退避重试（错误码是数字也认）', e)
}

/* —— 用例 5e：官方限额的分批与切分 —— */
try {
  // 官方：列表长度 ≤ 16、总文本长度 ≤ 5000（我们留余量取 4800）
  const short = Array.from({ length: 20 }, (_, i) => `p${i}`)
  const batches = planBatches(short)
  assert.equal(batches.length, 2, '20 条短文本按 16 条上限应该编成 2 批')
  assert.equal(batches[0].length, 16)
  assert.equal(batches[1].length, 4)

  // 字符上限也要生效：3 条 2000 字的，第 3 条必须挪到下一批
  const long = [ 'a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000) ]
  const b2 = planBatches(long)
  assert.equal(b2.length, 2, '总长超 4800 时必须换批')
  assert.deepEqual(b2[0], [0, 1])

  // 单条超长要切开，且拼回来一个字不丢
  const oversized = ('这是一个很长的句子。'.repeat(800))
  const pieces = splitOversized(oversized)
  assert.ok(pieces.length > 1, '超过上限的单条必须被切开')
  assert.ok(pieces.every((x) => x.length <= 4800), '每一段都不许超过上限')
  assert.equal(pieces.join(''), oversized, '切开再拼必须还原原文')
  // 优先在句末切：除了最后一段，每段都该以句号结尾
  assert.ok(pieces.slice(0, -1).every((x) => x.endsWith('。')), '应该在句末切，不是硬切')
  // 没有标点也不能死循环
  const noPunct = splitOversized('あ'.repeat(10000))
  assert.ok(noPunct.length >= 3 && noPunct.every((x) => x.length <= 4800))
  ok('16 条 / 4800 字符的分批与超长切分')
} catch (e) {
  bad('16 条 / 4800 字符的分批与超长切分', e)
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
        TranslationList: translations.map((tr) => ({ Translation: tr })),
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
  /**
   * ⚠️ 这里以前断言的是 3 次请求（一段一次）。2026-09-07 改成批量之后
   * 3 个短段落装在同一个 TextList 里，**只发 1 次**。
   * 计费按字符所以不省配额，省的是往返延迟和撞 -429 的概率。
   */
  assert.equal(mockCalls, 1, '三个短段落应该批在同一次请求里')
  ok('translateMarkdown 多段保留双换行，且批在一次请求里')
} catch (e) {
  bad('translateMarkdown 多段保留双换行，且批在一次请求里', e)
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
            TranslationList: list.map((t) => ({ Translation: 'OK_' + t.slice(0, 3) })),
          }),
        )
      }, 50)
    })
  })
  /**
   * 40 段、并发 2。段数必须足够压出**多个批次** —— 批量化之后 10 个短段落
   * 只有 1 批，并发上限根本没机会被触碰，那个用例就成了摆设。
   * 40 段 ÷ 每批 16 条 = 3 批。
   */
  const many = Array.from({ length: 40 }, (_, i) => `P${i + 1}`).join('\n\n')
  await translateMarkdown(many, 'zh', 'en', 2)
  assert.equal(mockCalls, 3, `40 段应该编成 3 批，实测 ${mockCalls} 次请求`)
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
