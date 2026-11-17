/**
 * 开放平台令牌的「还算不算数」检查：用户被封 / 删号 / 退出所有设备，应用被停用。
 *
 * 为什么需要：开放平台的 access token 是自包含的 RS256 JWT，验签不查库。以前的结果是
 * 被封的用户、点了「退出所有设备」的用户、被停用的应用，手里那枚令牌**还能用满 15 分钟**
 * （tokens.js 的 OPEN_ACCESS_TTL_SEC 注释里早就写着这个缺口）。
 *
 * 做法：每次请求查一下用户行和应用行，各缓存 ≤ 30 秒。令牌里新带一个 `tv`
 * （签发时的 users.token_version），和站内 JWT 一样：版本对不上就是作废了。
 * 2026-11-17 之前签出去的令牌没有 tv，按 0 算 —— 最多再活 15 分钟就自然过期，
 * 不需要一刀切把在飞的令牌全废掉。
 */
import { queryOne } from '../db.js'
import { tokenVersionOf } from '../auth.js'

/** 缓存时长。改得更长就意味着「封号 / 停用应用」生效得更慢 */
export const REVOCATION_CACHE_MS = 30_000
const MAX_ENTRIES = 20_000

const userCache = new Map()
const appCache = new Map()

function cached(map, key, load) {
  const now = Date.now()
  const hit = map.get(key)
  if (hit && now - hit.at < REVOCATION_CACHE_MS) return hit.value
  const value = load().catch((e) => {
    // 查库失败不缓存：下一次请求重新查，而不是把一次抖动钉 30 秒
    map.delete(key)
    throw e
  })
  if (!map.has(key) && map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, { at: now, value })
  return value
}

/** 用户行（只取判定要用的三列）。不存在 = 已删号，返回 null */
export function openUserRow(userId) {
  return cached(userCache, String(userId), () =>
    queryOne('SELECT id, status, token_version FROM users WHERE id = ?', [String(userId)]).then((r) => r || null),
  )
}

/** 应用还在、且没被停用 */
export function openAppActive(appId) {
  return cached(appCache, String(appId), () =>
    queryOne('SELECT id, status FROM oauth_apps WHERE id = ?', [String(appId)]).then(
      (r) => Boolean(r && r.status !== 'suspended'),
    ),
  )
}

/** 令牌里的 tv（缺省 0）和用户行对得上，且用户没被封 */
export function userClaimsMatch(tv, userRow) {
  if (!userRow || userRow.status === 'banned') return false
  return (Number(tv) || 0) === tokenVersionOf(userRow)
}

/**
 * 一枚已经验过签的开放平台令牌，此刻还算不算数。
 * @param {{appId:string, userId:string, kind:string, tv?:number}} claims verifyOpenToken 的返回值
 */
export async function openClaimsStillValid(claims) {
  if (!claims?.appId) return false
  const checks = [openAppActive(claims.appId)]
  if (claims.kind === 'user') {
    if (!claims.userId) return false
    checks.push(openUserRow(claims.userId).then((row) => userClaimsMatch(claims.tv, row)))
  }
  const results = await Promise.all(checks)
  return results.every(Boolean)
}

/** 测试用：清空缓存 */
export function resetRevocationCache() {
  userCache.clear()
  appCache.clear()
}
