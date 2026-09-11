#!/usr/bin/env node
/**
 * 限流器的回归测试。跑：cd server && npm run test:ratelimit
 *
 * 这个文件存在的唯一理由写在 rateLimit.js 的文件头：别让本站变成垃圾邮件发射器。
 * 2026-09-11 审计发现这道闸**可以被任何匿名用户清零**，下面第二节就是那条攻击链，
 * 复现在真实的 take() 上，不是模拟。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let now = 1_700_000_000_000
const realNow = Date.now
Date.now = () => now
const at = (t) => { now = t }

const { take, sweep, bucketCount, resetBuckets, isMeaningfulIp } = await import('../src/rateLimit.js')

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }

console.log('── 基本的滑动窗口 ──')
resetBuckets()
ok(take('a', 2, 1000).ok && take('a', 2, 1000).ok, '额度内放行')
{
  const r = take('a', 2, 1000)
  ok(!r.ok, '超了就拒')
  ok(r.retryAfter >= 1, '拒的时候给 retryAfter')
}
at(now + 1001)
ok(take('a', 2, 1000).ok, '窗口滑过去之后恢复')

console.log('\n── ⭐ 短窗口的调用方不许清掉长窗口的闸门 ──')
{
  /*
    原来的实现：`sweep(cutoff)` 收到的是**调用方**的 cutoff，于是一个 60 秒窗口的
    调用方会删掉「60 秒内没被碰过」的所有桶 —— 包括 code:global（一小时）。
    任何匿名用户只要制造足够多的短命 key，就能把全站发信闸门清零，
    然后每轮再刷 20 封信出去。这一节就是那条攻击链。
  */
  resetBuckets()
  const HOUR = 3_600_000
  for (let i = 0; i < 5; i++) ok(take('code:global', 20, HOUR).ok === true, i === 0 ? '先用掉 5/20 的全站发信配额' : null)
  at(now + 90_000) // 过了 90 秒：对 60 秒窗口来说「早就过期」，对一小时窗口来说还早

  // 攻击者：灌大量一次性的短命 key（模拟 rating:anon:<32位随机>）
  for (let i = 0; i < 60_000; i++) take(`rating:anon:atk${i}`, 10, 60_000)

  let left = 0
  while (take('code:global', 20, HOUR).ok) left++
  ok(left === 15, `⭐ 全站发信配额仍然是「用掉 5 还剩 15」（实际剩 ${left}）—— 被清零的话这里会是 20`)
}

console.log('\n── ⭐ 桶数有真上限，而且淘汰顺序护着长窗口 ──')
{
  resetBuckets()
  const HOUR = 3_600_000
  take('code:global', 20, HOUR) // 一小时窗口，最该活下来的那条
  for (let i = 0; i < 60_000; i++) take(`short${i}`, 10, 60_000)
  ok(bucketCount() <= 50_000, `桶数封顶（现在 ${bucketCount()}）—— 原来 MAX_BUCKETS 不是真上限`)
  let left = 0
  while (take('code:global', 20, HOUR).ok) left++
  ok(left === 19, `⭐ 长窗口那条在淘汰里活下来了（剩 ${left}，应为 19）`)
}

console.log('\n── ⭐ 清扫按各自的过期时刻，不按调用方的窗口 ──')
{
  resetBuckets()
  take('short', 5, 1_000)
  take('long', 5, 3_600_000)
  at(now + 2_000)
  const removed = sweep()
  ok(removed === 1, `只清掉真正过期的那条（清了 ${removed} 条）`)
  ok(bucketCount() === 1, '长窗口那条还在')
}

console.log('\n── ⭐ 请求路径上不能有 O(n) 扫描 ──')
{
  /*
    原来越过上限之后，每一条新 key 都做一次全表扫描，而窗口内的条目一条都删不掉 →
    size 不降 → 下一条继续全扫。实测每请求 1~1.7ms 的阻塞式 CPU，而且随 Map 变大继续恶化。
    Node 是单线程，这期间 SSR / socket.io / 所有直播联机房间全部停摆。
  */
  resetBuckets()
  Date.now = realNow
  for (let i = 0; i < 50_000; i++) take(`fill${i}`, 10, 60_000)
  const t0 = realNow()
  for (let i = 0; i < 5_000; i++) take(`new${i}`, 10, 60_000)
  const perCall = (realNow() - t0) / 5_000
  ok(perCall < 0.05, `满表之后每次 take 仍是 ${perCall.toFixed(4)} ms（阈值 0.05ms；原实现约 1.0~1.7ms）`)
  Date.now = () => now
}

console.log('\n── isMeaningfulIp ──')
ok(isMeaningfulIp('203.0.113.5') === true, '公网地址算数')
for (const bad of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.1', '172.16.0.1', 'fd00::1', 'unknown', ''])
  ok(isMeaningfulIp(bad) === false, `${bad || '(空)'} 不算数`)

console.log('\n── 路由层：这几道闸必须真的挂上去（源码守卫）──')
{
  /*
    下面四条都是「漏了不会报错、只会在被刷的时候才知道」的类型：
      · 登录/注册没限流 → 密码可无限爆破，bcryptjs 还在事件循环上
      · 翻译接口没限流 → 不登录就能烧按字符计费的付费 API
      · 草稿没挡 → 未登录能读未发布文章全文
      · 先建桶再判 IP → 被拒的请求照样往限流表里塞记录
    行为测试要起服务 + 连库，代价远大于收益，所以钉在源码上。
  */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const read = (rel) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'))

  const auth = read('../src/routes/auth.js')
  ok(/authRouter\.post\('\/login'[\s\S]{0,600}?authGateOk\(/.test(auth), '⭐ /login 有限流闸')
  ok(/authRouter\.post\('\/register'[\s\S]{0,900}?authGateOk\(/.test(auth), '⭐ /register 有限流闸')
  {
    // 闸必须在查库和 bcrypt 之前 —— 那两步才是攻击者想让我们花的钱
    const at = auth.indexOf("authRouter.post('/login'")
    const body = auth.slice(at, at + 1200)
    ok(body.indexOf('authGateOk(') < body.indexOf('SELECT * FROM users'), '⭐ /login 的闸在查库之前')
    ok(body.indexOf('authGateOk(') < body.indexOf('verifyPassword('), '⭐⭐ /login 的闸在 bcrypt 之前')
  }

  const posts = read('../src/routes/posts.js')
  {
    const at = posts.indexOf("postsRouter.post('/:slug/translate'")
    ok(at > 0, '找得到 posts 的 translate 路由')
    const body = posts.slice(at, at + 2600)
    ok(/translateGateOk\(/.test(body), '⭐ posts translate 有限流闸')
    ok(/row\.published/.test(body) && /hasAbility\(req, 'content:edit'\)/.test(body), '⭐⭐ posts translate 挡住未发布草稿')
    ok(/SELECT published,/.test(body), 'SELECT 里取了 published 列，否则上面那道判断恒为假')
  }

  const games = read('../src/routes/games.js')
  {
    const at = games.indexOf("gamesRouter.post('/:slug/translate-description'")
    ok(at > 0, '找得到 games 的 translate 路由')
    ok(/translateGateOk\(/.test(games.slice(at, at + 1200)), '⭐ games translate-description 有限流闸')
  }

  const ratings = read('../src/routes/ratings.js')
  {
    const at = ratings.indexOf('rating:anon:')
    const ipAt = ratings.indexOf('rating:ip:')
    ok(at > 0 && ipAt > 0, '两道闸都在')
    ok(ipAt < at, '⭐⭐ 按 IP 那道必须排在按 anonId 之前（anonId 是客户端自报的，先建桶等于白送一条记录）')
  }

  const open = read('../src/routes/open.js')
  {
    // 和 ratings 同一条教训，而且这里窗口是**一小时**：一小时内一条桶都清不掉，更糟
    const at = open.indexOf("openRouter.post('/v1/token'")
    const body = open.slice(at, at + 1400)
    const ipAt = body.indexOf('open:token:ip:')
    const appAt = body.indexOf('open:token:${clientId}')
    ok(ipAt > 0 && appAt > 0, '/v1/token 两道闸都在')
    ok(ipAt < appAt, '⭐⭐ 按 IP 那道要排在按 client_id 之前（client_id 在 authenticateApp 之前没经过任何验证）')
  }

  const me = read('../src/routes/me.js')
  ok(/import \{[^}]*gamesRatedBy[^}]*\} from '\.\.\/ratings-repo\.js'/.test(me), '⭐ me.js 补上了 ratings-repo 的 import（注销原来必 500）')
}

Date.now = realNow
console.log(`\n${fail ? '❌' : '✅'} 限流器：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
