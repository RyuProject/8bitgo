/**
 * 火山引擎机器翻译（文本翻译）的轻量客户端。
 *
 * 只翻译游戏简介（小段文本、单词量固定、低频），不上批量、不异步派发：
 *   - 玩家在详情页点「翻译」按钮，前端调 /api/games/:slug/translate-description
 *   - 这边读 description_en（没有就退到 description），调一次火山，写回 JSON 列
 *   - 同一款游戏同一语言永不再调 —— 重复点击命中缓存直接返回
 *
 * 鉴权走火山 Signature V4（HMAC-SHA256，链式派生密钥）—— 类似 AWS SigV4。
 * 手写签名而不是用 @volcengine/openapi：依赖项只多一个 crypto（Node 自带），
 * 签名算法稳定，一次写完就维护，跟 Mail.js（自管 Resend / SMTP）一个风格。
 *
 * ⚠️ 语言码：**订正一次**。这里原来的注释断言「火山只支持 ISO 639-1 短码，不支持
 *    BCP-47（zh-Hans / zh-Hant 在它眼里都是 zh）」—— **这是错的**。查官方的语言支持表
 *    （https://docs.volcengine.com/docs/4640/35107）：
 *        zh          中文(简体)
 *        zh-Hant     中文(繁体)
 *        zh-Hant-hk  中文(香港繁体)
 *        zh-Hant-tw  中文(台湾繁体)
 *    繁体是**一等语言**，不是拿 zh 凑合。VOLC_LANG 里因此有 zh-Hant。
 *
 *    但**简体源文仍然走 OpenCC**（`zh-convert.js`），理由换成了真的那几条：
 *      · 简繁之间是确定的字词映射，不需要模型；OpenCC 离线、免费、结果可复现
 *      · 走 API 要按字符计费，而全站中文正文过一遍是最大的一笔量
 *      · 档位可控（s2twp 的用词和 zh-Hant.ts 的界面文案对齐），模型给不了这个保证
 *    只有**源文不是中文**时（游戏填了 description_en）才让上游翻，目标是 zh-Hant。
 *    在这之前那一路的目标写的是 `zh`，也就是给繁体读者发**简体**译文。
 *
 *    加语种只改 VOLC_LANG 一张表。
 *
 * 验收：
 *   npm run test:translate   —— 不联网纯单元测试（语言映射 / 缓存读写 / 入参形状）
 *   curl POST /api/games/<slug>/translate-description -d '{"lang":"es"}'
 *                         —— 端到端，第一次会真打火山并落库，第二次直接返回缓存。
 */

import { createHash, createHmac } from 'node:crypto'

/** 火山翻译的 base。默认官方；测试时可指向本地 mock（scripts/test-translate.mjs） */
const HOST = 'translate.volcengineapi.com'
const REGION = 'cn-north-1'
const SERVICE = 'translate'
const ACTION = 'TranslateText'
const VERSION = '2020-06-01'

/** AK/SK 缺一个都视为没配：路由直接 503，别让签名算到一半再失败 */
export function isTranslateConfigured() {
  return Boolean(process.env.VOLC_AK && process.env.VOLC_SK)
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha256', key).update(s).digest()
const hmacHex = (key, s) => createHmac('sha256', key).update(s).digest('hex')

/**
 * 站点语言 → 火山 TranslateText 认的语言码。
 *
 * `zh-Hant` **在表里** —— 官方语言支持表里它是一等语言（还有 zh-Hant-tw / zh-Hant-hk
 * 两个地区变体）。它只在「源文不是中文」时用得上；简体源文走 OpenCC，见文件头。
 * 加语种只改这一张表。
 */
const VOLC_LANG = {
  'zh-Hans': 'zh',
  'zh-Hant': 'zh-Hant',
  en: 'en',
  es: 'es',
  fr: 'fr',
  it: 'it',
  de: 'de',
  ja: 'ja',
}

/** 站点语言对应的火山语言码；`zh-Hant` 和未知语言都返回 null */
export function volcCode(lang) {
  return VOLC_LANG[lang] ?? null
}

/**
 * 这个目标语言该走本地简繁转换而不是翻译 API。
 *
 * 注意「该走」不等于「只能走」：上游是支持 zh-Hant 的，我们是**选择**不用它
 * （免费、确定、用词可控，见文件头）。所以这个判断只在源文是简体中文时才成立 ——
 * `translatePlan` 里会再判一次源语言。
 */
export function isLocalConversion(lang) {
  return lang === 'zh-Hant'
}

/**
 * 按「**源文实际是哪种语言**」算翻译计划。
 *
 * ── 为什么要传 sourceLang（2026-09-07 修）────────────────────────
 * 这个函数原来叫 `translatePlan(lang)`，源语言**硬编码成 `'en'`**。而真实的源文经常
 * 不是英文：
 *   - 游戏简介：`description_en` 没填时退回 `description`（中文），却仍然告诉火山
 *     `SourceLanguage: 'en'` —— 拿中文冒充英文送进去，译文质量无从保证；
 *   - 文章：`posts` **根本没有英文列**，源文一律是中文，于是每一次文章翻译都在撒这个谎；
 *   - 繁体：计划是 `{ source:'en', target:'zh' }`，也就是「把英文翻成中文再当繁体用」，
 *     没填英文版的条目直接放弃 —— 现在这一路整体改走 OpenCC。
 * 所以源语言必须由调用方按「我这次真的拿了哪个字段」传进来，不能默认。
 *
 * @param {string} targetLang 站点语言（要译成什么）
 * @param {'zh-Hans'|'en'} sourceLang 源文的语言（游戏：有 descriptionEn 就是 en，否则 zh-Hans；文章：一律 zh-Hans）
 * @returns {{ passthrough: true } | { convert: true, effective: string } | { source: string, target: string, effective: string } | null}
 *   - `passthrough`：目标语言就是源文语言，不需要做任何事（路由层 400 挡回去）
 *   - `convert`：走 `zh-convert.js` 的简→繁，不花翻译 API 的钱
 *   - `{ source, target }`：调 `translateText` / `translateMarkdown`
 *   - `null`：站点不支持这个语言
 */
export function translatePlan(targetLang, sourceLang = 'zh-Hans') {
  if (isLocalConversion(targetLang)) {
    // 源文是简体中文 → 简繁转换（不花配额）
    if (sourceLang === 'zh-Hans') return { convert: true, effective: 'zh-Hant' }
    /*
      源文不是中文（游戏填了 description_en）→ 让上游翻，目标是 **zh-Hant** 而不是 zh。
      写 `zh` 是 2026-09-07 修掉的一个 bug：那样繁体读者拿到的是简体译文，
      而 zh-Hant 本来就在官方语言表里，压根不需要这么将就。
    */
    const from = volcCode(sourceLang)
    return from ? { source: from, target: 'zh-Hant', effective: 'zh-Hant' } : null
  }
  const to = volcCode(targetLang)
  const from = volcCode(sourceLang)
  if (!to) return null
  // 同一种语言不必翻。注意这是**按源文算的**：游戏填了 description_en 时 en 是 passthrough，
  // 而文章没有英文列，同一个 'en' 就必须真的翻一次。
  if (!from || to === from) return { passthrough: true }
  return { source: from, target: to, effective: targetLang }
}

/* ---------------- 官方限额 ---------------- */

/**
 * 一次请求最多几条文本。官方原话：「列表长度不超过 **16**」。
 * 见 https://docs.volcengine.com/docs/4640/65067
 */
const MAX_ITEMS = 16

/**
 * 一次请求的总文本长度上限。官方原话：「总文本长度不超过 **5000** 字符」。
 *
 * 这里取 4800 留 200 字符余量 —— 官方只说「字符」，没说按 UTF-16 码元、
 * 码点还是字节计长。差额只有 4%，换来的是不必赌这件事。
 *
 * ⚠️ 这两个数字 2026-09-07 之前**代码里根本没有**，注释写的是
 * 「官方没公开数字，实测几千字以内」—— 于是长文章必然在某一段上撞 -400。
 */
const MAX_CHARS = 4800

/** 把一条超长文本切成若干段，每段不超过 limit */
export function splitOversized(text, limit = MAX_CHARS) {
  const src = String(text ?? '')
  if (src.length <= limit) return [src]
  const out = []
  let rest = src
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    /*
      切点优先级：句末标点 > 任意空白 > 硬切。
      句末优先是因为翻译的质量取决于句子完整 —— 从句子中间断开，两半各自被
      当成独立句子翻，语序和指代都会走形。找不到就退到空白，再找不到才硬切
      （中日文长句可能整段没有空格，这一步必须存在，否则死循环）。
    */
    let cut = -1
    const sentence = window.match(/[。！？；.!?;][^。！？；.!?;]*$/)
    if (sentence && sentence.index > limit * 0.3) cut = sentence.index + 1
    if (cut < 0) {
      const ws = window.lastIndexOf(' ')
      const nl = window.lastIndexOf('\n')
      const best = Math.max(ws, nl)
      if (best > limit * 0.3) cut = best + 1
    }
    if (cut < 0) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/**
 * 把一串文本编成「一次请求装得下」的批次。
 *
 * 两条约束同时生效：条数 ≤ MAX_ITEMS **且** 总长 ≤ MAX_CHARS。只顾条数会在
 * 16 段长文上撞字符上限，只顾长度会在一堆短句上撞条数上限。
 *
 * @param {string[]} texts
 * @returns {number[][]} 每个元素是一批的下标数组
 */
export function planBatches(texts, { maxItems = MAX_ITEMS, maxChars = MAX_CHARS } = {}) {
  const batches = []
  let cur = []
  let curLen = 0
  for (let i = 0; i < texts.length; i += 1) {
    const len = String(texts[i] ?? '').length
    // 单条已经超限的情况由 translateTexts 先过 splitOversized，这里不会遇到；
    // 真遇到了也不能死循环 —— 让它自己占满一批。
    if (cur.length && (cur.length >= maxItems || curLen + len > maxChars)) {
      batches.push(cur)
      cur = []
      curLen = 0
    }
    cur.push(i)
    curLen += len
  }
  if (cur.length) batches.push(cur)
  return batches
}

/* ---------------- 单次请求 ---------------- */

/** -429（请求频率过高）值得重试，别的错误重试只是白烧配额 */
const RETRYABLE = new Set(['-429', '429', 'LimitExceeded', 'Throttling', 'TooManyRequests'])

/**
 * 签一次请求，返回 fetch 要的三件套。
 *
 * 单独抽出来是因为现在有两个调用点（单条和批量共用 translateBatch，
 * 但将来加语种检测之类的 Action 也会用同一套签名）。签名算法一个字没动。
 */
function signRequest(bodyObj) {
  const body = JSON.stringify(bodyObj)

  // UTC 时间：YYYYMMDDTHHMMSSZ（注意是「T」和「Z」字面量，format 里没有它们）
  const xDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const shortDate = xDate.slice(0, 8)

  // Query 字符串必须按 key 字典序排好再编码；这里只有两个固定 key，不用排序
  const canonicalQuery = `Action=${ACTION}&Version=${VERSION}`

  // 必须参与签名的头：content-type / host / x-content-sha256 / x-date，都按小写
  const headers = {
    'content-type': 'application/json',
    host: HOST,
    'x-content-sha256': sha256Hex(body),
    'x-date': xDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join('')

  // 1) CanonicalRequest = 方法 + URI + Query + Headers + SignedHeaders + body 哈希
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n')

  // 2) StringToSign：算法名 + 时间戳 + 凭证范围 + CanonicalRequest 哈希
  const credentialScope = `${shortDate}/${REGION}/${SERVICE}/request`
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  // 3) 派生签名密钥：SK → date → region → service → 'request'
  const kDate = hmac(process.env.VOLC_SK, shortDate)
  const kRegion = hmac(kDate, REGION)
  const kService = hmac(kRegion, SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = hmacHex(kSigning, stringToSign)

  const authorization =
    `HMAC-SHA256 Credential=${process.env.VOLC_AK}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: `${process.env.VOLC_TRANSLATE_BASE_URL || `https://${HOST}`}/?${canonicalQuery}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Date': xDate,
      'X-Content-Sha256': sha256Hex(body),
      Authorization: authorization,
    },
    body,
  }
}

/**
 * 翻译一批文本（**一次 HTTP 请求**）。调用方必须保证已经满足 16 条 / 5000 字符。
 *
 * ── 响应形状（2026-09-07 修，这是个真 bug）────────────────────
 * 官方文档写的是**顶层** `TranslationList`：
 *
 *     { "TranslationList": [{ "Translation": "...", "DetectedSourceLanguage": "en" }],
 *       "ResponseMetadata": { "RequestId": "...", "Error": null } }
 *
 * 而这里原来读的是 `json.Result.TextList[0].Translation` —— 那个路径**永远不存在**，
 * 于是无论上游返回什么都会落到 `EMPTY_TRANSLATION`，路由回 502。
 * 也就是说：**就算把 VOLC_AK / VOLC_SK 配上，这个功能也一次都没成功过。**
 * 更糟的是 `scripts/test-translate.mjs` 的 mock 照着错的形状写，测试一直是绿的 ——
 * 测试把 bug 一起固化了。为防再犯，现在的用例里有一条专门断言
 * 「`Result.TextList` 那种旧形状必须被判为无译文」。
 *
 * @param {string[]} texts
 * @param {string|undefined} source 火山语言码；**留空 = 让上游自动识别**（官方支持）
 * @param {string} target 火山语言码
 * @returns {Promise<string[]>} 与入参同序同长的译文数组
 */
export async function translateBatch(texts, source, target) {
  if (!isTranslateConfigured()) {
    const e = new Error('翻译服务未配置（缺 VOLC_AK / VOLC_SK）')
    e.code = 'NOT_CONFIGURED'
    throw e
  }
  const list = texts.map((t) => String(t ?? ''))
  if (!list.length) return []

  // SourceLanguage 是可选的（官方：不填则自动识别）。宁可不填也不要填错 ——
  // 拿中文冒充英文送进去，模型会按错误的源语言解码。
  const payload = { TargetLanguage: target, TextList: list }
  if (source) payload.SourceLanguage = source

  const { url, headers, body } = signRequest(payload)

  // 用全局 fetch（Node 18+ 自带）。timeout 用 AbortController：火山那边卡住的话，
  // 这条 HTTP 请求也跟着挂住，整条路由就跟着挂住，所以必须有上限
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(process.env.TRANSLATE_TIMEOUT_MS) || 15000)

  let json
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    const raw = await res.text()
    try {
      json = JSON.parse(raw)
    } catch {
      const e = new Error(`火山返回的不是 JSON（HTTP ${res.status}）`)
      e.code = 'BAD_RESPONSE'
      throw e
    }
  } finally {
    clearTimeout(timer)
  }

  if (json.ResponseMetadata?.Error?.Code != null) {
    const code = String(json.ResponseMetadata.Error.Code)
    const err = new Error(json.ResponseMetadata.Error.Message || code)
    err.code = code
    // 让上层的重试逻辑不用再认一遍错误码表
    err.retryable = RETRYABLE.has(code)
    throw err
  }

  const out = json.TranslationList
  if (!Array.isArray(out) || out.length !== list.length) {
    const e = new Error(`火山返回的译文条数不对（要 ${list.length} 条，回 ${Array.isArray(out) ? out.length : 'null'} 条）`)
    e.code = 'EMPTY_TRANSLATION'
    throw e
  }
  const texts2 = out.map((item) => item?.Translation)
  if (texts2.some((t) => typeof t !== 'string' || !t)) {
    const e = new Error('火山返回的结果里有空译文')
    e.code = 'EMPTY_TRANSLATION'
    throw e
  }
  return texts2
}

/** 带退避的重试 —— 只对 -429 这类「过一会儿就好」的错误重试 */
async function withRetry(fn, attempts = 3) {
  let last
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!e?.retryable || i === attempts - 1) throw e
      // 500ms、1500ms —— 免费版大约 5 QPS，撞上了等一会儿就过
      await new Promise((r) => setTimeout(r, 500 * (1 + i * 2)))
    }
  }
  throw last
}

/* ---------------- 并发 ---------------- */

/**
 * 简单并发执行器 —— 用 N 个 worker 抢同一个下标计数器，谁拿到谁干。
 * 比 p-limit 多了 14 KB 的依赖、不值得 —— 这套写法放在文件里 12 行，
 * 满足「最多 N 个并发」的需求就够。
 */
async function runWithLimit(items, mapper, limit) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await mapper(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

/* ---------------- 对外的两个入口 ---------------- */

/**
 * 翻译任意多条文本，自动分批。这是**唯一**该被业务代码调用的底层入口。
 *
 * 做三件调用方不该操心的事：
 *   1. 单条超过 5000 字符的先 `splitOversized` 切开，译完再拼回去
 *   2. 按 16 条 / 5000 字符编批，一批一次 HTTP
 *   3. 批之间并发 `concurrency` 个，-429 自动退避重试
 *
 * @param {string[]} texts
 * @param {string|undefined} source 留空 = 自动识别
 * @param {string} target
 * @param {number} [concurrency=3] 免费版火山大约 5 QPS，留 2 个余量给别的请求
 * @returns {Promise<string[]>}
 */
export async function translateTexts(texts, source, target, concurrency = 3) {
  const inputs = (texts ?? []).map((t) => String(t ?? ''))
  if (!inputs.length) return []

  // 展平成「段」，同时记住每段属于哪一条输入
  const segments = []
  const owner = []
  inputs.forEach((text, idx) => {
    if (!text.trim()) return
    for (const piece of splitOversized(text)) {
      segments.push(piece)
      owner.push(idx)
    }
  })
  if (!segments.length) return inputs.map(() => '')

  const batches = planBatches(segments)
  const results = await runWithLimit(
    batches,
    (idxs) => withRetry(() => translateBatch(idxs.map((i) => segments[i]), source, target)),
    concurrency,
  )

  // 回填：同一条输入的多段按原顺序拼回去
  const parts = inputs.map(() => [])
  batches.forEach((idxs, b) => {
    idxs.forEach((segIdx, k) => {
      parts[owner[segIdx]].push([segIdx, results[b][k]])
    })
  })
  return parts.map((list) => list.sort((a, b) => a[0] - b[0]).map(([, v]) => v).join(''))
}

/**
 * 翻译单条文本。保留这个名字是因为调用点很多（游戏简介、文章标题 / 摘要）。
 *
 * @param {string} text
 * @param {string|undefined} source 火山语言码，留空则自动识别
 * @param {string} target
 * @returns {Promise<string>} 译文
 */
export async function translateText(text, source, target) {
  const [out] = await translateTexts([text], source, target)
  if (typeof out !== 'string' || !out) {
    const e = new Error('火山返回的结果里没有译文')
    e.code = 'EMPTY_TRANSLATION'
    throw e
  }
  return out
}

/**
 * 把 Markdown 内容分段翻译。
 *
 * 为什么按段落切：文章正文很长（一篇 50KB 的博客常见 30~80 段），整篇灌进
 * `TextList` 会撞官方的 5000 字符上限。段落是天然的翻译单元，按双换行
 * （Markdown 段落分隔符）切开不会破坏 `##` 标题 / 列表 / 链接等结构标记。
 *
 * ⚠️ 2026-09-07 改成**批量**：以前是「一段一次 HTTP、并发 3」，30 段就是 30 次请求。
 * 现在按 16 条 / 5000 字符编批，同样 30 段通常 2～3 次请求就发完。
 * 计费是按字符的，所以这**不省配额** —— 省的是往返延迟和撞 QPS 上限的概率
 * （原来 30 次请求里只要有一次 -429，整篇就失败）。
 *
 * ⚠️ Markdown 内联标记（**加粗**、`代码`、[链接](url)、```代码块```）直接交给上游。
 * 大多数情况下会保留 —— 代码块是非中文、链接是 URL —— 但理论上可能把
 * `**强调**` 内部的文字按语义重写。接受偶尔的不完美，比自写规则化解析
 * （要识别代码块边界、链接语法、转义）再拼接便宜多了。
 *
 * @param {string} text            Markdown 原文
 * @param {string|undefined} source 火山语言码，留空则自动识别
 * @param {string} target
 * @param {number} [concurrency=3]
 */
export async function translateMarkdown(text, source, target, concurrency = 3) {
  if (!text || !text.trim()) return text || ''

  // 按双换行切，**保留**分隔符（用捕获组 + split）—— 不然段落之间的空白行全丢，
  // 视觉上挤成一坨，Markdown 渲染器也不喜欢没有空行分隔的段落。
  const parts = text.split(/(\n\n+)/)
  // 偶数 index 是正文块（要翻译），奇数 index 是分隔符（保持原样）
  const indices = []
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].trim()) indices.push(i)
  }
  if (!indices.length) return text

  const translated = await translateTexts(indices.map((i) => parts[i]), source, target, concurrency)
  const out = [...parts]
  indices.forEach((i, k) => {
    // 单段译文为空视为整体失败 —— 静默把原文留在那儿会得到一篇中英混排的文章
    if (!translated[k]) {
      const e = new Error('部分段落没有译文')
      e.code = 'EMPTY_TRANSLATION'
      throw e
    }
    out[i] = translated[k]
  })
  return out.join('')
}

/* ---------------- 翻译接口的限流闸（2026-09-11 补） ---------------- */

import { clientKey, isMeaningfulIp, take } from './rateLimit.js'

const HOUR = 3_600_000
const TRANSLATE_PER_IP_PER_MIN = 6
const TRANSLATE_PER_IP_PER_HOUR = 60
const TRANSLATE_GLOBAL_PER_HOUR = 600

let warnedNoRealIp = false

/**
 * `POST /api/posts/:slug/translate` 和 `POST /api/games/:slug/translate-description`
 * 的准入闸。挡住了就自己把 429 写出去并返回 false，调用方 `if (!translateGateOk(req, res)) return`。
 *
 * ⚠️ 为什么非要有：这两条路由**不需要登录**，而下游是按字符计费的火山翻译。
 * 原来的防刷理由是「缓存命中之后每款每语言只调一次」，但冷缓存对成千上万个
 * (slug, lang) 组合天然存在 —— 游戏简介又没有发布时预翻，于是每一款游戏 × 每个计费语言
 * 都是一次可以被外人白嫖的付费调用。一条 for 循环就能把账单刷上去，
 * 顺带耗尽配额让正常翻译全部失败。
 *
 * ⚠️ 拿不到真实访客 IP 时跳过按 IP 那道，只留全站兜底 —— 同 codes.js 的理由：
 * 反代没透传时所有人塌缩成同一个地址，按 IP 限会把真实用户全锁在门外。
 */
export function translateGateOk(req, res) {
  const ip = clientKey(req)
  if (isMeaningfulIp(ip)) {
    const perMin = take(`translate:ip:${ip}`, TRANSLATE_PER_IP_PER_MIN, 60_000)
    if (!perMin.ok) {
      res.status(429).json({ error: '翻译请求太频繁，请稍后再试', retryAfter: perMin.retryAfter })
      return false
    }
    const perHour = take(`translate:ip:h:${ip}`, TRANSLATE_PER_IP_PER_HOUR, HOUR)
    if (!perHour.ok) {
      res.status(429).json({ error: '翻译请求太频繁，请稍后再试', retryAfter: perHour.retryAfter })
      return false
    }
  } else if (!warnedNoRealIp) {
    warnedNoRealIp = true
    console.warn(
      `[translate] 拿到的客户端地址是 ${ip}，按 IP 限流已跳过（只剩全站总量兜底）。` +
        ' 让 nginx 透传真实 IP 即可恢复：proxy_set_header X-Forwarded-For $http_cf_connecting_ip;',
    )
  }
  const global = take('translate:global', TRANSLATE_GLOBAL_PER_HOUR, HOUR)
  if (!global.ok) {
    console.warn('[translate] 全站翻译配额已用尽 —— 可能正在被刷，检查 nginx 是否透传了真实 IP')
    res.status(429).json({ error: '当前请求过多，请稍后再试', retryAfter: global.retryAfter })
    return false
  }
  return true
}
