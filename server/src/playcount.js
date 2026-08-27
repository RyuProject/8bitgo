/**
 * 游玩次数统计。
 *
 * 计数发生在**游戏真的跑起来的时候**（模拟器 onReady），不是打开详情页 ——
 * 否则爬虫、预取和随手点开都会被算成一次游玩，数字照样是假的。
 *
 * 防刷用一张内存里的短期表：同一个来源（IP + UA 指纹）对同一款游戏，
 * WINDOW_MS 内只算一次。刻意刷量拦不住（换 IP 就行），但足够挡掉
 * 刷新页面、重开模拟器、多标签页这些日常的重复计数。
 *
 * 之所以不落库去重：那需要为每次游玩写一行，量大且没人会去查。
 * 进程重启后计数窗口清空，最坏情况是重复计一次，可以接受。
 */

/** 同一来源对同一款游戏的去重窗口 */
const WINDOW_MS = Number(process.env.PLAY_WINDOW_MS || 30 * 60_000)
/** 表的容量上限，防止被大量不同 IP 撑爆内存 */
const MAX_ENTRIES = Number(process.env.PLAY_MAX_ENTRIES || 50_000)

/** key -> 过期时间戳 */
const seen = new Map()

/** 取真实客户端 IP：站点前面有 Cloudflare / Nginx，直接读 socket 拿到的是代理的地址 */
export function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  )
}

function sweep(now) {
  for (const [k, expires] of seen) {
    if (expires <= now) seen.delete(k)
  }
  // 扫完还是超量，说明窗口内来源太多，按插入顺序丢掉最旧的一批
  if (seen.size > MAX_ENTRIES) {
    const excess = seen.size - MAX_ENTRIES
    let i = 0
    for (const k of seen.keys()) {
      if (i++ >= excess) break
      seen.delete(k)
    }
  }
}

/**
 * 这次上报要不要算数。
 * @returns true = 计入，false = 窗口内的重复上报
 */
export function shouldCount(req, slug) {
  const now = Date.now()
  // 顺手清一下过期项；Map 不大，遍历成本可以忽略
  if (seen.size > 512) sweep(now)

  const ua = String(req.headers['user-agent'] || '').slice(0, 120)
  const key = `${clientIp(req)}|${ua}|${slug}`
  const expires = seen.get(key)
  if (expires && expires > now) return false
  seen.set(key, now + WINDOW_MS)
  return true
}

/** 只给测试和健康检查用 */
export function playCounterSize() {
  return seen.size
}
