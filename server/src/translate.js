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
 * ⚠️ 语言码：火山 API 只支持 ISO 639-1 短码（zh / en / ja / fr / es / it / de / ru / pt），
 *    **不**支持 BCP-47（zh-Hans / zh-Hant 在它眼里都是 zh）。所以：
 *      繁中（zh-Hant）**不走这里** —— 简繁之间是字词映射不是翻译，交给
 *      `zh-convert.js` 的 OpenCC（离线、确定、免费、能直接吃简体原文）。
 *      2026-09-07 之前这一路是「把英文版翻成 zh 再当繁体用」，没填英文版的条目
 *      直接放弃，于是繁体用户一直在看简体原文 —— 这是 Search Console 把
 *      /zh-Hant/* 判成 /zh-Hans 重复页的直接原因。
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
 * 站点语言 → 火山 TranslateText 认的 ISO 639-1 短码。
 *
 * ⚠️ 火山**不**认 BCP-47（`zh-Hans` / `zh-Hant` 在它眼里都是 `zh`），所以这张表里
 * **没有 zh-Hant** —— 繁体不是翻译问题，是字词映射问题，走 `zh-convert.js` 的 OpenCC。
 * 加语种只改这一张表。
 */
const VOLC_LANG = {
  'zh-Hans': 'zh',
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

/** 这个目标语言该走本地简繁转换而不是翻译 API */
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
    // 源文本来就是中文才谈得上简繁转换。源文是英文时繁体读者该看的是翻译，
    // 不是「把英文原样搬过去」—— 这种情况退回让火山把 en 翻成 zh。
    if (sourceLang === 'zh-Hans') return { convert: true, effective: 'zh-Hant' }
    const from = volcCode(sourceLang)
    return from ? { source: from, target: 'zh', effective: 'zh-Hant' } : null
  }
  const to = volcCode(targetLang)
  const from = volcCode(sourceLang)
  if (!to) return null
  // 同一种语言不必翻。注意这是**按源文算的**：游戏填了 description_en 时 en 是 passthrough，
  // 而文章没有英文列，同一个 'en' 就必须真的翻一次。
  if (!from || to === from) return { passthrough: true }
  return { source: from, target: to, effective: targetLang }
}

/**
 * 真正的请求。失败抛带 code 的 Error，路由层把它映成 502/401。
 * @param {string} text   待翻译的单条文本（玩家点「翻译」时一整段简介就一次）
 * @param {string} source 火山接受的源语言码（'en' / 'zh'）
 * @param {string} target 火山接受的目标语言码（'zh' / 'en' / 'es' / 'fr' / 'it' / 'de' / 'ja'）
 * @returns {Promise<string>} 译文
 */
export function translateText(text, source, target) {
  if (!isTranslateConfigured()) {
    const e = new Error('翻译服务未配置（缺 VOLC_AK / VOLC_SK）')
    e.code = 'NOT_CONFIGURED'
    throw e
  }
  const body = JSON.stringify({ SourceLanguage: source, TargetLanguage: target, TextList: [text] })

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

  const url = `${process.env.VOLC_TRANSLATE_BASE_URL || `https://${HOST}`}/?${canonicalQuery}`
  const reqHeaders = {
    'Content-Type': 'application/json',
    'X-Date': xDate,
    'X-Content-Sha256': sha256Hex(body),
    Authorization: authorization,
  }

  // 用全局 fetch（Node 18+ 自带）。timeout 用 AbortController：火山那边卡住的话，
  // 这条 HTTP 请求也跟着挂住，整条路由就跟着挂住，所以必须有上限
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(process.env.TRANSLATE_TIMEOUT_MS) || 15000)

  return fetch(url, { method: 'POST', headers: reqHeaders, body, signal: controller.signal })
    .then(async (res) => {
      const raw = await res.text()
      let json
      try {
        json = JSON.parse(raw)
      } catch {
        const e = new Error(`火山返回的不是 JSON（HTTP ${res.status}）`)
        e.code = 'BAD_RESPONSE'
        throw e
      }
      if (json.ResponseMetadata?.Error?.Code) {
        const err = new Error(json.ResponseMetadata.Error.Message || json.ResponseMetadata.Error.Code)
        err.code = json.ResponseMetadata.Error.Code
        throw err
      }
      const list = json.Result?.TextList
      const out = Array.isArray(list) ? list[0]?.Translation : null
      if (typeof out !== 'string' || !out) {
        const e = new Error('火山返回的结果里没有译文')
        e.code = 'EMPTY_TRANSLATION'
        throw e
      }
      return out
    })
    .finally(() => clearTimeout(timer))
}

/* ---------------- 段落级并发翻译 ---------------- */

/**
 * 简单并发执行器 —— 用 3 个 worker 抢同一个下标计数器，谁拿到谁干。
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return out
}

/**
 * 把 Markdown 内容分块翻译。
 *
 * 为什么按段落切：游戏简介单段就够，但文章正文很长（一篇 50KB 的博客常见 30~80 段），
 * 一次性灌给火山的 TextList 会被单条字符上限（官方没公开数字，实测几千字以内）挡回。
 * 按双换行（Markdown 段落分隔符）切块后，每段单独翻译再拼回去 —— 段落是天然的翻译单元，
 * 不会破坏 `##` 标题 / 列表 / 链接等结构标记。
 *
 * 段落里**也**可能很长（比如一坨散文 10KB）。当前不做二次切分：
 *   - 实测中等长度的博客很少有那么大的单段
 *   - 真撞上 LIMITEXCEEDED 错误码（QPS 太热或单条太长）时路由层会把它当 502 暴露，
 *     前端按钮显示「翻译失败，请重试」—— 用户能感知
 *   - 真要补的话，记一笔二次切（按句号或者 chars N 一刀切），后续单独一个补丁
 *
 * ⚠️ Markdown 内联标记（**加粗**、`代码`、[链接](url)、```代码块```）现在直接交给火山。
 * 大多数情况下它会保留这些标记 —— 因为代码块是非中文、链接是 URL —— 但理论上可能
 * 「贴心地」把 `**强调**` 内部的文字按语义重写。接受偶尔的不完美，比自写规则化
 * 解析（要识别代码块边界、链接语法、转义）再拼接便宜多了。
 *
 * @param {string} text              Markdown 原文
 * @param {string} source            火山接受的源语言码（'zh' / 'en'）
 * @param {string} target            火山接受的目标语言码
 * @param {number} [concurrency=3]   并发上限。免费版火山大约 5 QPS，3 同时进行留 2 个余量
 *                                   给其他翻译请求（游戏 + 文章可能并发）
 */
export async function translateMarkdown(text, source, target, concurrency = 3) {
  if (!text || !text.trim()) return text || ''

  // 按双换行切，**保留**分隔符（用捕获组 + split）—— 不然段落之间的空白行全丢，
  // 视觉上挤成一坨，Markdown 渲染器也不喜欢没有空行分隔的段落。
  const parts = text.split(/(\n\n+)/)
  // 偶数 index 是正文块（要翻译），奇数 index 是分隔符（保持原样）
  const indicesToTranslate = []
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].trim()) indicesToTranslate.push(i)
  }
  if (indicesToTranslate.length === 0) return text

  const out = [...parts]
  await runWithLimit(
    indicesToTranslate,
    async (i) => {
      // 单段失败会冒泡，整体翻译失败、路由回 502、用户重试
      out[i] = await translateText(parts[i], source, target)
    },
    concurrency,
  )
  return out.join('')
}
