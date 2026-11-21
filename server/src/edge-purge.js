/**
 * 后台改内容后清 Cloudflare 边缘上的 SSR 页面。
 *
 * 为什么要有它：页面原来在边缘只缓存 5 分钟（s-maxage=300）。游戏 × 八种语言的长尾页面
 * 一个节点 5 分钟里几乎等不到第二个访客，绝大多数请求都要回源，TTFB 多出一次回源往返
 * （2026-11 生产日志：7 小时 3354 次页面回源，分布在 2000 个不同 URL 上）。
 * 把边缘缓存拉长到一天，换来的代价是「后台改完要等一天」—— 这里负责把这个代价消掉：
 * 每次 invalidateContent()（所有后台写路径都会调）之后，按 Cache-Tag 清掉全部 HTML。
 *
 * 为什么清**全部** HTML 而不是只清改动的那一页：改一款游戏会同时影响首页、列表、平台页、
 * 相关推荐、开发商页……逐页推导依赖既容易漏，漏了就是「某个页面一天内是旧的」。
 * 后台写入频率很低，清一次全站 HTML 只是让下一批访客各回源一次，和以前 5 分钟过期等价。
 *
 * 几条约束：
 * - **只在配置了令牌时才启用长缓存**（edgePurgeEnabled()，cache.js 据此决定发不发
 *   Cloudflare-CDN-Cache-Control）。没令牌却缓存一天，后台改动就真的要等一天。
 * - **延迟几秒再清**：写库前就开始渲染的那次请求可能在写库之后才回到边缘；
 *   立刻清的话它会把旧页面重新塞进缓存、再挂一整天。等几秒让在飞的渲染落地后再清。
 * - **合并**：批量编辑会连续调几十次 invalidateContent()，只发一次请求。
 *   Cloudflare 免费版按标签清缓存有速率限制，429 时退避重试。
 * - 只管 Cloudflare。cn.8bitgo.com 走 EdgeOne，从不经过 Cloudflare；那边仍按
 *   Cache-Control 里的 5 分钟过期（EdgeOne 不认 Cloudflare-CDN-Cache-Control）。
 */

/** 所有 SSR 页面都带这个 Cache-Tag；清缓存时清的就是它 */
export const HTML_CACHE_TAG = 'html'

const DEBOUNCE_MS = Number(process.env.EDGE_PURGE_DELAY_MS || 3000)
const RETRY_BASE_MS = 15_000
const MAX_RETRIES = 5

/*
  CF_ZONE_ID 可以写多个区域（逗号或空白分隔），每次清缓存逐个清。
  为什么：NS 迁出 Cloudflare 后（deploy/saas/README.md），海外访客的 8bitgo.com 改由 SaaS 区域 8bitgo.top
  以 custom hostname 身份服务，页面缓存在那个区域里；清 8bitgo.com 区域清不到它们，后台改动会在海外挂一天。
  迁移前后都写成「8bitgo.com 的 ID,8bitgo.top 的 ID」，切换当天不用改服务器配置。令牌要对每个区域都有 Cache Purge 权限。
*/
function config() {
  const zones = [...new Set(String(process.env.CF_ZONE_ID || '').split(/[\s,]+/).filter(Boolean))]
  const token = String(process.env.CF_PURGE_API_TOKEN || '').trim()
  return zones.length && token ? { zones, token } : null
}

export function edgePurgeEnabled() {
  return config() !== null
}

let timer = null
let running = false
let pendingAfterRun = false
/*
  最近一次自动清缓存的结果，给后台「站点健康」看（见 admin-health.js）。
  只记在进程内存：重启后是空的，这正好如实表达「本进程还没清过」；
  失败时只会打日志，以前管理员要登服务器 journalctl 才知道后台改动卡在边缘一天。
*/
let lastRun = null

/** 后台健康面板用：是否配置、最近一次结果（时间、成功与否、错误摘要） */
export function edgePurgeStatus() {
  return { enabled: edgePurgeEnabled(), pending: Boolean(timer) || running, last: lastRun }
}

/** 对一个区域调一次清缓存接口。成功 true；失败抛错，错误上带 retryable */
async function purgeZone(zone, token, payload, fetchImpl) {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应，按状态码判 */
  }
  if (res.ok && body?.success !== false) return true
  const err = new Error(`Cloudflare 清缓存失败（区域 ${zone}）HTTP ${res.status} ${JSON.stringify(body?.errors ?? '')}`)
  err.retryable = res.status === 429 || res.status >= 500
  throw err
}

/**
 * 对所有配置的区域各清一次。成功 true；没配令牌 false；失败抛错，错误上带 retryable。
 *
 * 判定：有一个区域临时失败（429 / 5xx）就整体按可重试抛出（重清已成功的区域无害）；
 * 只有永久失败（权限、区域已停用）而别的区域清成功时算成功，只告警 ——
 * NS 迁走后 8bitgo.com 区域会变成已迁出状态，清它会一直报错，不能因此每次都判失败、反复退避。
 */
async function purgeRequest(payload, fetchImpl) {
  const cfg = config()
  if (!cfg) return false
  const results = await Promise.allSettled(cfg.zones.map((zone) => purgeZone(zone, cfg.token, payload, fetchImpl)))
  const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
  if (!failures.length) return true
  const message = failures.map((e) => e?.message || String(e)).join('；')
  if (failures.some((e) => e?.retryable !== false) || failures.length === results.length) {
    const err = new Error(message)
    err.retryable = failures.some((e) => e?.retryable !== false)
    throw err
  }
  console.warn(`[edge-purge] 部分区域清缓存失败（其余已清）：${message}`)
  return true
}

/** 发一次按标签清缓存。成功 true；失败抛错，错误上带 retryable */
export async function purgeHtmlNow({ fetchImpl = fetch } = {}) {
  return purgeRequest({ tags: [HTML_CACHE_TAG] }, fetchImpl)
}

/**
 * 按完整 URL 清几个文件（坏 chunk 自修复用，见 routes/asset-repair.js）。
 * 一次最多 30 个（Cloudflare 免费版单次按 URL 清的上限）。
 */
export async function purgeUrlsNow(urls, { fetchImpl = fetch } = {}) {
  const files = [...new Set(urls)].filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, 30)
  if (!files.length) return false
  return purgeRequest({ files }, fetchImpl)
}

async function run(attempt = 0) {
  running = true
  try {
    await purgeHtmlNow()
    lastRun = { at: new Date().toISOString(), ok: true, attempts: attempt + 1 }
    console.log('[edge-purge] 已清除 Cloudflare 边缘 HTML 缓存')
  } catch (e) {
    const retryable = e?.retryable !== false
    if (retryable && attempt < MAX_RETRIES) {
      const wait = RETRY_BASE_MS * 2 ** attempt
      console.warn(`[edge-purge] ${e?.message || e}，${Math.round(wait / 1000)} 秒后重试`)
      running = false
      setTimeout(() => void run(attempt + 1), wait).unref?.()
      return
    }
    lastRun = { at: new Date().toISOString(), ok: false, attempts: attempt + 1, error: String(e?.message || e).slice(0, 300) }
    console.error('[edge-purge] 放弃清缓存，后台改动要等边缘自然过期才可见：', e?.message || e)
  }
  running = false
  // 清的过程中又有新写入：它可能在本次清除之后才写库，必须再清一次
  if (pendingAfterRun) {
    pendingAfterRun = false
    schedulePurge()
  }
}

/** invalidateContent() 调这里；没配令牌时什么都不做 */
export function schedulePurge() {
  if (!edgePurgeEnabled()) return
  if (running) {
    pendingAfterRun = true
    return
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void run()
  }, DEBOUNCE_MS)
  timer.unref?.()
}
