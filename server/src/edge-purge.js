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

function config() {
  const zone = String(process.env.CF_ZONE_ID || '').trim()
  const token = String(process.env.CF_PURGE_API_TOKEN || '').trim()
  return zone && token ? { zone, token } : null
}

export function edgePurgeEnabled() {
  return config() !== null
}

let timer = null
let running = false
let pendingAfterRun = false

/** 发一次按标签清缓存。成功 true；失败抛错，错误上带 retryable */
export async function purgeHtmlNow({ fetchImpl = fetch } = {}) {
  const cfg = config()
  if (!cfg) return false
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${cfg.zone}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [HTML_CACHE_TAG] }),
    signal: AbortSignal.timeout(10_000),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应，按状态码判 */
  }
  if (res.ok && body?.success !== false) return true
  const err = new Error(`Cloudflare 清缓存失败 HTTP ${res.status} ${JSON.stringify(body?.errors ?? '')}`)
  err.retryable = res.status === 429 || res.status >= 500
  throw err
}

async function run(attempt = 0) {
  running = true
  try {
    await purgeHtmlNow()
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
