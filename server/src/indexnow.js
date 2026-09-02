/**
 * IndexNow（Bing / Yandex 等）主动推送。
 *
 * URL 的算法不在这里 —— 见 site-urls.js，动态 sitemap 和百度推送共用同一份。
 * 为了不改动既有导入，下面把那些函数原样再导出（normalizeIndexNowUrls 是
 * normalizeSiteUrls 的旧名字）。
 */
import {
  DEFAULT_SITE_URL,
  gameChangeUrls,
  gameDetailUrls,
  localizedPublicUrl,
  normalizeSiteUrls,
  publicSiteUrl,
} from './site-urls.js'

export {
  DEFAULT_SITE_URL,
  gameChangeUrls,
  gameDetailUrls,
  localizedPublicUrl,
  publicSiteUrl,
  normalizeSiteUrls,
  normalizeSiteUrls as normalizeIndexNowUrls,
}

/**
 * IndexNow 的 key 本来就必须公开放在网站根目录，因此可以随代码提交。
 * 它只用于证明「这个域名允许提交这些 URL」，不是能访问后台数据的密码。
 */
export const DEFAULT_INDEXNOW_KEY = 'b8b81a59fab843acaa590586b6733da0'
export const DEFAULT_INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

const TRUE = /^(1|true|yes|on)$/i
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/
const MAX_URLS_PER_REQUEST = 10_000
const QUEUE_DELAY_MS = 800
const REQUEST_TIMEOUT_MS = 10_000

/**
 * 主动提交必须显式打开。否则开发机在后台随手保存一条测试游戏，
 * 也会拿正式域名去通知搜索引擎，线上就会凭空多出一条 404 抓取记录。
 */
export function indexNowEnabled(env = process.env) {
  return TRUE.test(String(env.INDEXNOW_ENABLED || ''))
}

export function buildIndexNowPayload(urls, options = {}) {
  const siteUrl = options.siteUrl || publicSiteUrl()
  const site = new URL(siteUrl)
  const key = String(options.key || process.env.INDEXNOW_KEY || DEFAULT_INDEXNOW_KEY).trim()
  if (!KEY_PATTERN.test(key)) throw new Error('INDEXNOW_KEY 格式不正确')
  return {
    host: site.host,
    key,
    keyLocation: `${site.origin}/${key}.txt`,
    urlList: normalizeSiteUrls(urls, site.origin),
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 提交一批 URL。200 和 202 都表示搜索引擎已接收；它们不等于“保证收录”。
 * 429 / 5xx / 网络错误短暂重试，参数或 key 错误则直接报出，避免无意义地反复轰接口。
 */
export async function submitIndexNowUrls(urls, options = {}) {
  const enabled = options.enabled ?? indexNowEnabled()
  if (!enabled) return { skipped: true, submitted: 0, batches: 0 }

  const siteUrl = options.siteUrl || publicSiteUrl()
  const payload = buildIndexNowPayload(urls, { siteUrl, key: options.key })
  if (!payload.urlList.length) return { skipped: false, submitted: 0, batches: 0 }

  const endpoint = options.endpoint || process.env.INDEXNOW_ENDPOINT || DEFAULT_INDEXNOW_ENDPOINT
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch')

  let batches = 0
  for (let offset = 0; offset < payload.urlList.length; offset += MAX_URLS_PER_REQUEST) {
    const body = { ...payload, urlList: payload.urlList.slice(offset, offset + MAX_URLS_PER_REQUEST) }
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || REQUEST_TIMEOUT_MS)
      timeout.unref?.()
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (response.status === 200 || response.status === 202) {
          batches++
          lastError = null
          break
        }
        const detail = String(await response.text()).slice(0, 300)
        const error = new Error(`IndexNow 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`)
        // 4xx 除了限流都表示请求本身有错，重试不会改变结果。
        if (response.status < 500 && response.status !== 429) throw error
        lastError = error
      } catch (error) {
        lastError = error
        // key / host / URL 格式错误不应伪装成临时网络波动。
        if (/HTTP 4(?!29)/.test(String(error?.message || error))) throw error
      } finally {
        clearTimeout(timeout)
      }
      if (attempt < 2) await wait((Number(options.retryDelayMs) || 500) * 2 ** attempt)
    }
    if (lastError) throw lastError
  }

  return { skipped: false, submitted: payload.urlList.length, batches }
}

const pendingUrls = new Set()
let queueTimer
let flushPromise

/** 后台写接口只负责入队，绝不等待第三方搜索服务。 */
export function queueIndexNowUrls(urls) {
  if (!indexNowEnabled()) return false
  try {
    for (const url of normalizeSiteUrls(urls)) pendingUrls.add(url)
    if (!pendingUrls.size || queueTimer) return pendingUrls.size > 0
    queueTimer = setTimeout(() => {
      queueTimer = undefined
      void flushIndexNowQueue()
    }, QUEUE_DELAY_MS)
    queueTimer.unref?.()
    return true
  } catch (error) {
    // 配置错误也不能把已经成功的游戏保存请求改成 500。
    console.warn(`[indexnow] 未能加入提交队列：${error?.message || error}`)
    return false
  }
}

export function queueGameIndexing(game) {
  if (!indexNowEnabled()) return false
  try {
    return queueIndexNowUrls(gameChangeUrls(game))
  } catch (error) {
    console.warn(`[indexnow] 未能生成游戏 URL：${error?.message || error}`)
    return false
  }
}

export async function flushIndexNowQueue() {
  if (flushPromise) return flushPromise
  const urls = [...pendingUrls]
  pendingUrls.clear()
  if (!urls.length) return { skipped: true, submitted: 0, batches: 0 }
  flushPromise = submitIndexNowUrls(urls)
    .then((result) => {
      console.log(`[indexnow] 已提交 ${result.submitted} 个 URL（${result.batches} 批）`)
      return result
    })
    .catch((error) => {
      // 内容保存已经成功，搜索引擎通知只能降级；需要补交时运行 npm run indexnow。
      console.warn(`[indexnow] 提交失败：${error?.message || error}`)
      return { skipped: false, submitted: 0, batches: 0, error: String(error?.message || error) }
    })
    .finally(() => {
      flushPromise = undefined
      if (pendingUrls.size) queueIndexNowUrls([])
    })
  return flushPromise
}
