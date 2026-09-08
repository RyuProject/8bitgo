/**
 * 「按邮箱找人」的回归测试。跑：npm run test:im-lookup
 *
 * 这一份测的是 im-lookup.js 里的**纯逻辑**（路由只是限流 + 查库 + 把它的结果发出去），
 * 所以不需要数据库、不需要起 express，能进 CI。
 *
 * 盯的是三类「改一行就坏、而且从界面上完全看不出来」的事：
 *
 *   一、**信息面**。这个接口回的每一个字段都会到浏览器里。多回一个 email / role /
 *       status，界面上什么都不会变 —— 但撞库者会拿到他要的东西。
 *   二、**不可区分**。「查无此人」和「这人被封了」必须回**同一份字节**。
 *       只要两条分支的响应有一丁点不同，这个接口就顺带变成了封禁状态查询器。
 *   三、**规范化**。邮箱是用户手输的，大小写、空格、超长串全都要在查库之前处理掉。
 *
 * ⚠️ 每加一条断言，都要顺手做一次**变异校验**：把源码那一行故意改坏，确认这条断言
 * 真的会红。本会话里已经有过两次「断言看着很对、但删掉被测代码照样绿」的教训。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  IM_LOOKUP_LIMIT,
  IM_LOOKUP_WINDOW_MS,
  lookupOutcome,
  normalizeLookupEmail,
} from '../src/im-lookup.js'
import { isValidImUserId } from '../src/im-sig.js'

let n = 0
const check = (name, fn) => {
  n++
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name)
    throw e
  }
}

/** 一行「长得像真的」的 users 记录 —— 故意把不该外泄的列全带上 */
const row = (over = {}) => ({
  id: 'u_1a2b3c4d5e6f',
  email: 'peer@example.com',
  nickname: '隔壁老王',
  avatar: '👾',
  status: 'active',
  role: 'admin',
  coins: 999999,
  password_hash: '$2b$10$xxxxxxxxxxxxxxxxxxxxxx',
  token_version: 7,
  birth_date: '1990-01-01',
  created_at: '2024-01-01T00:00:00.000Z',
  ...over,
})

const ME = 'u_meeeeeeeeeeee'

console.log('\n一、邮箱规范化')

check('大小写、前后空格都要抹平（库里存的一律是小写）', () => {
  assert.equal(normalizeLookupEmail('  Peer@Example.COM  '), 'peer@example.com')
  assert.equal(normalizeLookupEmail('\tA@b.co\n'), 'a@b.co')
})

check('不像邮箱的一律返回空串，而不是原样放行', () => {
  for (const bad of ['', '   ', 'nope', 'a@b', 'a b@c.com', '@b.co', 'a@.', 'a@b c.co']) {
    assert.equal(normalizeLookupEmail(bad), '', `「${bad}」不该被当成邮箱`)
  }
})

check('null / undefined / 数字 / 对象都不能炸（body 是用户给的，什么都可能是）', () => {
  for (const bad of [null, undefined, 123, {}, [], true]) {
    assert.equal(normalizeLookupEmail(bad), '')
  }
  // ⚠️ 特别是数组：String(['a@b.co']) === 'a@b.co'，写成 `raw.trim()` 会在这里过掉
  assert.equal(normalizeLookupEmail(['a@b.co']), 'a@b.co')
})

check('⭐ 超长的邮箱要判死，不能截断了再拿去查', () => {
  /*
    ⚠️ 这个用例的构造是关键，第一版写错过：用 `'a'.repeat(200) + '@example.com'` 的话，
    截断成前 200 字符就变成一串纯 a、没有 @，正则自己会把它挡掉 ——
    于是「先截断再校验」这个 bug 照样绿。变异校验当场抓到了这一点。

    真正危险的是**截断之后仍然是个合法邮箱**：那样 SQL 查的是另一个地址，
    而用户完全看不出来。所以这里必须让截断结果依旧合法。
  */
  const long = 'a'.repeat(180) + '@example.com' + 'z'.repeat(20)
  assert.ok(long.length > 200)
  assert.match(long.slice(0, 200), /^[^\s@]+@[^\s@]+\.[^\s@]+$/, '用例失效：截断后必须仍是合法邮箱')
  assert.notEqual(long.slice(0, 200), long)
  assert.equal(normalizeLookupEmail(long), '', '超长串被放行了（多半是先校验后截断）')
  // 边界：正好 200 要过
  const exact = 'a'.repeat(200 - '@example.com'.length) + '@example.com'
  assert.equal(exact.length, 200)
  assert.equal(normalizeLookupEmail(exact), exact)
})

console.log('\n二、信息面 —— 只能回三个字段')

check('⭐ 成功响应的键**恰好**是 id / nickname / avatar', () => {
  const out = lookupOutcome(row(), ME, isValidImUserId)
  assert.equal(out.status, 200)
  assert.deepEqual(
    Object.keys(out.body).sort(),
    ['avatar', 'id', 'nickname'],
    '多回了字段 —— 检查是不是有人写了 `...row`',
  )
  // 逐个点名，比只数键更能说清是哪一个漏出去了
  for (const leak of ['email', 'role', 'status', 'coins', 'password_hash', 'token_version', 'birth_date', 'created_at']) {
    assert.equal(out.body[leak], undefined, `${leak} 漏到响应里了`)
  }
})

check('⭐ 尤其不能把邮箱原样回显', () => {
  const out = lookupOutcome(row(), ME, isValidImUserId)
  const json = JSON.stringify(out.body)
  assert.ok(!json.includes('peer@example.com'), '响应里出现了被查的邮箱 —— 那是撞库者的免费校对器')
})

check('头像为空时兜底成 🕹️（和 mappers.js 的 userRowToPublic 同一个默认值）', () => {
  assert.equal(lookupOutcome(row({ avatar: '' }), ME, isValidImUserId).body.avatar, '🕹️')
  assert.equal(lookupOutcome(row({ avatar: null }), ME, isValidImUserId).body.avatar, '🕹️')
  assert.equal(lookupOutcome(row({ avatar: '👾' }), ME, isValidImUserId).body.avatar, '👾')
})

console.log('\n三、查无此人 与 被封禁 必须不可区分')

check('⭐ 两者的状态码和响应体**逐字节相同**', () => {
  const missing = lookupOutcome(null, ME, isValidImUserId)
  const banned = lookupOutcome(row({ status: 'banned' }), ME, isValidImUserId)
  assert.equal(missing.status, 404)
  assert.equal(banned.status, 404)
  assert.equal(
    JSON.stringify(banned.body),
    JSON.stringify(missing.body),
    '被封禁和不存在回了不一样的东西 —— 这个接口成了「查某人是不是被封了」的查询器',
  )
})

check('未来新增的任何非 active 状态，默认也走同一条路', () => {
  // 判断写成 `status !== 'active'` 而不是 `status === 'banned'`：
  // 以后加一个 'pending' / 'deleted'，前者自动收口，后者会静默放行
  for (const st of ['banned', 'pending', 'deleted', '', undefined, null]) {
    const out = lookupOutcome(row({ status: st }), ME, isValidImUserId)
    assert.equal(out.status, 404, `status=${st} 被当成了可用账号`)
  }
})

check('响应体里不带任何能区分两者的线索（连昵称都不能有）', () => {
  const banned = lookupOutcome(row({ status: 'banned' }), ME, isValidImUserId)
  const json = JSON.stringify(banned.body)
  for (const leak of ['隔壁老王', 'u_1a2b3c4d5e6f', '👾']) {
    assert.ok(!json.includes(leak), `404 里带上了 ${leak}`)
  }
})

console.log('\n四、自己、以及不能聊天的账号')

check('⭐ 查到自己要单独说一句，而不是混进「查无此人」', () => {
  const out = lookupOutcome(row({ id: ME }), ME, isValidImUserId)
  assert.equal(out.status, 400)
  assert.equal(out.code ?? out.body.code, 'self')
  // 不单独说的话，用户会看到「没有这个用户」，然后开始怀疑自己的账号出问题了
  assert.notEqual(out.status, 404)
})

check('自己排在封禁判断之前（被封的账号查自己也该说「这是你自己」）', () => {
  const out = lookupOutcome(row({ id: ME, status: 'banned' }), ME, isValidImUserId)
  assert.equal(out.body.code, 'self')
})

check('id 比较是字符串比较，不能被类型糊弄过去', () => {
  // 库里 id 是 VARCHAR，但万一将来换成自增整数，`===` 会在 1 !== '1' 上悄悄失效
  assert.equal(lookupOutcome({ ...row(), id: 42 }, 42, isValidImUserId).body.code, 'self')
  assert.equal(lookupOutcome({ ...row(), id: '42' }, 42, isValidImUserId).body.code, 'self')
})

check('⭐ id 不合腾讯 userID 规则时回 409，不能混进 404', () => {
  // ^[A-Za-z0-9_-]{1,32}$ —— 带点、带 @、超过 32 位的都不行
  const bad = lookupOutcome(row({ id: 'user.with.dots' }), ME, isValidImUserId)
  assert.equal(bad.status, 409, '回成 404 的话，用户会以为对方没注册，反复重输同一个邮箱')
  assert.equal(bad.body.code, 'unusable')
  // 而且这个分支要在 active 判断**之后** —— 被封禁的人不该因为 id 好看就露出 409
  assert.equal(lookupOutcome(row({ id: 'user.with.dots', status: 'banned' }), ME, isValidImUserId).status, 404)
})

check('canChat 默认放行，但路由里必须真的把 isValidImUserId 传进来', () => {
  assert.equal(lookupOutcome(row({ id: 'user.with.dots' }), ME).status, 200, '默认参数应当放行')
  const route = readRoute()
  // 用 includes 而不是 assert.match：断言失败时 match 会把整个路由文件打进报错里
  assert.ok(route.includes('isValidImUserId)'), '路由没把 isValidImUserId 传进 lookupOutcome')
})

console.log('\n五、每一种失败都要有 code（八种语言的界面靠它查文案）')

check('所有非 200 的响应都带 code，且互不重复', () => {
  const cases = [
    lookupOutcome(null, ME, isValidImUserId),
    lookupOutcome(row({ id: ME }), ME, isValidImUserId),
    lookupOutcome(row({ id: 'user.with.dots' }), ME, isValidImUserId),
  ]
  const codes = cases.map((c) => c.body.code)
  for (const c of cases) {
    assert.ok(c.body.code, '有一个失败分支没给 code —— 前端只能显示服务端的中文原话')
    assert.ok(c.body.error, '也要留一句中文，curl 和日志里要看得懂')
  }
  assert.equal(new Set(codes).size, codes.length, 'code 撞车了，前端分不开')
})

console.log('\n六、限流常量')

check('⭐ 找人的额度必须明显紧于签发（/sig 是 30/小时）', () => {
  assert.ok(IM_LOOKUP_LIMIT <= 20, `找人额度 ${IM_LOOKUP_LIMIT} 太松了`)
  assert.ok(IM_LOOKUP_LIMIT >= 5, '太紧会误伤正常用户')
  assert.equal(IM_LOOKUP_WINDOW_MS, 3600_000)
})

check('⭐ 路由用的是 { ok } 而不是把 take() 当布尔', () => {
  /*
    本会话里真的写错过一次：take() 返回 { ok, retryAfter } 对象，
    `if (!take(...))` 恒假，限流静默失效。

    ⚠️ 必须只在 lookup 那一段里查，不能全文查（注意：注释里别写 星星斜杠，会提前闭合）。
    第一版写的是 `route.includes('if (!gate.ok)')` —— 而 /sig 里也有一模一样的一行，
    于是把 /lookup 的判断改坏，这条断言照样绿。变异校验抓到了，这里改成切段再查。
  */
  const seg = lookupSegment()
  assert.ok(seg.includes('take(`im:lookup:${req.user.id}`'), '限流没按账号分桶')
  assert.ok(seg.includes('if (!gate.ok)'), '没判 .ok —— 限流会静默失效')
  assert.ok(!/if \(!take\(/.test(seg), '出现了 `if (!take(...))` 这种恒假写法')
  assert.ok(seg.includes('IM_LOOKUP_LIMIT'), '限流用的不是找人自己的额度（多半误用了 SIG_LIMIT）')
})

check('⭐ 没配 IM 时这个探针必须是关着的', () => {
  const seg = lookupSegment()
  const gate = seg.slice(0, seg.indexOf('normalizeLookupEmail'))
  assert.match(gate, /imConfigFrom\(\)/, '没检查 IM 配置')
  assert.match(gate, /status\(501\)/, '没配 IM 时应当回 501，而不是照常查库')
})

check('⭐ selfId 只能取自 req.user.id，SQL 只能是全等', () => {
  const seg = lookupSegment()
  assert.ok(seg.includes('lookupOutcome(row, String(req.user.id)'), 'selfId 不是从 req.user.id 来的')
  assert.ok(!/req\.body[^\n]*\b(userId|id|selfId)\b/.test(seg), '有分支从请求体里取身份')
  assert.ok(seg.includes('FROM users WHERE email = ?'), '查库不是按邮箱全等')
  assert.ok(!/\bLIKE\b/i.test(seg), '出现了 LIKE —— 这个接口就从「验证一个已知地址」变成「捞邮箱」了')
  assert.ok(!/SELECT \* FROM users/.test(seg), '用了 SELECT *，密码哈希会跟着进内存')
})

/**
 * 读路由源码，**先把注释去掉**。
 *
 * 这一步不是洁癖：im.js 的注释里逐字写着 `if (!take(...))` 和「一旦出现 LIKE」
 * 这两句警告 —— 不去注释的话，下面那两条「不许出现」的断言会被自己的警告文案打红。
 * 反过来说，如果哪天有人把真代码改坏、又顺手把警告注释删了，断言照样能抓住。
 */
/**
 * 只取 POST /lookup 那一段（去注释之后）。
 *
 * 整个 im.js 里有两个 handler，而它们**长得很像** —— 都有 take()、都有 501、
 * 都判 gate.ok。全文 grep 的话，改坏其中一个、另一个会替它把断言撑绿。
 */
function lookupSegment() {
  const route = readRoute()
  const at = route.indexOf("imRouter.post('/lookup'")
  assert.ok(at > 0, '找不到 POST /lookup 这个 handler')
  return route.slice(at)
}

function readRoute() {
  return readFileSync(new URL('../src/routes/im.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

console.log(`\n✅ 按邮箱找人：${n} 项通过`)
