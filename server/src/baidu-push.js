/**
 * 百度搜索资源平台「普通收录 → API 提交」推送。
 *
 * 和 IndexNow 的区别，全都体现在下面的实现里：
 *   1. 请求体是 text/plain，每行一个 URL —— 不是 JSON。
 *   2. 准入密钥（token）是**私密**的。它挂在 query string 上，而且接口只有 http，
 *      所以 token 不能像 IndexNow 的 key 那样写进代码，只能放 .env（见 .env.example）。
 *   3. 有每日配额。响应里的 remain 就是当天剩余条数，配额是站点级的、非常有限
 *      （新站常见 10~100 条/天）。所以默认只推简体中文那一份 URL：百度不索引
 *      /en、/ja 这些语言前缀页，把配额花在上面等于白扔。
 */
import {
  gameChangeUrls,
  gameDetailUrls,
  normalizeSiteUrls,
  publicSiteUrl,
  resolveLanguages,
} from './site-urls.js'

export const DEFAULT_BAIDU_ENDPOINT = 'http://data.zz.baidu.com/urls'
/** 百度只做中文搜索，默认只推默认语言（简体中文，裸路径）。 */
export const DEFAULT_BAIDU_LANGUAGES = Object.freeze(['zh-Hans'])

const TRUE = /^(1|true|yes|on)$/i
const TOKEN_PATTERN = /^[A-Za-z0-9]{8,64}$/
/** 普通收录接口单次最多 2000 条。 */
const MAX_URLS_PER_REQUEST = 2000
const QUEUE_DELAY_MS = 1500
const REQUEST_TIMEOUT_MS = 10_000

/**
 * 和 IndexNow 一样必须显式打开：开发机随手保存一条测试游戏就把正式域名推给百度，
 * 换来的是一条 404 抓取记录，还白吃掉当天配额。
 */
export function baiduPushEnabled(env = process.env) {
  return TRUE.test(String(env.BAIDU_PUSH_ENABLED || ''))
}

/**
 * 准入密钥。格式不对就报错而不是照发 —— 百度对错 token 只回一句 401，
 * 混在批量日志里很容易被当成「今天配额用完了」。
 */
export function baiduPushToken(env = process.env) {
  const token = String(env.BAIDU_PUSH_TOKEN || '').trim()
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('BAIDU_PUSH_TOKEN 未配置或格式不正确（百度搜索资源平台 → 普通收录 → API 提交 里的准入密钥）')
  }
  return token
}

/**
 * site 参数必须和搜索资源平台里**验证过的那个写法**完全一致，
 * 带不带 www、http 还是 https 都算不同站点，写错只会回 not_same_site。
 */
export function baiduPushSite(env = process.env) {
  const raw = String(env.BAIDU_PUSH_SITE || '').trim()
  return raw ? new URL(raw).origin : publicSiteUrl(env)
}

export function baiduPushLanguages(env = process.env) {
  const raw = String(env.BAIDU_PUSH_LANGUAGES || '').trim()
  if (!raw) return [...DEFAULT_BAIDU_LANGUAGES]
  return resolveLanguages(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

/** 提交地址。token 在 query 里，所以这个字符串本身是敏感的，别打进日志。 */
export function baiduPushEndpoint(options = {}) {
  const env = options.env || process.env
  const base = options.endpoint || env.BAIDU_PUSH_ENDPOINT || DEFAULT_BAIDU_ENDPOINT
  const url = new URL(base)
  url.searchParams.set('site', options.site || baiduPushSite(env))
  url.searchParams.set('token', options.token || baiduPushToken(env))
  return url.href
}

/** 日志里安全的版本：把 token 抹掉。 */
export const redactEndpoint = (href) => String(href).replace(/(token=)[^&]*/, '$1***')

/** 一款游戏变更时要推的 URL（详情 + 列表 + 平台页 + 类型页，仅中文）。 */
export function gameBaiduUrls(game, siteUrl = publicSiteUrl(), languages = DEFAULT_BAIDU_LANGUAGES) {
  return gameChangeUrls(game, siteUrl, languages)
}

/** 补交用：只要详情页。配额有限时，聚合页远不如详情页值钱。 */
export function gameBaiduDetailUrls(slug, siteUrl = publicSiteUrl(), languages = DEFAULT_BAIDU_LANGUAGES) {
  return gameDetailUrls(slug, siteUrl, languages)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 最近一次接口回报的当天剩余配额，仅用于日志和 --dry-run 提示。 */
let lastRemain
export const baiduRemainingQuota = () => lastRemain

function parseBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 提交一批 URL。
 *
 * 返回 accepted 是百度真正收下的条数（响应里的 success），不等于 urlList 的长度 ——
 * not_same_site / not_valid 里的那些是被丢掉的，必须报出来，否则「推了 40 条、
 * 一条没收」这种域名写错的事故会一直静默。
 */
export async function submitBaiduUrls(urls, options = {}) {
  const env = options.env || process.env
  const enabled = options.enabled ?? baiduPushEnabled(env)
  if (!enabled) return { skipped: true, submitted: 0, accepted: 0, batches: 0 }

  const site = options.site || baiduPushSite(env)
  const urlList = normalizeSiteUrls(urls, site)
  if (!urlList.length) return { skipped: false, submitted: 0, accepted: 0, batches: 0 }

  const endpoint = baiduPushEndpoint({ ...options, env, site })
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch')

  const result = {
    skipped: false,
    submitted: 0,
    accepted: 0,
    batches: 0,
    remain: undefined,
    notSameSite: [],
    notValid: [],
    quotaExhausted: false,
  }

  for (let offset = 0; offset < urlList.length; offset += MAX_URLS_PER_REQUEST) {
    const batch = urlList.slice(offset, offset + MAX_URLS_PER_REQUEST)
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || REQUEST_TIMEOUT_MS)
      timeout.unref?.()
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: batch.join('\n'),
          signal: controller.signal,
        })
        const text = String(await response.text())
        const body = parseBody(text)
        if (response.status === 200 && body && body.error === undefined) {
          result.batches++
          result.submitted += batch.length
          result.accepted += Number(body.success) || 0
          if (Array.isArray(body.not_same_site)) result.notSameSite.push(...body.not_same_site)
          if (Array.isArray(body.not_valid)) result.notValid.push(...body.not_valid)
          if (body.remain !== undefined) {
            result.remain = Number(body.remain)
            lastRemain = result.remain
          }
          lastError = null
          break
        }
        // 失败时百度回的是 {"error":401,"message":"token is not valid"} 这种形状。
        const code = Number(body?.error) || response.status
        const detail = body?.message ? String(body.message) : text.slice(0, 300)
        const error = new Error(`百度推送返回 ${code}${detail ? `：${detail}` : ''}`)
        error.code = code
        // 4xx 里除了限流都是请求本身有错（token、site、配额），重试改变不了结果。
        if (code < 500 && code !== 429) throw error
        lastError = error
      } catch (error) {
        lastError = error
        if (Number(error?.code) && error.code < 500 && error.code !== 429) throw error
      } finally {
        clearTimeout(timeout)
      }
      if (attempt < 2) await wait((Number(options.retryDelayMs) || 500) * 2 ** attempt)
    }
    if (lastError) throw lastError
    // 配额清零后继续发只会拿到 error 400「已达到今日配额上限」，白等三次重试。
    if (result.remain === 0) {
      result.quotaExhausted = offset + MAX_URLS_PER_REQUEST < urlList.length
      break
    }
  }

  return result
}

/* ---------------- 后台写接口用的异步队列 ---------------- */

const pendingUrls = new Set()
let queueTimer
let flushPromise

/** 后台写接口只负责入队，绝不等待第三方搜索服务。 */
export function queueBaiduUrls(urls) {
  if (!baiduPushEnabled()) return false
  try {
    const site = baiduPushSite()
    for (const url of normalizeSiteUrls(urls, site)) pendingUrls.add(url)
    if (!pendingUrls.size || queueTimer) return pendingUrls.size > 0
    queueTimer = setTimeout(() => {
      queueTimer = undefined
      void flushBaiduQueue()
    }, QUEUE_DELAY_MS)
    queueTimer.unref?.()
    return true
  } catch (error) {
    // 配置错误也不能把已经成功的游戏保存请求改成 500。
    console.warn(`[baidu] 未能加入提交队列：${error?.message || error}`)
    return false
  }
}

export function queueGameBaiduPush(game) {
  if (!baiduPushEnabled()) return false
  try {
    return queueBaiduUrls(gameBaiduUrls(game, baiduPushSite(), baiduPushLanguages()))
  } catch (error) {
    console.warn(`[baidu] 未能生成游戏 URL：${error?.message || error}`)
    return false
  }
}

export async function flushBaiduQueue() {
  if (flushPromise) return flushPromise
  const urls = [...pendingUrls]
  pendingUrls.clear()
  if (!urls.length) return { skipped: true, submitted: 0, accepted: 0, batches: 0 }
  flushPromise = submitBaiduUrls(urls)
    .then((result) => {
      const remain = result.remain === undefined ? '未知' : result.remain
      console.log(`[baidu] 已提交 ${result.submitted} 个 URL，百度收下 ${result.accepted} 个，当天剩余配额 ${remain}`)
      if (result.notSameSite.length) {
        console.warn(`[baidu] ${result.notSameSite.length} 个 URL 不属于已验证站点（检查 BAIDU_PUSH_SITE 与 PUBLIC_SITE_URL）：${result.notSameSite.slice(0, 3).join(' ')}`)
      }
      if (result.notValid.length) {
        console.warn(`[baidu] ${result.notValid.length} 个 URL 不合法：${result.notValid.slice(0, 3).join(' ')}`)
      }
      if (result.remain === 0) {
        console.warn('[baidu] 当天配额已用完，后续变更要靠每日兜底任务补交（cd server && npm run baidu）')
      }
      return result
    })
    .catch((error) => {
      // 内容保存已经成功，搜索引擎通知只能降级；需要补交时运行 npm run baidu。
      console.warn(`[baidu] 提交失败：${error?.message || error}`)
      return { skipped: false, submitted: 0, accepted: 0, batches: 0, error: String(error?.message || error) }
    })
    .finally(() => {
      flushPromise = undefined
      if (pendingUrls.size) queueBaiduUrls([])
    })
  return flushPromise
}
