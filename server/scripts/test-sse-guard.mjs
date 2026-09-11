/**
 * SSE 准入闸的回归测试。跑：cd server && npm run test:sse-guard
 *
 * 盯的是 2026-09-09 那次事故的修法，以及 09-10 复审查出的三个 P0 ——
 * **那三个当时全落在这个测试的盲区里，32 项全绿也没拦住**，所以每一条都补了用例：
 *
 *   · isPrivateIp 不认 `::ffff:` → 反代没透传真实 IP 时全站塌缩成一个桶、一起被限死
 *   · 限流身份取的是可伪造的 XFF 第一段 → 600 个假 IP 就能吃满总量、把全站顶下线
 *   · sseStats 往公开的 /api/diag 里吐别人的真实 IP
 *
 * 每一条都配了「反向用例」—— 只验证"挡住了"很容易写出一个把所有人都挡住的闸。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

process.env.SSE_MAX_PER_IP = '3'
process.env.SSE_MAX_TOTAL = '5'
process.env.SSE_MAX_LIFETIME_MS = '600000'

const { admitSse, isCrawlerUa, resetSseCounters, sseStats } = await import('../src/sseGuard.js')
const { isPrivateIp } = await import('../src/presence.js')

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m))
}

/**
 * req/res 替身。
 * `remote` 是 socket 对端（生产里是同机 nginx），`xff` 是 X-Forwarded-For 原样字符串。
 */
function fake(ua = 'Mozilla/5.0 (Macintosh) Chrome/140', { remote = '203.0.113.5', xff = '' } = {}) {
  const headers = { 'user-agent': ua }
  if (xff) headers['x-forwarded-for'] = xff
  const req = { headers, socket: { remoteAddress: remote } }
  const res = new EventEmitter()
  Object.assign(res, {
    code: 200,
    headers: {},
    ended: false,
    set(a, b) {
      if (typeof a === 'string') res.headers[a.toLowerCase()] = b
      else for (const [k, v] of Object.entries(a)) res.headers[k.toLowerCase()] = v
      return res
    },
    status(n) {
      res.code = n
      return res
    },
    json() {
      return res.end()
    },
    // 真 Node 里响应结束会让请求侧发 close，替身也照做，否则名额永远还不回来
    end() {
      if (!res.ended) {
        res.ended = true
        res.emit('close')
      }
      return res
    },
    flushHeaders() {},
  })
  return { req, res }
}

console.log('── 爬虫挡得住 ──')
resetSseCounters()
for (const ua of [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17 Safari/605.1.15 Applebot/0.1',
  'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
  'Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)',
  'curl/8.4.0',
  'python-requests/2.31.0',
]) {
  const { req, res } = fake(ua)
  ok(admitSse(req, res) === false && res.code === 204, `拒掉 ${ua.slice(0, 44)}…（204）`)
}
ok(sseStats().total === 0, '被拒的爬虫一条名额都不占')
ok(sseStats().blocked.crawler === 9, 'blocked.crawler 数对得上（误判要靠这个数字才看得见）')

console.log('\n── ⭐ 真人不能被误伤（这三条第一版都误伤过）──')
for (const [ua, why] of [
  ['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 SogouMobileBrowser/5.28.0', '搜狗手机浏览器（裸 sogou 会误杀）'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) SogouSearch iPhone/1.0 Safari/604.1', '搜狗搜索 App（同上）'],
  ['Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 20) AppleWebKit/537.36 Chrome/140 Mobile', '手机型号带 bot（裸 bot 会误杀）'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36 Preview', 'UA 尾巴带 Preview（裸 preview 会误杀）'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36', '普通桌面 Chrome'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone Safari'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox'],
]) {
  ok(!isCrawlerUa(ua), `不误判：${why}`)
}
ok(!isCrawlerUa(''), 'UA 为空**不算**爬虫 —— 否则自家测试和健康检查会被一起挡掉')

console.log('\n── 响应头 ──')
resetSseCounters()
{
  const { req, res } = fake()
  ok(admitSse(req, res) === true, '正常浏览器放行')
  ok(res.headers['content-type'] === 'text/event-stream; charset=utf-8', 'Content-Type 是 event-stream')
  ok(res.headers['x-accel-buffering'] === 'no', '带 X-Accel-Buffering: no（少了 nginx 会把流缓冲住）')
  ok(/no-cache/.test(res.headers['cache-control'] || ''), 'Cache-Control 不缓存')
}

console.log('\n── per-IP 上限 ──')
resetSseCounters()
{
  const live = []
  for (let i = 0; i < 3; i++) {
    const { req, res } = fake('Chrome/140', { remote: '203.0.113.9' })
    ok(admitSse(req, res) === true, `同一 IP 第 ${i + 1} 条放行`)
    live.push(res)
  }
  const { req, res } = fake('Chrome/140', { remote: '203.0.113.9' })
  ok(admitSse(req, res) === false && res.code === 503, '同一 IP 第 4 条被拒（503）')
  ok(res.headers['retry-after'] === '30', '拒的时候给了 Retry-After')
  ok(sseStats().blocked.perIp === 1, 'blocked.perIp 记上了')

  const other = fake('Chrome/140', { remote: '198.51.100.7' })
  ok(admitSse(other.req, other.res) === true, '换个 IP 不受影响 —— 闸是按 IP 关的，不是全站关的')

  live[0].end()
  const again = fake('Chrome/140', { remote: '203.0.113.9' })
  ok(admitSse(again.req, again.res) === true, '断开一条就还回一个名额')
}

console.log('\n── ⭐ isPrivateIp 必须认 IPv4-mapped（第二道保险，单独钉）──')
{
  /**
   * `clientIpFrom` 内部已经先 normalizeIp 过一遍，所以**光靠上面那些走 admitSse 的用例
   * 测不到这条** —— 把 isPrivateIp 的削前缀删掉，那些用例照样全绿（实测过）。
   * 但 isPrivateIp 是导出的公共函数，别的调用方不一定记得先 normalize，
   * 所以在这里直接打它。
   */
  for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.5', '::ffff:172.17.0.1', '::ffff:192.168.1.7', '127.0.0.1', '::1']) {
    ok(isPrivateIp(ip) === true, `${ip} 判为内网`)
  }
  for (const ip of ['203.0.113.5', '::ffff:203.0.113.5', '156.232.97.185', '2408:8427:ee21::1']) {
    ok(isPrivateIp(ip) === false, `${ip} 判为公网`)
  }
}

console.log('\n── ⭐ P0：反代没透传真实 IP 时不能把整站限死 ──')
resetSseCounters()
{
  /**
   * `index.js` 的 listen 不带 host → Node 双栈绑 :: → 同机 nginx 走 IPv4 回环连进来
   * 就是 `::ffff:127.0.0.1`。isPrivateIp 以前不削这个前缀，把它当成一个公网访客，
   * 于是全站访客共用一个桶，第 4 条起全员 503。
   */
  let all = true
  for (let i = 0; i < 5; i++) {
    const { req, res } = fake('Chrome/140', { remote: '::ffff:127.0.0.1' })
    if (admitSse(req, res) !== true) all = false
  }
  ok(all, '⭐ `::ffff:127.0.0.1` 认成内网，超过 per-IP 上限照样放行')
  ok(sseStats().ips === 0, '内网来源不进 per-IP 计数表')

  resetSseCounters()
  let docker = true
  for (let i = 0; i < 5; i++) {
    const { req, res } = fake('Chrome/140', { remote: '::ffff:172.17.0.1' })
    if (admitSse(req, res) !== true) docker = false
  }
  ok(docker, 'Docker 网段的 `::ffff:172.17.0.1` 同理')
}

console.log('\n── ⭐ P0：伪造 X-Forwarded-For 绕不过 ──')
resetSseCounters()
{
  /**
   * nginx 的 $proxy_add_x_forwarded_for 是「客户端带来的那串 + 我亲眼看到的对端」，
   * 真实 IP 追加在**末尾**。取第一段 = 取客户端自己写的那段 = 随便伪造。
   */
  const real = '198.51.100.77'
  let admitted = 0
  for (let i = 0; i < 6; i++) {
    const { req, res } = fake('Chrome/140', { remote: '127.0.0.1', xff: `10.9.9.${i}, 1.2.3.${i}, ${real}` })
    if (admitSse(req, res) === true) admitted++
  }
  ok(admitted === 3, `⭐ 每条都带不同的假 XFF 头，仍然只放行 3 条（实际放行 ${admitted}）—— 认的是最后一跳`)
  const st = sseStats()
  ok(st.ips === 1, '六条假身份被归成同一个真实来源')
  ok(st.blocked.perIp === 3, '多出来的三条都算在 per-IP 头上')
}

console.log('\n── 总量上限（最后一道兜底）──')
resetSseCounters()
{
  for (let i = 0; i < 5; i++) {
    const { req, res } = fake('Chrome/140', { remote: `198.51.100.${i}` })
    admitSse(req, res)
  }
  const { req, res } = fake('Chrome/140', { remote: '198.51.100.200' })
  ok(admitSse(req, res) === false && res.code === 503, '到总量上限后连新 IP 也拒')
  ok(sseStats().total === 5 && sseStats().blocked.total === 1, 'sseStats 的条数和拒绝分类都对')
}

console.log('\n── ⭐ P1：公开接口不能吐别人的完整 IP ──')
{
  const st = sseStats()
  ok(!('topIp' in st), '⭐ sseStats 不再有 topIp 字段')
  const dump = JSON.stringify(st)
  ok(!/198\.51\.100\.\d+"/.test(dump), `⭐ 序列化出来不含任何完整 IP（${dump}）`)
  ok(/^198\.51\.100\.\*$/.test(st.topNet || ''), `topNet 打码到网段：${st.topNet}`)
}

console.log('\n── 最长存活时间 ──')
resetSseCounters()
{
  process.env.SSE_MAX_LIFETIME_MS = '60'
  // 查询串换一个 = 拿到一份全新的模块实例，好用不同的上限跑
  const short = await import('../src/sseGuard.js?lifetime=60')
  const { req, res } = fake()
  short.admitSse(req, res)
  ok(!res.ended, '刚开的流不会立刻被收掉')
  await new Promise((r) => setTimeout(r, 200))
  ok(res.ended, '到了最长存活时间就主动收（EventSource 会自己重连，玩家无感）')
  ok(short.sseStats().total === 0, '收掉之后名额也还回来了')
}

console.log('\n── /api/diag：turn / sse 只给管理员 ──')
{
  /*
    2026-09-11 线上实测：任何人 `curl https://8bitgo.com/api/diag` 都能拿到
    `sse.topIp` —— 一个真实访客的完整 IP。脱敏（maskIp）是后来补的，但那只是把
    完整 IP 换成网段；真正的问题是这一整段**本来就不该给匿名访客看**。
    这里用 ADMIN_TOKEN 那条路跑真的 handler（不碰数据库：roleOfRequest 命中口令就返回了）。
  */
  process.env.ADMIN_TOKEN = 'test-admin-token-for-diag'
  const { diagRouter } = await import('../src/routes/diag.js')

  const callDiag = (authorization) =>
    new Promise((resolve, reject) => {
      const req = {
        method: 'GET',
        url: '/',
        headers: authorization ? { authorization } : {},
        socket: { remoteAddress: '203.0.113.9' },
      }
      const res = {
        code: 200,
        set: () => res,
        status(n) {
          res.code = n
          return res
        },
        json(body) {
          resolve({ code: res.code, body })
          return res
        },
      }
      diagRouter(req, res, (e) => (e ? reject(e) : resolve({ code: 404, body: null })))
    })

  const anon = await callDiag(null)
  ok(anon.code === 200, '匿名照样 200 —— 排查「国旗为什么是 ❓」不需要登录')
  ok(anon.body.ip?.effective === '203.0.113.9', '自己那份 IP 链照常回显（隐私政策里写明了的那部分）')
  ok(anon.body.sse === undefined, '⭐ 匿名看不到 sse')
  ok(anon.body.turn === undefined, '⭐ 匿名看不到 turn（里面有 TURN 中继地址）')
  ok(
    !JSON.stringify(anon.body).includes('topIp') && !JSON.stringify(anon.body).includes('topNet'),
    '⭐ 整个匿名响应里不含任何别人的地址字段',
  )
  ok(/ADMIN_TOKEN/.test(anon.body.restricted || ''), '明说少了什么、怎么拿，别让人以为接口坏了')

  // 反向用例：只验证「挡住了」很容易写出一个把管理员也挡住的门
  const admin = await callDiag('Bearer test-admin-token-for-diag')
  ok(admin.code === 200 && admin.body.sse !== undefined, '⭐ 带对 ADMIN_TOKEN 就能看到 sse')
  ok(admin.body.turn !== undefined, '⭐ 带对 ADMIN_TOKEN 就能看到 turn')
  ok(admin.body.restricted === undefined, '管理员那份不该再带 restricted 提示')
  ok(typeof admin.body.sse.maxPerIp === 'number', 'sse 内容本身没被削掉')

  const wrong = await callDiag('Bearer not-the-token')
  ok(wrong.body.sse === undefined, '口令不对等同匿名')
}

console.log('\n── 源码守卫 ──')
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const guard = strip(readFileSync(new URL('../src/sseGuard.js', import.meta.url), 'utf8'))
  ok(
    !/from '\.\/playcount\.js'/.test(guard),
    "⭐ 不许再从 playcount 拿 clientIp —— 那个取的是 XFF 第一段，可以伪造",
  )
  ok(/clientIpFrom\(/.test(guard), '用的是 presence 的 clientIpFrom（取最后一跳）')

  for (const [file, route] of [
    ['../src/index.js', '/api/live/events'],
    ['../src/netplay.js', '/api/netplay/events'],
  ]) {
    const src = strip(readFileSync(new URL(file, import.meta.url), 'utf8'))
    const at = src.indexOf(route)
    assert.ok(at > 0, `${file} 里找不到 ${route}`)
    const body = src.slice(at, at + 400)
    ok(/admitSse\(req,\s*res\)/.test(body), `${route} 的 handler 开头就调了 admitSse`)
    ok(!/text\/event-stream/.test(body), `${route} 不再自己写响应头（统一由 admitSse 写）`)
  }
}

console.log(`\n${fail ? '❌' : '✅'} SSE 准入闸：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
