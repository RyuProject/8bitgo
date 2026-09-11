/**
 * 友情链接的双向埋点：**我们带出去多少人**、**对方带进来多少人**。
 *
 * 站长 2026-09-11 要的：「可不可以监控从那个友情链接来了多少人或者流量」。
 * 两个方向都记，因为只看一边没有意义 —— 友链是互惠的，你给他 100、他给你 3，
 * 那是个赔本买卖，而这件事只有两边的数字摆在一起才看得出来。
 *
 *   direction 'o'  出站：首页鸣谢位上的链接被点了。前端 sendBeacon 上报。
 *   direction 'i'  入站：有人从对方站点点进来了。服务端读 Referer 归类。
 *
 * ── 记的是「人」不是「次」 ─────────────────────────────────
 * 主键带 day + identity，也就是**每人每天每条链接每个方向只记一次**。
 * 理由和 playcount 一样：一个人手抖点三下不该让数字翻三倍，而「今天有多少人走过这条链接」
 * 才是判断友链值不值得留的那个量。代价是拿不到原始点击次数 —— 刻意的取舍。
 *
 * ── 身份与隐私 ────────────────────────────────────────────
 * 直接复用 playcount 的 `playIdentity`：登录看账号、否则看 IP，
 * 存的是 HMAC-SHA256 摘要（43 个 base64url 字符），**不存明文 IP**。
 * 密钥在 .env 里不在库里，库被拖走也反查不回地址。
 *
 * ── 两条都不能影响主流程 ──────────────────────────────────
 * 出站那条是 sendBeacon，本来就不挡跳转；入站那条挂在 SSR 之前，**必须 fire-and-forget**，
 * 一次写库绝不能拖慢首屏。所以这里所有写入都自己吞掉异常。
 */
import { query } from './db.js'
import { playIdentity } from './playcount.js'

/** 出站：我们这边的鸣谢位被点了 */
export const OUT = 'o'
/** 入站：有人从对方站点过来了 */
export const IN = 'i'

/**
 * 记一笔。**永远 resolve，永远不抛** —— 调用方是 sendBeacon 的响应和 SSR 的前置中间件，
 * 谁都不该因为统计写失败而出问题。
 *
 * @returns {Promise<boolean>} 真的插进去了（= 这个人今天第一次）才是 true
 */
export async function recordFriendLinkHit(linkId, direction, req) {
  const id = Number(linkId)
  if (!Number.isSafeInteger(id) || id <= 0) return false
  if (direction !== OUT && direction !== IN) return false
  const who = playIdentity(req)
  // 连 IP 都拿不到：不记。宁可少一条，也不要一个所有人共用的空身份把去重打穿
  if (!who) return false
  try {
    /*
      INSERT IGNORE + 主键冲突 = 天然去重，不用先查后写（那是两次往返，而且有竞态）。
      CURDATE() 交给数据库算：应用进程的时区可能和库不一致，两边各算各的会让
      「今天」在午夜前后错开一整天。
    */
    const r = await query(
      'INSERT IGNORE INTO friend_link_hits (link_id, direction, day, identity) VALUES (?, ?, CURDATE(), ?)',
      [id, direction, who.identity],
    )
    return Number(r?.affectedRows) > 0
  } catch {
    // 表还没建、库挂了、外键指向一条已删除的友链 —— 统计失败不该惊动任何人
    return false
  }
}

/**
 * 最近 N 天每条链接的两个方向各有多少人。
 *
 * @returns {Promise<Record<number, {out: number, in: number}>>}
 */
export async function friendLinkStats(days = 30) {
  const n = Number.isSafeInteger(days) && days > 0 && days <= 400 ? days : 30
  try {
    const rows = await query(
      `SELECT link_id, direction, COUNT(*) AS n
         FROM friend_link_hits
        WHERE day >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY link_id, direction`,
      [n],
    )
    const out = {}
    for (const row of rows) {
      const id = Number(row.link_id)
      if (!out[id]) out[id] = { out: 0, in: 0 }
      out[id][row.direction === OUT ? 'out' : 'in'] = Number(row.n) || 0
    }
    return out
  } catch {
    return {}
  }
}

/* ---------------- 入站：Referer → 哪一条友链 ---------------- */

/**
 * 域名匹配时先规范化：去掉端口、统一小写、**去掉开头的 www.**。
 *
 * 最后那条是必须的：友链填的是 `https://example.com/`，而访客可能是从
 * `https://www.example.com/links.html` 点过来的 —— 不归一的话这条永远记不上，
 * 而且**看起来像「对方没给我们带人」**，是个会导致错误决策的静默失败。
 */
export function normalizeHost(raw) {
  const host = String(raw || '').toLowerCase().split(':')[0].trim()
  return host.startsWith('www.') ? host.slice(4) : host
}

/** 从一个 URL 里取规范化域名；取不出来返回空串 */
export function hostOf(url) {
  try {
    return normalizeHost(new URL(String(url)).hostname)
  } catch {
    return ''
  }
}

/**
 * 域名 → 友链 id 的对照表，带 TTL 缓存。
 *
 * 每个页面请求都要查一次，不缓存就是每次首屏多一次查库。
 * 60 秒足够：后台加一条友链，一分钟内开始统计，没人会觉得不对。
 */
const HOST_MAP_TTL_MS = 60_000
let hostMap = null
let hostMapAt = 0

export async function friendLinkHostMap() {
  const now = Date.now()
  if (hostMap && now - hostMapAt < HOST_MAP_TTL_MS) return hostMap
  try {
    const rows = await query('SELECT id, url FROM friend_links WHERE enabled = 1')
    const map = new Map()
    for (const row of rows) {
      const host = hostOf(row.url)
      // 同一个域名配了两条友链时先到先得。这是数据录入问题，不该让统计变成随机的
      if (host && !map.has(host)) map.set(host, Number(row.id))
    }
    hostMap = map
    hostMapAt = now
    return map
  } catch {
    // 查不到就当没有友链：入站统计静默跳过，页面照常渲染
    return hostMap ?? new Map()
  }
}

/** 只给测试用：把缓存清掉，免得用例之间互相污染 */
export function resetFriendLinkHostCache() {
  hostMap = null
  hostMapAt = 0
}
