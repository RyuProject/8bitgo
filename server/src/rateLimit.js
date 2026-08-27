/**
 * 极简滑动窗口限流器（内存版，无依赖）。
 *
 * 为什么要有它：`/api/auth/email/request-code` 是**不需要登录**就能调的，而且一调就
 * 真的往外发一封邮件。原来只有「同一个邮箱 60 秒一次」这一道 —— 挡得住重复点按钮，
 * 挡不住一个脚本轮着给一万个陌生邮箱发信。SMTP 配上之后，那就是一台架在你服务器上的
 * 垃圾邮件发射器，代价是域名和 SMTP 账号被拉黑。
 *
 * ⚠️ 状态在内存里，跟验证码本身一样：单进程够用，多实例部署要换 Redis。
 * 多开几个实例时每个实例各算各的，等于把上限乘以实例数 —— 别忘了按比例调小。
 */

/** key -> 时间戳数组（毫秒，升序） */
const buckets = new Map()

/** 桶的数量上限。key 通常是 IP，不设上限的话伪造 X-Forwarded-For 就能把内存吃光 */
const MAX_BUCKETS = 50_000

/**
 * 取一次配额。返回 { ok } 或 { ok: false, retryAfter }（秒）。
 *
 * @param {string} key       计数维度，比如 `code:ip:1.2.3.4`
 * @param {number} limit     窗口内允许的次数
 * @param {number} windowMs  窗口长度
 */
export function take(key, limit, windowMs) {
  const now = Date.now()
  const cutoff = now - windowMs

  let hits = buckets.get(key)
  if (hits) {
    // 只丢掉窗口外的：数组是升序的，从头砍即可
    let drop = 0
    while (drop < hits.length && hits[drop] <= cutoff) drop++
    if (drop) hits = hits.slice(drop)
  } else {
    hits = []
  }

  if (hits.length >= limit) {
    buckets.set(key, hits)
    // 最早那次滑出窗口的时刻，就是下一次可用的时刻
    const retryAfter = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000))
    return { ok: false, retryAfter }
  }

  // 新建桶之前先顺手清一遍空桶，避免无限增长
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) sweep(cutoff)
  hits.push(now)
  buckets.set(key, hits)
  return { ok: true }
}

/** 清掉窗口内已经没有记录的桶 */
function sweep(cutoff) {
  for (const [k, v] of buckets) {
    if (!v.length || v[v.length - 1] <= cutoff) buckets.delete(k)
  }
}

/**
 * 取「尽量真实」的客户端标识。
 *
 * Express 的 req.ip 只有在 app.set('trust proxy', ...) 配对时才是真实客户端；
 * 配错了所有人都会算成同一个（反代的地址），限流就从「按人」退化成「全站一个额度」。
 * 所以调用方**不能**只依赖它 —— 真正兜底的是全站总量那一道。
 *
 * Cloudflare 在后面时，nginx 需要把真实 IP 透传下来：
 *   proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
 * 只写 $remote_addr 的话，node 这边拿到的是 Cloudflare 边缘节点的地址。
 */
export function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * 这个 IP 值可信吗？—— 也就是「它真的能区分不同访客」吗。
 *
 * 拿到的是环回或内网地址，说明反代没把真实访客 IP 透传下来，所有人都会塌缩成
 * 同一个值。这时候还按 IP 限流，等于给整站设了个每小时 N 封的总闸 ——
 * Cloudflare 在前面时尤其明显：所有访客顶着少数几个边缘节点地址进来，
 * 十几个人登录就能把后面的人全锁在门外。
 *
 * 所以这种情况下调用方应当**跳过按 IP 那道**，只留全站总量兜底：
 * 宁可放宽，也不能误伤真实用户。
 */
export function isMeaningfulIp(ip) {
  if (!ip || ip === 'unknown') return false
  const v = String(ip).replace(/^::ffff:/, '')
  if (v === '127.0.0.1' || v === '::1' || v.startsWith('127.')) return false
  if (v.startsWith('10.') || v.startsWith('192.168.')) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return false
  if (v.startsWith('fc') || v.startsWith('fd')) return false // IPv6 唯一本地地址
  return true
}
