/**
 * 两条 SSE 长连接的准入闸门（`/api/live/events`、`/api/netplay/events`）。
 *
 * 病史（2026-09-09）：nginx error.log 里 200 行 `upstream prematurely closed
 * connection` **全部落在同一秒**，断的清一色是这两个端点 —— 那是 Node 进程整个死掉、
 * 所有还开着的流被同时切断留下的回声。客户端 IP 里成片是 Googlebot（66.249.79.x）、
 * Bingbot（157.55.39.x / 207.46.13.x）和 Applebot（17.166.x.x）。
 *
 * 三个原因叠在一起：
 *   1. `robots.txt` 里从来没有 `/api` 这一段，会跑 JS 的爬虫照样把流开起来；
 *   2. 侧边栏挂在每个页面上，一次页面加载开**两条**流；
 *   3. 两条流的订阅集合都是**无界**的 —— 没有 per-IP 上限、没有总量上限、
 *      没有最长存活时间，开多少存多少，每条还各带一个 25 秒心跳定时器。
 *
 * 顺带解释了为什么线上看到的是 **525 而不是 502**：一条被反代出去的 SSE 占 nginx
 * **两个**连接槽（面向客户端一个 + 面向 upstream 一个），`worker_connections` 默认
 * 1024，槽位耗尽后 nginx 接得下 TCP 却完不成 TLS 握手，Cloudflare 那头就报 525。
 *
 * 这里补的是第 2、3 道。第 1 道在 `public/robots.txt`（robots 不是强制的，
 * 所以两道都要有）。
 */
import { clientIp } from './playcount.js'
import { isPrivateIp } from './presence.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

/** 同一个 IP 最多几条并发流（两个频道合计）。一次页面加载占 2 条，所以 8 ≈ 4 个标签页 */
export const SSE_MAX_PER_IP = num(process.env.SSE_MAX_PER_IP, 8)
/** 全进程并发流总量。留足余量给 nginx 的连接槽，别把上限直接顶到 worker_connections */
export const SSE_MAX_TOTAL = num(process.env.SSE_MAX_TOTAL, 600)
/** 单条流的最长存活时间。到点主动收，EventSource 自己会重连，玩家无感 */
export const SSE_MAX_LIFETIME_MS = num(process.env.SSE_MAX_LIFETIME_MS, 30 * 60_000)

/**
 * 爬虫 UA。命中就不给开流。
 *
 * ⚠️ **UA 为空的不算爬虫**：真浏览器一定带 UA，而我们自己的测试脚本用裸 fetch 不带 UA，
 * 把「空」当爬虫会把回归测试和健康检查一起挡掉。宁可漏判，别误判。
 *
 * `applebot` 只匹配爬虫本体。真人经 iCloud 私密代理过来时（同样是 17.166.x.x 段）
 * 带的是正常 Safari UA，不会命中。
 */
const CRAWLER_UA =
  /(bot\b|bot\/|spider|crawler|slurp|scrapy|curl\/|wget\/|python-requests|go-http-client|okhttp|java\/|libwww|headlesschrome|lighthouse|facebookexternalhit|embedly|preview|semrush|ahrefs|mj12|dotbot|yandex|sogou|360spider|bytespider|feedfetcher|archive\.org_bot)/i

export function isCrawlerUa(ua) {
  return CRAWLER_UA.test(String(ua || ''))
}

/** 当前并发数。key 是 IP，值是条数；到 0 就删，别让 Map 无限长 */
const perIp = new Map()
let total = 0

/** 给 `/api/diag` 用：现在挂着多少条、最挤的那个 IP 挂了几条 */
export function sseStats() {
  let topIp = null
  let top = 0
  for (const [ip, n] of perIp) {
    if (n > top) {
      top = n
      topIp = ip
    }
  }
  return { total, ips: perIp.size, top, topIp, maxTotal: SSE_MAX_TOTAL, maxPerIp: SSE_MAX_PER_IP }
}

/** 只给测试用：把计数清干净，避免用例之间互相污染 */
export function resetSseCounters() {
  perIp.clear()
  total = 0
}

/**
 * 判准入。返回 true 表示可以开流（响应头已经写好了），false 表示已经回过响应、
 * 调用方直接 return。
 *
 * 准入通过后会自己挂上 `res.on('close')` 归还名额 —— 调用方**不需要**也**不应该**
 * 再去减计数，但仍要保留自己那份清理（心跳定时器、从订阅集合里摘掉）。
 */
export function admitSse(req, res) {
  if (isCrawlerUa(req.headers?.['user-agent'])) {
    // 204 而不是 403/429：这不是错误，是「没有内容给你」。爬虫看到 204 不会反复重试，
    // 也不会在 Search Console 里堆成一片抓取错误。
    res.set('Cache-Control', 'no-store')
    res.status(204).end()
    return false
  }

  const raw = clientIp(req)
  // ⚠️ 内网地址不计 per-IP —— 反代没把真实 IP 透传下来时，全站访客都长成同一个
  // 127.0.0.1，按 IP 限流会把整个站限死。同一个坑在直播的每 IP 房间数上踩过一次
  // （见 project_8bitgo_live_audit3）。总量那道闸照常生效，兜底不会丢。
  const ip = raw && !isPrivateIp(raw) ? raw : ''
  const used = ip ? perIp.get(ip) || 0 : 0

  if (total >= SSE_MAX_TOTAL || (ip && used >= SSE_MAX_PER_IP)) {
    res.set({ 'Cache-Control': 'no-store', 'Retry-After': '30' })
    res.status(503).json({ error: 'too many event streams' })
    return false
  }

  total += 1
  if (ip) perIp.set(ip, used + 1)

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx 默认缓冲响应，缓冲住 SSE 就完全不推了
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  let done = false
  const release = () => {
    if (done) return
    done = true
    clearTimeout(life)
    total = Math.max(0, total - 1)
    if (ip) {
      const left = (perIp.get(ip) || 1) - 1
      if (left > 0) perIp.set(ip, left)
      else perIp.delete(ip)
    }
  }

  const life = setTimeout(() => {
    try {
      res.end()
    } catch {
      release()
    }
  }, SSE_MAX_LIFETIME_MS)
  life.unref?.()

  res.on('close', release)
  return true
}
