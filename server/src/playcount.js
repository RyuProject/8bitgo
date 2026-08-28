/**
 * 游玩去重：一个人对一款游戏只算一次。
 *
 * 计数发生在**游戏真的跑起来的时候**（模拟器 onReady），不是打开详情页 ——
 * 否则爬虫、预取和随手点开都会被算成一次游玩，数字照样是假的。
 *
 * ── 身份怎么定 ──────────────────────────────────────────────
 *   已登录 -> 只看账号（user_id）。换设备、换网络、换 IP 都算同一个人。
 *   未登录 -> 看 IP。
 *
 * 刻意**不**在已登录时再查一遍 IP：同一个出口 IP 后面可能是一整栋宿舍、
 * 一家公司、一个手机热点，甚至运营商 NAT。把 IP 也算进去的话，
 * 那些人里只有第一个会被记上，后面的全被顶掉。
 *
 * 代价是「先以游客身份玩过、后来注册登录再玩同一款」会被算两次。
 * 每人每游戏最多多算一次，比误伤一整栋楼划算得多。
 *
 * ── 存哪 ────────────────────────────────────────────────────
 * 落在 game_plays 表，主键 (game_id, kind, identity)，靠唯一键冲突判重。
 * 以前这张表在内存里：进程一重启就全忘了，多实例部署更是各记各的 ——
 * 换句话说，重启一次全站所有人都能再刷一遍。
 *
 * ── 隐私 ────────────────────────────────────────────────────
 * 不存明文 IP，存 HMAC-SHA256 摘要（base64url，43 个字符）。
 * 库被拖走也反查不回具体地址 —— 密钥在 .env 里，不在库里。
 *
 * ⚠️ 换掉 PLAY_HASH_SECRET / JWT_SECRET 等于把所有去重记录作废：
 *    老玩家的指纹对不上，每个人都会被重新算一次。
 */
import { createHmac } from 'node:crypto'

/**
 * 摘要用的密钥。默认复用 JWT_SECRET，这样不加任何配置就能用；
 * 想让它独立轮换就在 .env 里单独设 PLAY_HASH_SECRET。
 */
const SECRET = process.env.PLAY_HASH_SECRET || process.env.JWT_SECRET || ''
let warnedNoSecret = false

/** 取真实客户端 IP：站点前面有 Cloudflare / Nginx，直接读 socket 拿到的是代理的地址 */
export function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  )
}

function digest(raw) {
  if (!SECRET && !warnedNoSecret) {
    warnedNoSecret = true
    console.warn('[playcount] 没有 JWT_SECRET / PLAY_HASH_SECRET，游玩指纹用空密钥算 —— 能用，但别在正式环境这么放着')
  }
  // base64url 固定 43 个字符，正好塞进 CHAR(43)
  return createHmac('sha256', SECRET).update(raw).digest('base64url')
}

/**
 * 这次上报算在谁头上。
 *
 * @param {object} req 需要先过 optionalUser 中间件，登录时 req.user 才有值
 * @returns {{kind: 'u'|'i', identity: string} | null} 连 IP 都拿不到时返回 null
 */
export function playIdentity(req) {
  // 'u' = 账号，'i' = IP。分开存是为了将来能分别统计和清理，
  // 也避免两类身份的摘要理论上撞在一起。
  if (req.user?.id) return { kind: 'u', identity: digest(`u:${req.user.id}`) }

  const ip = clientIp(req)
  if (!ip) return null
  return { kind: 'i', identity: digest(`i:${ip}`) }
}
