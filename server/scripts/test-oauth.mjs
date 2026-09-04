/**
 * Microsoft / Apple 登录的自检。不连数据库、不连微软和苹果：
 * db.js 换成内存假库，fetch 换成假的 token 端点 + 假 JWKS，
 * id_token 用**真的密钥现签**，所以验签那条路是真的在跑。
 *
 * 用法：cd server && npm run test:oauth
 *
 * 盯的是几件「上线才会发现、发现时已经出事」的：
 *   1. 没配就干脆 503，不拿空 client_id 去打人家接口；
 *   2. client secret 不出现在任何发给浏览器的地址里；
 *   3. 验签是真的验：换把钥匙签的 id_token 必须被拒；
 *   4. nonce / aud 对不上必须被拒（挡重放和「拿别家应用的 token 来登」）；
 *   5. **企业租户没有 xms_edov 时必须拒登** —— 本站按邮箱合并账号，
 *      而 Entra 管理员能把用户邮箱填成别人的，这一条是防冒领的唯一屏障；
 *   6. Apple 的 form_post 能收、名字只在首次授权时给、隐藏邮箱能登。
 */
import { register } from 'node:module'
import crypto from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'

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
      users.push(row)
      return { affectedRows: 1 }
    }
    return []
  },
  async queryOne(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.includes('WHERE email = ?')) return users.find((u) => u.email === params[0]) ?? null
    if (s.includes('WHERE id = ?')) return users.find((u) => u.id === params[0]) ?? null
    return null
  },
}

/* ---------- 真密钥：一把给「正主」，一把给「冒牌货」 ---------- */
function rsaKey(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } }
}
const MS_KEY = rsaKey('ms-1')
const APPLE_KEY = rsaKey('apple-1')
const EVIL_KEY = rsaKey('ms-1') // 同一个 kid，不同的钥匙 —— 冒名顶替的典型形状

/* Apple 的 client_secret 要用 EC 私钥签，这里给它一把真的 P-256 */
const applePem = crypto
  .generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })

/* ---------- 假的 token 端点 + 假 JWKS ---------- */
const realFetch = globalThis.fetch
/** 每个用例自己决定对方这次答什么 */
let plan = {}
let lastTokenBody = ''
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/discovery/v2.0/keys')) return new Response(JSON.stringify({ keys: [MS_KEY.jwk] }))
  if (u.includes('appleid.apple.com/auth/keys')) return new Response(JSON.stringify({ keys: [APPLE_KEY.jwk] }))
  if (u.includes('/oauth2/v2.0/token') || u.includes('appleid.apple.com/auth/token')) {
    lastTokenBody = String(init?.body ?? '')
    if (plan.tokenStatus) return new Response(plan.tokenBody ?? '{}', { status: plan.tokenStatus })
    return new Response(JSON.stringify({ id_token: plan.idToken ?? '' }))
  }
  return realFetch(url, init)
}

/* ---------- 起服务 ---------- */
process.env.JWT_SECRET = 'test-secret'
process.env.PUBLIC_SITE_URL = 'https://8bitgo.com'
process.env.MICROSOFT_CLIENT_ID = 'ms-client-id'
process.env.MICROSOFT_CLIENT_SECRET = 'ms-super-secret'
process.env.MICROSOFT_TENANT = 'common'
process.env.APPLE_SERVICES_ID = 'com.8bitgo.web'
process.env.APPLE_TEAM_ID = 'TEAM123456'
process.env.APPLE_KEY_ID = 'KEY1234567'
process.env.APPLE_PRIVATE_KEY = applePem.replace(/\n/g, '\\n')
delete process.env.OAUTH_REDIRECT_BASE

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

const CONSUMER_TID = '9188040d-6c67-4c5b-b112-36a304b66dad'

/** 走一遍 /start，把对方本该收到的授权参数解出来 */
async function start(provider, cst = 'cst-abc') {
  const r = await realFetch(`${base}/api/auth/oauth/${provider}/start?cst=${cst}`, { redirect: 'manual' })
  const loc = r.headers.get('location')
  return { status: r.status, loc, url: loc ? new URL(loc) : null, body: r.status >= 400 ? await r.json().catch(() => null) : null }
}
/** 回调：Microsoft 走 GET+query，Apple 走 POST+form */
async function callback(provider, params, method = 'GET') {
  const r =
    method === 'POST'
      ? await realFetch(`${base}/api/auth/oauth/${provider}/callback`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
          redirect: 'manual',
        })
      : await realFetch(`${base}/api/auth/oauth/${provider}/callback?${new URLSearchParams(params)}`, {
          redirect: 'manual',
        })
  const loc = r.headers.get('location') || ''
  const hash = new URLSearchParams(loc.includes('#') ? loc.slice(loc.indexOf('#') + 1) : '')
  return { status: r.status, loc, error: hash.get('error'), token: hash.get('token'), cst: hash.get('cst') }
}
const signMs = (claims, key = MS_KEY) =>
  jwt.sign({ aud: 'ms-client-id', iss: 'https://login.microsoftonline.com/x/v2.0', ...claims }, key.privateKey,
    { algorithm: 'RS256', keyid: key.kid, expiresIn: '5m' })
const signApple = (claims, key = APPLE_KEY) =>
  jwt.sign({ aud: 'com.8bitgo.web', iss: 'https://appleid.apple.com', ...claims }, key.privateKey,
    { algorithm: 'RS256', keyid: key.kid, expiresIn: '5m' })

/* ---------- 1. 授权地址 ---------- */
{
  const r = await start('microsoft')
  check('/start 是 302', r.status === 302, String(r.status))
  check('指向微软授权端点',
    r.url && r.url.origin + r.url.pathname === 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', r.loc)
  check('client_id 正确', r.url?.searchParams.get('client_id') === 'ms-client-id')
  check('scope 含 openid/email', (r.url?.searchParams.get('scope') || '').includes('openid'))
  check('response_mode=query', r.url?.searchParams.get('response_mode') === 'query')
  check('redirect_uri 指向后端回调',
    r.url?.searchParams.get('redirect_uri') === 'https://8bitgo.com/api/auth/oauth/microsoft/callback',
    String(r.url?.searchParams.get('redirect_uri')))
  check('带了 nonce', (r.url?.searchParams.get('nonce') || '').length >= 16)
  // 最要紧的一条：secret 出现在给浏览器的地址里就等于公开了
  check('授权地址里没有 client secret', !r.loc.includes('ms-super-secret'))

  const a = await start('apple')
  check('Apple 用 form_post', a.url?.searchParams.get('response_mode') === 'form_post', String(a.url?.searchParams.get('response_mode')))
  check('Apple client_id 是 Services ID', a.url?.searchParams.get('client_id') === 'com.8bitgo.web')
  check('Apple redirect_uri 正确',
    a.url?.searchParams.get('redirect_uri') === 'https://8bitgo.com/api/auth/oauth/apple/callback')
}

/* ---------- 2. 没配就 503 ---------- */
{
  const saved = process.env.MICROSOFT_CLIENT_SECRET
  delete process.env.MICROSOFT_CLIENT_SECRET
  const r = await start('microsoft')
  check('没配 secret：/start 503', r.status === 503, String(r.status))
  process.env.MICROSOFT_CLIENT_SECRET = saved
  const u = await start('nosuch')
  check('未知的登录方式 404', u.status === 404, String(u.status))
}

/* ---------- 3. state：CSRF 的第一道 ---------- */
{
  check('没有 state → error=state', (await callback('microsoft', { code: 'x' })).error === 'state')
  check('伪造 state → error=state', (await callback('microsoft', { code: 'x', state: 'forged' })).error === 'state')
  // 拿 apple 的 state 去打 microsoft 的回调
  const a = await start('apple')
  const stolen = a.url.searchParams.get('state')
  check('串用别家的 state → error=state', (await callback('microsoft', { code: 'x', state: stolen })).error === 'state')
}

/* ---------- 4. Microsoft：个人账号（MSA） ---------- */
let personalToken = null
{
  const r = await start('microsoft', 'cst-1')
  const state = r.url.searchParams.get('state')
  const nonce = r.url.searchParams.get('nonce')
  plan = { idToken: signMs({ nonce, tid: CONSUMER_TID, email: 'Alice@Outlook.com', name: '爱丽丝' }) }
  const c = await callback('microsoft', { code: 'good', state })
  personalToken = c.token
  check('个人 Microsoft 账号登录成功', c.error === null && Boolean(c.token), String(c.error))
  check('cst 原样带回前端', c.cst === 'cst-1', String(c.cst))
  check('落地页是 /auth/callback', c.loc.startsWith('https://8bitgo.com/auth/callback#'), c.loc.split('#')[0])
  check('邮箱统一转小写', users[0]?.email === 'alice@outlook.com', String(users[0]?.email))
  check('昵称取自 name', users[0]?.nickname === '爱丽丝', String(users[0]?.nickname))
  check('换 token 时带了 client secret', lastTokenBody.includes('client_secret=ms-super-secret'))
  check('换 token 时带了 redirect_uri',
    lastTokenBody.includes('redirect_uri=https%3A%2F%2F8bitgo.com%2Fapi%2Fauth%2Foauth%2Fmicrosoft%2Fcallback'))
}

/* ---------- 5. Microsoft：企业租户 —— 冒领账号的那条路 ---------- */
{
  const r = await start('microsoft', 'cst-2')
  const state = r.url.searchParams.get('state')
  const nonce = r.url.searchParams.get('nonce')
  // 恶意租户把用户邮箱填成受害者的地址，且没有 xms_edov
  plan = { idToken: signMs({ nonce, tid: 'evil-tenant-id', email: 'alice@outlook.com', name: 'Mallory' }) }
  const c = await callback('microsoft', { code: 'good', state })
  check('企业租户缺 xms_edov → 拒登（防冒领）', c.error === 'unverified', String(c.error))
  check('被拒时没有签发令牌', !c.token)
  check('被拒时没有动已有账号', users.length === 1 && users[0].nickname === '爱丽丝')
}
{
  const r = await start('microsoft', 'cst-3')
  const state = r.url.searchParams.get('state')
  const nonce = r.url.searchParams.get('nonce')
  plan = { idToken: signMs({ nonce, tid: 'good-tenant', xms_edov: true, email: 'bob@contoso.com', name: 'Bob' }) }
  const c = await callback('microsoft', { code: 'good', state })
  check('企业租户带 xms_edov=true → 放行', c.error === null && Boolean(c.token), String(c.error))
  check('新建了企业账号', users.length === 2 && users[1].email === 'bob@contoso.com')
}

/* ---------- 6. 验签 / nonce / aud ---------- */
{
  const mk = async (claims, key) => {
    const r = await start('microsoft')
    const state = r.url.searchParams.get('state')
    const nonce = r.url.searchParams.get('nonce')
    plan = { idToken: signMs({ nonce, tid: CONSUMER_TID, email: 'x@outlook.com', ...claims }, key) }
    return callback('microsoft', { code: 'good', state })
  }
  check('换把钥匙签的 id_token → 拒', (await mk({}, EVIL_KEY)).error === 'token')
  check('nonce 对不上 → 拒', (await mk({ nonce: 'not-the-one' })).error === 'token')
  check('aud 是别家应用 → 拒', (await mk({ aud: 'someone-else' })).error === 'token')
  const r = await start('microsoft')
  plan = { tokenStatus: 502, tokenBody: '<html>502 Bad Gateway</html>' }
  const c = await callback('microsoft', { code: 'good', state: r.url.searchParams.get('state') })
  check('对方吐 HTML → error=token 而不是 500', c.status === 302 && c.error === 'token', `${c.status}/${c.error}`)
  plan = {}
}

/* ---------- 7. Apple：form_post、首次授权的名字、隐藏邮箱 ---------- */
{
  const a = await start('apple', 'cst-a')
  const state = a.url.searchParams.get('state')
  const nonce = a.url.searchParams.get('nonce')
  plan = { idToken: signApple({ nonce, email: 'abc123@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' }) }
  const c = await callback('apple', {
    code: 'good', state,
    user: JSON.stringify({ name: { firstName: 'Tim', lastName: 'C' }, email: 'abc123@privaterelay.appleid.com' }),
  }, 'POST')
  check('Apple form_post 回调登录成功', c.error === null && Boolean(c.token), String(c.error))
  check('隐藏邮箱（私人转发）可以当账号', users.some((u) => u.email === 'abc123@privaterelay.appleid.com'))
  check('首次授权的名字用上了', users.find((u) => u.email.includes('privaterelay'))?.nickname === 'Tim C',
    String(users.find((u) => u.email.includes('privaterelay'))?.nickname))
  // client_secret 必须是用 .p8 现签的 ES256 JWT
  const secret = new URLSearchParams(lastTokenBody).get('client_secret')
  const dec = jwt.decode(secret, { complete: true })
  check('Apple client_secret 是 ES256 JWT', dec?.header?.alg === 'ES256', String(dec?.header?.alg))
  check('client_secret 的 kid = APPLE_KEY_ID', dec?.header?.kid === 'KEY1234567')
  check('client_secret 的 iss = Team ID', dec?.payload?.iss === 'TEAM123456')
  check('client_secret 的 sub = Services ID', dec?.payload?.sub === 'com.8bitgo.web')
  check('client_secret 的 aud = appleid.apple.com', dec?.payload?.aud === 'https://appleid.apple.com')
}
{
  const a = await start('apple', 'cst-b')
  const state = a.url.searchParams.get('state')
  const nonce = a.url.searchParams.get('nonce')
  plan = { idToken: signApple({ nonce, email: 'zzz@icloud.com', email_verified: false }) }
  const c = await callback('apple', { code: 'good', state }, 'POST')
  check('Apple 邮箱未验证 → 拒', c.error === 'unverified', String(c.error))
}

/* ---------- 8. 取消 / 封禁 ---------- */
{
  const r = await start('microsoft', 'cst-x')
  const c = await callback('microsoft', { error: 'access_denied', state: r.url.searchParams.get('state') })
  check('用户点了取消 → error=denied', c.error === 'denied', String(c.error))
  check('取消时也把 cst 带回去', c.cst === 'cst-x')
}
{
  users[0].status = 'banned'
  const r = await start('microsoft')
  const state = r.url.searchParams.get('state')
  const nonce = r.url.searchParams.get('nonce')
  plan = { idToken: signMs({ nonce, tid: CONSUMER_TID, email: 'alice@outlook.com' }) }
  const c = await callback('microsoft', { code: 'good', state })
  check('封禁账号被挡住', c.error === 'banned', String(c.error))
  users[0].status = 'active'
}

/* ---------- 9. 签出来的确实是本站可用的 JWT ---------- */
{
  const payload = jwt.verify(personalToken, 'test-secret')
  check('回传的是本站 JWT，uid 指向刚建的账号', payload.uid === users[0].id, String(payload.uid))
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
