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

/**
 * key -> { hits: 时间戳数组（毫秒，升序）, expiresAt: 这个桶自己什么时候就没意义了 }
 *
 * ⚠️ `expiresAt` 是 2026-09-11 补的，不是可有可无的字段 —— 见下面 sweep 的注释。
 */
const buckets = new Map()

/** 桶的数量上限。key 通常是 IP，不设上限的话伪造 X-Forwarded-For 就能把内存吃光 */
const MAX_BUCKETS = 50_000

/** 后台清扫周期。清扫**不在请求路径上**，见下面 take 的注释 */
const SWEEP_MS = 30_000

/** 腾位置时最多扫这么多条，保证是 O(1) 而不是 O(n) */
const EVICT_SCAN = 256

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

  const entry = buckets.get(key)
  let hits = entry ? entry.hits : []
  if (entry) {
    // 只丢掉窗口外的：数组是升序的，从头砍即可
    let drop = 0
    while (drop < hits.length && hits[drop] <= cutoff) drop++
    if (drop) hits = hits.slice(drop)
  }

  if (hits.length >= limit) {
    buckets.set(key, { hits, expiresAt: hits[hits.length - 1] + windowMs })
    // 最早那次滑出窗口的时刻，就是下一次可用的时刻
    const retryAfter = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000))
    return { ok: false, retryAfter }
  }

  /*
    ⚠️⚠️ 到顶了才腾位置，而且**只腾一个**。

    原来这里是 `if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) sweep(cutoff)`，
    两个问题叠在一起，2026-09-11 审出来的：

    1. **sweep 用的是调用方自己的 cutoff**，于是一个 60 秒窗口的调用方会顺手删掉
       「60 秒内没被碰过」的**所有**桶 —— 包括 `code:global`（全站发信 20 封/小时）、
       `submit:user:day:*`（一天）这些长窗口闸门。也就是说任何匿名用户只要制造足够多的
       短命 key，就能把这个文件存在的唯一理由（别让本站变成垃圾邮件发射器）清零，
       然后每轮再刷 20 封信出去。这是这次改动最要紧的一条。

    2. **O(n) 全表扫描留在请求路径上**。越过上限之后每一条新 key 都全扫一遍，
       而 60 秒窗口内的条目一条都删不掉 → size 不降 → 下一条继续全扫。
       Node 是单线程，这期间 SSR、socket.io、所有直播/联机房间全部停摆 ——
       和 2026-09-09 那次源站猝死是同一个形状。

    现在：每个桶记自己的 expiresAt，清扫按**各自的**过期时刻走，而且搬到了后台定时器上。
    请求路径上只在真的到顶时腾一个位置，扫描有界。
  */
  if (!entry && buckets.size >= MAX_BUCKETS) evictOne(now)

  hits.push(now)
  buckets.set(key, { hits, expiresAt: now + windowMs })
  return { ok: true }
}

/**
 * 清掉**自己**已经过期的桶。注意参数是 now，不是某个调用方的 cutoff。
 * @returns 删掉了多少条
 */
export function sweep(now = Date.now()) {
  let removed = 0
  for (const [k, v] of buckets) {
    if (v.expiresAt <= now) {
      buckets.delete(k)
      removed++
    }
  }
  return removed
}

/**
 * 到顶之后腾一个位置。
 *
 * 按 expiresAt 最小的淘汰，而不是按插入顺序或者随机 —— 短窗口的桶（60 秒的匿名评分）
 * 本来就快过期，而真正要守住的是长窗口那几条（`code:global` 一小时、
 * `submit:user:day:*` 一天）。按这个顺序淘汰，攻击者刷出来的短命桶先被挤掉，
 * 全站发信闸门活到最后 —— 这正好和上面第 1 条要防的事情是同一个方向。
 *
 * 扫描有界（EVICT_SCAN 条），所以是 O(1)，不会把事件循环按住。
 */
function evictOne(now) {
  let victimKey = null
  let victimAt = Infinity
  let scanned = 0
  for (const [k, v] of buckets) {
    if (v.expiresAt <= now) {
      // 顺手捡到一个已经过期的，直接用它腾位置
      buckets.delete(k)
      return true
    }
    if (v.expiresAt < victimAt) {
      victimAt = v.expiresAt
      victimKey = k
    }
    if (++scanned >= EVICT_SCAN) break
  }
  if (victimKey === null) return false
  buckets.delete(victimKey)
  return true
}

/** 只给测试用：拿到当前桶数 */
export function bucketCount() {
  return buckets.size
}

/** 只给测试用：清空 */
export function resetBuckets() {
  buckets.clear()
}

/*
  后台清扫。unref 之后不会拖住进程退出；测试环境（没有 setInterval.unref 的运行时）
  也不会因为这一句起不来。
*/
const sweepTimer = setInterval(() => sweep(), SWEEP_MS)
sweepTimer.unref?.()

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
