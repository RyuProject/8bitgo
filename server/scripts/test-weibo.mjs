/**
 * 微博登录的自检。不连数据库、不连微博，把 db.js 和 fetch 都换成假的，
 * 只跑 routes/auth.js 里那两条真实的路由。
 *
 * 用法：cd server && npm run test:weibo
 *
 * 盯的是几件「上线才会发现」的事：
 *   1. 没配 App Key / Secret 时是干脆的 503，而不是拿空 key 去请求微博；
 *   2. App Secret 不会出现在授权地址里（它只能在服务端换 token 时用）；
 *   3. 微博吐 HTML 错误页时是 401，不是被 JSON.parse 抛成 500；
 *   4. 同一个 uid 登两次拿到的是**同一个账号**，不会因为占位邮箱又建一个；
 *   5. 取昵称失败不影响登录 —— users/show.json 的权限是会变的。
 */
import { register } from 'node:module'
import express from 'express'

/* ---------- 把 ../db.js 换成内存假库 ---------- */
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export const pool = null
  export async function query(sql, params) { return globalThis.__fakeDb.query(sql, params) }
  export async function queryOne(sql, params) { return globalThis.__fakeDb.queryOne(sql, params) }
  export async function ping() { return true }
  export async function withTransaction(fn) { return fn({ query: (s, p) => globalThis.__fakeDb.query(s, p) }) }
`)
register('data:text/javascript,' + encodeURIComponent(`
  const STUB = ${JSON.stringify(JSON.stringify(STUB))}
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('db.js')) return { url: JSON.parse(STUB), shortCircuit: true }
    return nextResolve(specifier, context)
  }
`))

const users = []
globalThis.__fakeDb = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('INSERT INTO users')) {
      const cols = s.slice(s.indexOf('(') + 1, s.indexOf(')')).split(',').map((c) => c.trim())
      const row = {}
      cols.forEach((c, i) => (row[c] = params[i]))
      if (users.some((u) => u.email === row.email) || (row.weibo_uid && users.some((u) => u.weibo_uid === row.weibo_uid))) {
        const e = new Error('Duplicate entry')
        e.code = 'ER_DUP_ENTRY'
        throw e
      }
      users.push(row)
      return { affectedRows: 1 }
    }
    if (s.startsWith('UPDATE users SET weibo_uid')) {
      const u = users.find((x) => x.id === params[1])
      if (u) u.weibo_uid = params[0]
      return { affectedRows: u ? 1 : 0 }
    }
    // favorites / recents：这个自检不关心，一律空
    return []
  },
  async queryOne(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.includes('WHERE weibo_uid = ?')) return users.find((u) => u.weibo_uid === params[0]) ?? null
    if (s.includes('WHERE email = ?')) return users.find((u) => u.email === params[0]) ?? null
    if (s.includes('WHERE id = ?')) return users.find((u) => u.id === params[0]) ?? null
    return null
  },
}

/* ---------- 把 fetch 换成假的微博 ---------- */
const realFetch = globalThis.fetch
/** 每个用例自己决定微博这次怎么答 */
let weibo = {}
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith('https://api.weibo.com/oauth2/access_token')) {
    lastTokenBody = String(init?.body ?? '')
    const r = weibo.token ?? { status: 200, body: JSON.stringify({ access_token: 'AT', uid: '1234567890' }) }
    return new Response(r.body, { status: r.status })
  }
  if (u.startsWith('https://api.weibo.com/2/users/show.json')) {
    const r = weibo.show ?? { status: 200, body: JSON.stringify({ screen_name: '小明' }) }
    return new Response(r.body, { status: r.status })
  }
  return realFetch(url, init)
}
let lastTokenBody = ''

/* ---------- 起服务 ---------- */
process.env.JWT_SECRET = 'test-secret'
process.env.PUBLIC_SITE_URL = 'https://8bitgo.com'
process.env.WEIBO_APP_KEY = '1234567'
process.env.WEIBO_APP_SECRET = 'topsecret'
delete process.env.WEIBO_REDIRECT_URI

const { authRouter } = await import('../src/routes/auth.js')
const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const ok = []
const bad = []
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' — ' + extra : ''}`)

const get = async (p) => {
  const r = await realFetch(base + p)
  return { status: r.status, data: await r.json().catch(() => null) }
}
const post = async (p, body) => {
  const r = await realFetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

/* ---------- 1. 授权地址 ---------- */
{
  const r = await get('/api/auth/weibo/authorize-url?state=abc123')
  const u = new URL(r.data?.url ?? 'http://x/')
  check('授权地址 200', r.status === 200, String(r.status))
  check('指向微博授权页', u.origin + u.pathname === 'https://api.weibo.com/oauth2/authorize', u.href)
  check('带上 client_id', u.searchParams.get('client_id') === '1234567')
  check('response_type=code', u.searchParams.get('response_type') === 'code')
  check('state 原样透传', u.searchParams.get('state') === 'abc123')
  check(
    'redirect_uri 由 PUBLIC_SITE_URL 推出',
    u.searchParams.get('redirect_uri') === 'https://8bitgo.com/auth/weibo/callback',
    String(u.searchParams.get('redirect_uri')),
  )
  // 这条最要紧：secret 一旦出现在给浏览器的地址里，等于公开了
  check('授权地址里没有 App Secret', !r.data?.url?.includes('topsecret'), r.data?.url)
}

/* ---------- 2. 没配就 503，不去打微博 ---------- */
{
  const saved = process.env.WEIBO_APP_SECRET
  delete process.env.WEIBO_APP_SECRET
  const a = await get('/api/auth/weibo/authorize-url')
  const b = await post('/api/auth/weibo', { code: 'x' })
  check('没配 secret：授权地址 503', a.status === 503, String(a.status))
  check('没配 secret：换 token 也 503', b.status === 503, String(b.status))
  process.env.WEIBO_APP_SECRET = saved
}

/* ---------- 3. 参数与微博侧的各种失败 ---------- */
{
  const r = await post('/api/auth/weibo', {})
  check('缺 code 是 400', r.status === 400, String(r.status))
}
{
  weibo = { token: { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_code: 21325 }) } }
  const r = await post('/api/auth/weibo', { code: 'bad' })
  check('微博拒绝授权码 → 401', r.status === 401, String(r.status))
}
{
  // 限流 / 网关故障时微博会吐 HTML。JSON.parse 抛出来的话这里会是 500
  weibo = { token: { status: 502, body: '<html><body>502 Bad Gateway</body></html>' } }
  const r = await post('/api/auth/weibo', { code: 'bad' })
  check('微博吐 HTML → 401 而不是 500', r.status === 401, String(r.status))
}

/* ---------- 4. 正常登录 ---------- */
let firstId = null
{
  weibo = {}
  const r = await post('/api/auth/weibo', { code: 'good' })
  firstId = r.data?.user?.id ?? null
  check('登录成功', r.status === 200, JSON.stringify(r.data))
  check('返回了 JWT', typeof r.data?.token === 'string' && r.data.token.length > 20)
  check('昵称取自 screen_name', r.data?.user?.nickname === '小明', String(r.data?.user?.nickname))
  check('占位邮箱用 .invalid 域', r.data?.user?.email === 'weibo_1234567890@weibo.invalid', String(r.data?.user?.email))
  check('库里记下了 weibo_uid', users[0]?.weibo_uid === '1234567890', String(users[0]?.weibo_uid))
  // 换 token 必须是服务端拿 secret 发的 POST
  check('换 token 时带上了 App Secret', lastTokenBody.includes('client_secret=topsecret'), lastTokenBody)
  check('换 token 时带上了 redirect_uri', lastTokenBody.includes('redirect_uri=https%3A%2F%2F8bitgo.com%2Fauth%2Fweibo%2Fcallback'), lastTokenBody)
  check('grant_type 是授权码', lastTokenBody.includes('grant_type=authorization_code'))
}

/* ---------- 5. 再登一次还是同一个人 ---------- */
{
  const r = await post('/api/auth/weibo', { code: 'good-again' })
  check('第二次登录仍是同一个账号', r.data?.user?.id === firstId, `${firstId} vs ${r.data?.user?.id}`)
  check('没有多建账号', users.length === 1, String(users.length))
}

/* ---------- 6. 换绑真实邮箱之后，微博登录还认得他 ---------- */
{
  users[0].email = 'real@example.com'
  const r = await post('/api/auth/weibo', { code: 'after-rebind' })
  check('换绑邮箱后仍进同一个号', r.data?.user?.id === firstId, String(r.data?.user?.id))
  check('换绑邮箱后没再建号', users.length === 1, String(users.length))
  users[0].email = 'weibo_1234567890@weibo.invalid'
}

/* ---------- 7. 取昵称失败不该挡住登录 ---------- */
{
  users.length = 0
  weibo = { show: { status: 403, body: JSON.stringify({ error: 'need permission' }) } }
  const r = await post('/api/auth/weibo', { code: 'good' })
  check('users/show 失败仍能登录', r.status === 200, String(r.status))
  check('昵称退回「微博用户 xxxx」', r.data?.user?.nickname === '微博用户7890', String(r.data?.user?.nickname))
}

/* ---------- 8. 封禁账号 ---------- */
{
  users[0].status = 'banned'
  const r = await post('/api/auth/weibo', { code: 'good' })
  check('封禁账号被挡住', r.status === 403, String(r.status))
}

server.close()

console.log('\n通过：')
for (const x of ok) console.log('  ✅ ' + x)
if (bad.length) {
  console.log('\n失败：')
  for (const x of bad) console.log('  ❌ ' + x)
}
console.log(`\n${ok.length} 通过 / ${bad.length} 失败`)
process.exit(bad.length ? 1 : 0)
