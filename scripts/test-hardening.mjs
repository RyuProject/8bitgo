/**
 * 2026-09-12 那一轮安全审计修掉的东西，逐条钉住。跑：npm run test:hardening
 *
 * 这些缺陷有一个共同点：**症状都不像缺陷**。
 * 后门开着的表现是「一切正常」；正则回溯的表现是「服务器偶尔很慢」；
 * 分页不取整的表现是「有人报了个 500」；收藏双击的表现是「收藏失败」（其实成功了）。
 * 所以每一条都得有测试盯着，否则下一次重构悄悄改回去，没人会发现。
 *
 * 纯逻辑的部分（邮箱、后门护栏）真的 import 进来跑；接线的部分扫源码 ——
 * 扫的是「那道闸还在不在」，不是「长什么样」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEmail, normalizeEmail, EMAIL_MAX } from '../shared/email.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
/** 去注释再扫：被扫的源码里注释大段引用了同样的标识符 */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

let pass = 0
const fails = []
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}

console.log('\n── 邮箱校验：先判长度再跑正则 ──')

check('正常邮箱照常认', () => {
  assert.equal(isEmail('a@b.com'), true)
  assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com')
  assert.equal(normalizeEmail('不是邮箱'), '')
})

check('⚠️ 超长输入在微秒级被拒，不是秒级', () => {
  /*
    这条用例是整个文件的由来。`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` 对
    `a@` + `a.`×N + `@b` 这种输入是灾难性回溯，实测 63KB 要 1294ms、二次增长，
    而注册 / 登录 / 发验证码都是**未认证**的、请求体上限 4MB ——
    一条请求就能把 Node 的事件循环占住小时级，全站 API、SSR、socket.io 一起停。

    所以这里量的是**时间**，不只是返回值：只断言 `=== false` 的话，
    把长度闸删掉测试照样绿（那时它返回的也是 false，只是要等一个小时）。
  */
  const evil = 'a@' + 'a.'.repeat(200_000) + '@b' // 约 400 KB
  const t = process.hrtime.bigint()
  assert.equal(isEmail(evil), false)
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.ok(ms < 50, `400KB 的恶意输入花了 ${ms.toFixed(1)}ms —— 长度闸没起作用`)
})

check('长度上限是 RFC 5321 的 254', () => {
  assert.equal(EMAIL_MAX, 254)
  assert.equal(isEmail('a'.repeat(250) + '@b.com'), false)
  assert.equal(isEmail('a'.repeat(240) + '@b.com'), true)
})

check('⚠️ 站内不许再有第二份裸正则（漏掉长度闸的那种）', () => {
  /*
    这一条比上面几条都重要：修好一处不等于修好。
    新加一个「顺手写个 EMAIL_RE.test」的地方，就把这个洞原样搬回来了。
  */
  for (const rel of ['server/src/routes/auth.js', 'server/src/routes/me.js', 'server/src/im-lookup.js']) {
    assert.doesNotMatch(strip(read(rel)), /EMAIL_RE\s*=/, `${rel} 里又自己写了一份邮箱正则`)
  }
})

check('⚠️ /login 在用 email 建限流 key 之前先校验它', () => {
  /*
    authGateOk 把 email 拼进 `auth:login:email:${email}` 当限流表的 key。
    不校验的话这个 key 是攻击者可控、长度无上限的字符串，而 rateLimit 的
    MAX_BUCKETS 管的是**条数**不是字节 —— 几十条 4MB 的 key 就能把限流表本身撑爆。
  */
  const auth = strip(read('server/src/routes/auth.js'))
  const i = auth.indexOf("authRouter.post('/login'")
  assert.ok(i > 0, '找不到 /login')
  const body = auth.slice(i, i + 900)
  const guard = body.indexOf('isEmail(email)')
  const gate = body.indexOf('authGateOk(')
  assert.ok(guard > 0, '/login 没有校验邮箱')
  assert.ok(gate > 0, '找不到 authGateOk')
  assert.ok(guard < gate, '邮箱校验排在限流之后 —— 无界的 key 已经进表了')
})

console.log('\n── 后台鉴权后门：非本机地址拒绝启动 ──')

const auth = await import('../server/src/auth.js')

check('本机地址都认得出来', () => {
  for (const u of [
    'http://localhost:8788', 'http://127.0.0.1:3000', 'http://[::1]:80',
    'http://dev.localhost', 'http://mac.local', 'http://192.168.1.10',
    'http://10.0.0.5', 'http://172.16.0.1', 'http://172.31.255.254',
  ]) assert.equal(auth.isLocalSiteUrl(u), true, u)
})

check('⚠️ 公网地址一律不算本机', () => {
  for (const u of [
    'https://8bitgo.com', 'https://www.8bitgo.com', 'http://1.2.3.4',
    'http://172.32.0.1', 'http://11.0.0.1', 'https://localhost.evil.com',
  ]) assert.equal(auth.isLocalSiteUrl(u), false, u)
})

check('⚠️ 地址不合法时当成「不是本机」（宁可拦住启动）', () => {
  assert.equal(auth.isLocalSiteUrl(''), false)
  assert.equal(auth.isLocalSiteUrl('不是地址'), false)
  assert.equal(auth.isLocalSiteUrl(undefined), false)
})

check('⚠️ 后门 + 生产域名 = 必须拒绝启动', () => {
  /*
    roleOfRequest 的第一行就是 `if (ADMIN_AUTH_DISABLED) return 'admin'`，在读 token 之前。
    这个组合意味着一条不带凭证的 PATCH /api/users/<id> {"role":"admin"} 就能提权。
    2026-09-12 审计时它正开在一份 PUBLIC_SITE_URL 指向正式域名、DB 连生产库的 .env 里，
    而当时唯一的保护是启动时打一段警告 —— 警告拦不住任何事。
  */
  const src = strip(read('server/src/auth.js'))
  assert.match(src, /export function adminBackdoorFatal/)
  assert.match(src, /if \(!ADMIN_AUTH_DISABLED\) return ''/)
  const idx = strip(read('server/src/index.js'))
  assert.match(idx, /adminBackdoorFatal\(\)/, 'index.js 没有调这道护栏')
  assert.match(idx, /process\.exit\(1\)/, '没有真的退出')
  // 必须停在 listen 之前 —— 端口开了，后门就已经对外可达了
  assert.ok(
    idx.indexOf('adminBackdoorFatal()') < idx.indexOf('const PORT'),
    '护栏排在监听端口之后 —— 那时后门已经对外开着了',
  )
})

console.log('\n── 其余几条 ──')

check('⚠️ 分页参数取整（否则 LIMIT 2.5 直接把 /api/games 和 SSR 打成 500/503）', () => {
  const repo = strip(read('server/src/games-repo.js'))
  assert.match(repo, /const pageSize = Math\.trunc\(/)
  assert.match(repo, /const page = Math\.trunc\(/)
})

check('⚠️ /api/netplay/ice 有闸（它不需要登录就发 TURN 凭证）', () => {
  const ice = strip(read('server/src/routes/ice.js'))
  assert.match(ice, /take\(`ice:ip:\$\{ip\}`/, '没有按 IP 的闸')
  assert.match(ice, /take\('ice:global'/, '没有全站兜底的闸')
  // 先 IP 后全站：反过来的话一个刷子把全站额度吃光，正常玩家全被挡在外面
  assert.ok(ice.indexOf('ice:ip:') < ice.indexOf("'ice:global'"), '两层闸的顺序反了')
})

check('⚠️ POST /api/oauth/authorize 有 requireUser', () => {
  /*
    那一段代码把第三方应用绑到 req.user.id 铸授权码。少了守卫的话，
    它在没有任何身份证明的情况下给某个 sub 铸码。
    审计时挡住它的只是「req.user 恰好 undefined 所以抛异常」——那是崩溃，不是判断。
  */
  const oauth = strip(read('server/src/routes/oauth.js'))
  const i = oauth.indexOf("oauthRouter.post(\n  '/authorize',")
  assert.ok(i > 0, '找不到 POST /authorize')
  const head = oauth.slice(i, i + 260)
  assert.match(head, /requireUser/, 'POST /authorize 没有守卫')
})

check('⚠️ 审核动作不裸用 req.user.id（ADMIN_TOKEN 那条路径上它是 undefined）', () => {
  const src = strip(read('server/src/routes/admin-open-apps.js'))
  assert.doesNotMatch(src, /req\.user\.id/, '又裸用了 req.user.id —— 四个审核动作会全部 500')
  assert.match(src, /function reviewerId/)
})

check('⚠️ 存档配额的查和写在同一个事务同一把锁下', () => {
  const saves = strip(read('server/src/routes/saves.js'))
  assert.match(saves, /withTransaction\(async \(run\)/, '配额检查没有事务')
  assert.match(saves, /SELECT id FROM users WHERE id = \? FOR UPDATE/, '没有拿锁 —— 并发写不同档位可以绕过总量上限')
})

check('⚠️ 收藏不再是「先查再裸 INSERT」（双击会 500，而且其实已经成功了）', () => {
  const me = strip(read('server/src/routes/me.js'))
  assert.doesNotMatch(me, /INSERT INTO favorites/, '还是裸 INSERT，撞唯一键就是 500')
  assert.match(me, /INSERT IGNORE INTO favorites/)
  assert.match(me, /DELETE FROM favorites[\s\S]{0,200}affectedRows/, '不是「先删，删不到才插」那个形状')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 加固回归：${pass} 条全过`)
