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
import { clientIpFrom, isPrivateIp } from './presence.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

/**
 * 同一个 IP 最多几条并发流。
 *
 * ⚠️ 一个游玩页开的是 **3 条**不是 2 条：直播列表（services/live.ts）、联机列表和
 * `watchNetplayRoom` 的单房间流（services/netplay.ts）。所以 20 ≈ 6 个标签页。
 *
 * 别再往下调：运营商 CGNAT、学校、网吧都是**整个出口共用一个 IP**，定低了就是
 * 「第三个玩家开始连不上」。直播的每 IP 房间数因为同一个原因从 3 调到过 20
 * （见 project_8bitgo_live_audit3）。真要拦滥用，靠的是总量那道闸和 Cloudflare 的 WAF。
 */
export const SSE_MAX_PER_IP = num(process.env.SSE_MAX_PER_IP, 20)
/** 全进程并发流总量。留足余量给 nginx 的连接槽，别把上限直接顶到 worker_connections */
export const SSE_MAX_TOTAL = num(process.env.SSE_MAX_TOTAL, 600)
/** 单条流的最长存活时间。到点主动收，EventSource 自己会重连，玩家无感 */
export const SSE_MAX_LIFETIME_MS = num(process.env.SSE_MAX_LIFETIME_MS, 30 * 60_000)

/**
 * 爬虫 UA。命中就不给开流。
 *
 * ⚠️ **UA 为空不算爬虫**：真浏览器一定带 UA，而我们自己的测试脚本用裸 fetch 不带 UA，
 * 把「空」当爬虫会把回归测试和健康检查一起挡掉。宁可漏判，别误判。
 *
 * ⚠️ 误判的代价是**看不见**的：被拒的真人会被 sseFallback 退回轮询，页面照常能用，
 * 没有报错、没有日志 —— 他们只是永远在花我们最想省掉的那份负载。所以这张表宁可窄，
 * 漏掉的爬虫还有 robots.txt 和总量闸兜着。`sseStats().blocked` 就是用来看误判的。
 *
 * 第一版这三条都误伤过真人，别再加回去：
 *   · 裸 `sogou`   → `SogouMobileBrowser` / `SogouSearch iPhone`，搜狗浏览器和搜狗 App 里的**真人**。
 *                    搜狗爬虫叫 `Sogou web spider`，被下面的 `spider` 收着了。
 *   · 裸 `bot`     → `CUBOT NOTE 20` 这类**手机型号**。所以下面要求 bot 后面跟 / ; ) ] 或 +链接 或结尾，
 *                    真爬虫都带版本号或链接（`Googlebot/2.1`、`DotBot/1.2;`、`SomeBot +http://…`），
 *                    型号后面跟的是空格。
 *   · 裸 `preview` → 任何 UA 尾巴带 Preview 的客户端。Bing 那个改成具名 `bingpreview`。
 */
const CRAWLER_UA = new RegExp(
  [
    'bot(?=[/;)\\]]|\\s*\\+|$)',
    'spider', // Sogou web spider / Bytespider / 360Spider 都在这儿
    'crawler',
    'slurp',
    'scrapy',
    'curl/',
    'wget/',
    'python-requests',
    'go-http-client',
    'okhttp',
    'java/',
    'libwww',
    'headlesschrome',
    'lighthouse',
    'facebookexternalhit',
    'embedly',
    'bingpreview',
    'feedfetcher',
    'semrush',
    'ahrefs',
    'archive\\.org_bot',
  ].join('|'),
  'i',
)

export function isCrawlerUa(ua) {
  return CRAWLER_UA.test(String(ua || ''))
}

/** 当前并发数。key 是 IP，值是条数；到 0 就删。总量封顶 SSE_MAX_TOTAL，所以这个 Map 天然有界 */
const perIp = new Map()
let total = 0
/** 累计拒掉了多少条：爬虫 / 超 per-IP / 超总量。分开记，误判和滥用的形状不一样 */
const blocked = { crawler: 0, perIp: 0, total: 0 }

/**
 * 把 IP 打码到网段。
 *
 * ⚠️ `/api/diag` 是**公开无鉴权**的（index.js 直接 app.use，没有任何中间件），
 * 而这里报的是**别人**的地址 —— 原样吐出去等于给任何人一个查当前访客真实 IP 的接口，
 * 也和 diag.js 文件头那句「只回显这一次请求自己的信息」自相矛盾。
 * 打码之后「是不是同一个来源在刷」照样看得出来，这正是运维要的那点信息。
 */
function maskIp(ip) {
  if (!ip) return null
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.*'
  const g = ip.split(':').filter(Boolean)
  return g.slice(0, 3).join(':') + '::*'
}

/** 给 `/api/diag` 用：现在挂着多少条、最挤的那个来源挂了几条、拒了多少 */
export function sseStats() {
  let topIp = null
  let top = 0
  for (const [ip, n] of perIp) {
    if (n > top) {
      top = n
      topIp = ip
    }
  }
  return {
    total,
    ips: perIp.size,
    top,
    /** 打码到网段，不是完整地址 —— 这个接口是公开的 */
    topNet: maskIp(topIp),
    blocked: { ...blocked },
    maxTotal: SSE_MAX_TOTAL,
    maxPerIp: SSE_MAX_PER_IP,
  }
}

/** 只给测试用：把计数清干净，避免用例之间互相污染 */
export function resetSseCounters() {
  perIp.clear()
  total = 0
  blocked.crawler = 0
  blocked.perIp = 0
  blocked.total = 0
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
    blocked.crawler += 1
    // 204 而不是 403/429：这不是错误，是「没有内容给你」。爬虫看到 204 不会反复重试，
    // 也不会在 Search Console 里堆成一片抓取错误。
    res.set('Cache-Control', 'no-store')
    res.status(204).end()
    return false
  }

  /**
   * ⚠️ **必须用 clientIpFrom，不能用 playcount 的 clientIp。**
   *
   * `playcount.js` 的 `clientIp()` 取的是 `X-Forwarded-For` 的**第一段** —— 那一段是
   * 客户端自己写的（Cloudflare 把真实 IP **追加在后面**，见 presence.js 的注释）。
   * 那边只是计数，被骗了无所谓；这里是**限流身份**，被骗的后果是：
   *
   *   · 攻击者每条请求带一个不同的假 XFF → per-IP 一次都不触发 → 600 条就吃满
   *     SSE_MAX_TOTAL → 之后所有真实访客拿 503，全站实时功能退回轮询；
   *   · 或者伪造成某个人的 IP 占满他的配额，定点把他挡在门外。
   *
   * `clientIpFrom` 走 presence 那套：从 XFF **右往左**找第一个非内网地址（右边那段是
   * 我们自己的 nginx 追加的，伪造不了），并且顺手 normalize 掉 `::ffff:` 前缀和端口。
   */
  const ip0 = clientIpFrom(req.socket?.remoteAddress, req.headers || {})
  // 内网地址不计 per-IP —— 反代没把真实 IP 透传下来时，全站访客都长成同一个
  // 127.0.0.1，按 IP 限流会把整个站限死。同一个坑在直播的每 IP 房间数上踩过一次
  // （见 project_8bitgo_live_audit3）。总量那道闸照常生效，兜底不会丢。
  const ip = ip0 && !isPrivateIp(ip0) ? ip0 : ''
  const used = ip ? perIp.get(ip) || 0 : 0

  if (total >= SSE_MAX_TOTAL || (ip && used >= SSE_MAX_PER_IP)) {
    if (total >= SSE_MAX_TOTAL) blocked.total += 1
    else blocked.perIp += 1
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
