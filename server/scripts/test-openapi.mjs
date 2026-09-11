/**
 * 开放平台（`/api/open/v1/*`）的自检。**真的起一个 express、真的签真的验**：
 * db.js 换成内存假库，RSA 密钥当场生成，路由挂的是真的 `routes/open.js`。
 *
 * 用法：cd server && npm run test:openapi
 *
 * 盯的是几件「上线才会发现、发现时已经出事」的事：
 *
 *   1. **两种令牌必须互不相认** —— 这是整套东西唯一一个「错一次全盘皆输」的点。
 *      两个方向都要断言：站内 JWT 进不了开放接口，开放令牌也进不了 requireUser。
 *   2. **对外响应里不能出现内部字段** —— 尤其是 ROM / 封面的对象 key 原文。
 *      漏一个，前面那一整套签名凭据就全白做了。
 *   3. **scope 不静默降级** —— 少给一个却照发令牌，接入方要到线上功能失效才发现。
 *   4. **ROM 凭据会过期、绑 app、改一个字节就失效**。
 *   5. **多语言回退链和站内一模一样** —— 两边漂了的话，同一款游戏在 8bitgo.com
 *      和在接入方站点上会显示不同的简介，而且没人会想到去比对。
 */
import { register } from 'node:module'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import express from 'express'

/* ---------- ../db.js -> 内存假库 ---------- */
const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export const pool = null
  export async function query(sql, params) { return globalThis.__fakeDb.query(sql, params) }
  export async function queryOne(sql, params) { return globalThis.__fakeDb.queryOne(sql, params) }
  export async function ping() { return true }
  export async function withTransaction(fn) { return fn({ query: (s, p) => globalThis.__fakeDb.query(s, p) }) }
  export function jsonMemberPath(name) { return name }
`)
register('data:text/javascript,' + encodeURIComponent(`
  const STUB = ${JSON.stringify(JSON.stringify(STUB))}
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/db.js') || specifier === '../db.js' || specifier === './db.js') {
      return { url: JSON.parse(STUB), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
`))

/* ---------- 假数据 ---------- */
const GAME = {
  id: 1,
  slug: 'contra',
  title: 'Contra',
  title_zh: '魂斗罗',
  title_i18n: { 'zh-Hant': '魂斗羅' },
  platform: 'nes',
  year: 1987,
  developer: 'Konami',
  players: 2,
  multiplayer: 1,
  icon: '🎮',
  cover: 'covers/contra.jpg',
  description: '两个兵扫外星人。',
  description_en: 'Two commandos versus aliens.',
  description_i18n: { ja: 'エイリアンと戦う。' },
  rating_sum: 45,
  rating_weight: 10,
  rating_count: 9,
  plays: 120,
  added_at: '1987-02-20',
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-02-01 00:00:00',
  adult: 0,
  hidden: 0,
  // 这几个是内部字段，一个都不能出现在对外响应里
  core: 'fceumm',
  arcade_romdata: '{"pack":"x"}',
  dos_executable: 'A.EXE',
  coin_reward: 5,
  home_rank: 1,
  body_control: 0,
  video: 'videos/contra.mp4',
}
const HIDDEN_GAME = { ...GAME, id: 2, slug: 'secret-game', hidden: 1 }
/** 只有日文版、没有通用件的游戏。用来验「ROM 不做跨语言回退」 */
const JA_ONLY = { ...GAME, id: 3, slug: 'ja-only' }
const ALL_GAMES = [GAME, HIDDEN_GAME, JA_ONLY]
const ROMS = [
  { game_id: 1, lang: '*', object_key: 'roms/contra.zip' },
  { game_id: 1, lang: 'ja', object_key: 'roms/contra-ja.zip' },
  { game_id: 3, lang: 'ja', object_key: 'roms/ja-only.zip' },
]

const APP = {
  id: 'app_0123456789abcdef01234567',
  name: '测试应用',
  client_type: 'confidential',
  status: 'live',
  approved_scopes: 'games.read games.rom',
  rate_tier: 'live',
  embed_origins: '["https://partner.example"]',
}
/**
 * 第二个应用：**已获批的里面混着用户级 scope**（`openid profile`）。
 * 这是最常见的形态 —— 一个既做登录又展示游戏库的应用。
 * 它用来验两件在单应用下测不出来的事：
 *   · 申请一个「应用级但没获批」的 scope（games.rom）要报错，不能静默降级；
 *   · 已获批的**用户级** scope 也不能用 client_credentials 取（背后没有用户）。
 */
const APP2 = {
  id: 'app_111111111111111111111111',
  name: '只批了 games.read 的应用',
  client_type: 'confidential',
  status: 'live',
  approved_scopes: 'openid profile games.read',
  rate_tier: 'sandbox',
  embed_origins: '[]',
}
const APP_SECRET = 'test-secret-value'
let SECRET_HASH = ''

globalThis.__fakeDb = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('SELECT id, name, client_type')) {
      return [APP, APP2].filter((a) => a.id === params[0])
    }
    if (s.startsWith('SELECT id, secret_hash FROM oauth_app_secrets')) {
      return [APP.id, APP2.id].includes(params[0]) ? [{ id: 's1', secret_hash: SECRET_HASH }] : []
    }
    if (s.startsWith('UPDATE oauth_app_secrets')) return []
    /*
      ⚠️ 假库必须**照着 SQL 说的做**，不能自己替被测代码把 hidden / adult 过滤掉 ——
      那样的话，路由里的 `AND hidden = 0` 被人删了，测试照样绿（变异检查里实测过）。
      假库替被测代码做事，是假库最常见的一种错法。
    */
    if (s.startsWith('SELECT * FROM games WHERE slug IN')) {
      let rows = ALL_GAMES.filter((g) => params.includes(g.slug))
      if (s.includes('hidden = 0')) rows = rows.filter((g) => !g.hidden)
      if (s.includes('adult = 0')) rows = rows.filter((g) => !g.adult)
      return rows
    }
    if (s.startsWith('SELECT * FROM games WHERE slug = ?')) {
      let rows = ALL_GAMES.filter((g) => g.slug === params[0])
      if (s.includes('hidden = 0')) rows = rows.filter((g) => !g.hidden)
      if (s.includes('adult = 0')) rows = rows.filter((g) => !g.adult)
      return rows
    }
    if (s.startsWith('SELECT g.* FROM games')) return [GAME]
    if (s.startsWith('SELECT COUNT')) return [{ n: 1 }]
    if (s.startsWith('SELECT game_id, genre_id')) return [{ game_id: 1, genre_id: 'action' }]
    if (s.startsWith('SELECT game_id, tag')) return [{ game_id: 1, tag: '经典' }]
    if (s.startsWith('SELECT game_id, lang, object_key')) return ROMS
    return []
  },
  async queryOne(sql, params) {
    const rows = await this.query(sql, params)
    return rows[0]
  },
}

/* ---------- 真密钥 ---------- */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
process.env.OPEN_JWT_PRIVATE_KEY = privateKey
process.env.OPEN_JWT_KID = 'test-1'
process.env.OPEN_ISSUER = 'https://8bitgo.com'
process.env.OPEN_ROM_SECRET = 'rom-secret'
process.env.OPEN_EMBED_SECRET = 'embed-secret'
process.env.JWT_SECRET = 'site-secret-totally-different'
process.env.PUBLIC_SITE_URL = 'https://8bitgo.com'
process.env.ROM_BASE_URL = 'https://assets.8bitgo.com'

const { openRouter } = await import('../src/routes/open.js')
const { hashSecret } = await import('../src/open/apps.js')
const { verifyToken } = await import('../src/auth.js')
const { issueAppToken, verifyOpenToken } = await import('../src/open/tokens.js')
const { signToken } = await import('../src/auth.js')
const { FORBIDDEN_OUT_KEYS } = await import('../src/open/mapper.js')
const { isOpenPath, openErrorFor, openErrorMiddleware } = await import('../src/open/errors.js')
const { pickDescription, pickTitle } = await import('../src/open/i18n.js')
const jwtLib = (await import('jsonwebtoken')).default
SECRET_HASH = await hashSecret(APP_SECRET)

const app = express()
app.use(express.json())
app.use('/api/open', openRouter)
/*
  ⚠️ 挂的是**和 index.js 同一个函数**，不是照着抄一份。

  请求体解析失败的错误**到不了路由** —— express.json 挂在全局，畸形 JSON 在进
  openRouter 之前就 next(err) 了。所以「开放平台的错误体永远是 OAuth 形状」这句话
  要靠这道守卫才成立。挂同一个函数意味着函数体里的任何改动这里都会真的跑到；
  index.js 那边只剩「挂了没有、排在第几位」两件事，靠下面那条源码断言守。
  （抄一份的写法试过：那样连 index.js 整个删掉守卫都测不出来。）
*/
app.use(openErrorMiddleware(() => 'https://8bitgo.com'))
// 站内那半：形状和 index.js 的一样，用来确认「不是开放平台的请求原样放行」
app.use((err, _req, res, _next) => {
  res.status(Number(err?.status) || 500).json({ error: '请求格式不正确' })
})
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}
const api = (path, init) => fetch(`${base}${path}`, init)
/** 源码断言之前一律先剥注释 —— 注释里引用一段代码会让朴素的 grep 误判成「还在」 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const getToken = async (scope, appId = APP.id) => {
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: appId, client_secret: APP_SECRET, ...(scope ? { scope } : {}) }),
  })
  return r.json()
}

console.log('\n一、⚠️ 两种令牌必须互不相认（错一次全盘皆输）')

await check('站内 JWT 进不了开放接口', async () => {
  const site = signToken('u_abc', 0)
  const r = await api('/api/open/v1/me', { headers: { Authorization: `Bearer ${site}` } })
  assert.equal(r.status, 401, '站内登录令牌被开放接口接受了')
})

await check('开放平台令牌进不了站内 verifyToken', () => {
  const open = issueAppToken({ privateKey, kid: 'test-1', issuer: 'https://8bitgo.com', appId: APP.id, scopes: ['games.read'] })
  assert.equal(verifyToken(open), null, '开放平台令牌被站内 verifyToken 接受了')
})

await check('⚠️ 拿 JWT_SECRET 伪造的「开放令牌」也不认（算法白名单）', () => {
  const forged = jwtLib.sign({ cid: APP.id, aud: APP.id, kind: 'app', scope: 'games.rom' }, process.env.JWT_SECRET)
  assert.equal(verifyOpenToken(forged, { publicKey }), null)
})

await check('⚠️ 带 aud / scope / cid 的 HS256 令牌，站内也必须拒绝', () => {
  /*
    这一条是纵深防御，而且是**实测过会出事**的那一条：
    HS256 签的、payload 带 uid 的令牌，原来 verifyToken 会原样接受并取出 uid ——
    也就是说开放平台哪天复用了 JWT_SECRET，一枚「只读昵称」的第三方令牌
    立刻等价于完整账号令牌。
  */
  for (const extra of [{ aud: 'app_x' }, { scope: 'games.read' }, { cid: 'app_x' }]) {
    const t = jwtLib.sign({ uid: 'u_abc', tv: 0, ...extra }, process.env.JWT_SECRET)
    assert.equal(verifyToken(t), null, `带 ${Object.keys(extra)[0]} 的令牌被站内接受了`)
  }
  // 正常的站内令牌当然还要能过 —— 别把上面那条收紧成「谁都进不来」
  assert.ok(verifyToken(signToken('u_abc', 0))?.uid === 'u_abc')
})

await check('⚠️⚠️ 算法混淆：用**公钥**当 HMAC 密钥签的令牌必须被拒', async () => {
  /*
    这是 JWT 最经典的一个洞：验签时若把算法开成 ['RS256','HS256']，攻击者就能拿
    **公开的**公钥当 HMAC 密钥签一枚 HS256 令牌 —— 服务端用同一串 PEM 去验，验得过。
    公钥是公开的（JWKS 就挂在网上），所以这等于任何人都能签任意令牌。
    唯一的防线就是 algorithms 白名单里**只有 RS256**。
  */
  let confused = ''
  try {
    confused = jwtLib.sign({ cid: APP.id, aud: APP.id, kind: 'app', scope: 'games.rom' }, publicKey, {
      algorithm: 'HS256',
      header: { typ: 'at+jwt' },
    })
  } catch {
    // jsonwebtoken 9 自己就拒绝「拿非对称密钥当 HMAC 密钥」——很好，但那是**它**的行为
  }
  if (confused) assert.equal(verifyOpenToken(confused, { publicKey }), null, '算法混淆没被挡住')
  /*
    ⚠️ 上面那条现在**测不出差别**：jsonwebtoken 9 在签和验两侧都拒绝用非对称密钥做 HMAC，
    所以把 algorithms 开成 ['RS256','HS256'] 行为一模一样（变异检查里实测过）。
    但那是这个库当前版本的行为，不是我们的保证 —— 换个库、升个版本，白名单就是唯一防线。
    测不了行为就守源码，并把理由写在这儿。
  */
  // ⚠️ 断言前**先剥注释**：文件头那段说明里也写着 `algorithms: ['RS256']`，
  // 不剥的话，把代码里那一行改坏了这条也照样绿（变异检查里实测过，这个仓库以前踩过同一个坑）
  const src = stripComments((await import('node:fs')).readFileSync(new URL('../src/open/tokens.js', import.meta.url), 'utf8'))
  assert.match(src, /algorithms: \['RS256'\]/, '开放平台的验签必须把算法钉死成 RS256')
})

await check('⚠️ 没有 typ=at+jwt 的令牌不算 access token（哪怕是我们自己的私钥签的）', () => {
  // 同一把私钥将来还会签 id_token。不认 typ 的话，一枚 id_token 就能当 access token 用
  const noTyp = jwtLib.sign({ cid: APP.id, aud: APP.id, kind: 'app', scope: 'games.rom' }, privateKey, {
    algorithm: 'RS256',
  })
  assert.equal(verifyOpenToken(noTyp, { publicKey }), null)
})

await check('站内 verifyToken 把算法写死成 HS256（源码断言）', async () => {
  /*
    这一条**测不出行为**：JWT_SECRET 是字符串，jsonwebtoken 此时本来就只认 HS*，
    所以删掉 algorithms 的行为和留着一模一样。但那是它的**实现细节**，不是承诺 ——
    哪天密钥换成 KeyObject / PEM（比如有人想给站内令牌也换成 RS256），这一行就是
    算法混淆的唯一防线。测不了行为就守源码，并把理由写在这儿。
  */
  const src = stripComments((await import('node:fs')).readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8'))
  assert.match(src, /jwt\.verify\(token, JWT_SECRET, \{ algorithms: \['HS256'\] \}\)/)
})

console.log('\n二、AppID + key 换令牌')

await check('正确的 AppID + key 能换到令牌', async () => {
  const t = await getToken()
  assert.equal(t.token_type, 'Bearer')
  assert.ok(t.access_token)
  assert.equal(t.scope, 'games.read games.rom', '不传 scope 时给「已获批 ∩ 应用级」的全部')
})

await check('⚠️ key 不对和应用不存在，回的是同一句话（否则成了 AppID 探针）', async () => {
  const bad = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: APP.id, client_secret: 'wrong' }),
  })
  const none = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'app_ffffffffffffffffffffffff', client_secret: 'x' }),
  })
  assert.equal(bad.status, 401)
  assert.equal(none.status, 401)
  const [a, b] = [await bad.json(), await none.json()]
  assert.deepEqual(a, b, '两种失败的响应体不一样 —— 可以据此枚举 AppID')
})

await check('Basic 认证那种写法也要认（现成的 OAuth 库默认发这个）', async () => {
  const basic = Buffer.from(`${APP.id}:${APP_SECRET}`).toString('base64')
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  })
  assert.equal(r.status, 200)
})

await check('⚠️ scope 超出已获批范围 -> 报错，不静默降级', async () => {
  const t = await getToken('games.read saves.write')
  assert.equal(t.error, 'invalid_scope')
  assert.ok(!t.access_token, '发了一枚「少给一个 scope」的令牌 —— 接入方要到线上才发现')
})

await check('⚠️ 用户级 scope 不能用 client_credentials 取（背后没有用户）', async () => {
  const t = await getToken('profile')
  assert.equal(t.error, 'invalid_scope')
})

await check('⚠️ 应用级但**没获批**的 scope -> 报错，不静默降级', async () => {
  // APP2 只批了 games.read。申请 games.rom 必须整次失败，而不是「发一枚只有 games.read 的令牌」
  const t = await getToken('games.read games.rom', APP2.id)
  assert.equal(t.error, 'invalid_scope')
  assert.ok(!t.access_token, '静默降级了 —— 接入方要到线上 403 才发现自己没拿到权限')
})

await check('⚠️ 应用级令牌的两道闸都要在（任何一道单独都够，但别只剩一道）', async () => {
  /*
    两道是**故意重复**的：
      ① `approvedApp = approvedScopes ∩ APP_SCOPES` —— 已获批里先滤掉用户级的；
      ② 显式检查请求里有没有用户级 scope，有就报错。
    任何一道单独都能挡住，所以拆掉其中一道，行为测试是看不出来的（变异检查里实测过）。
    但它们防的是不同的写错方式，两道都该在 —— 这一条守的就是「别只剩一道」。
  */
  const src = stripComments((await import('node:fs')).readFileSync(new URL('../src/routes/open.js', import.meta.url), 'utf8'))
  assert.match(src, /approvedScopes\.filter\(\(s\) => APP_SCOPES\.includes\(s\)\)/, '第①道没了')
  assert.match(src, /需要用户授权，不能用 client_credentials 取/, '第②道没了')
})

await check('⚠️ 已获批的**用户级** scope 也不能用 client_credentials 取', async () => {
  /*
    APP2 的 approved_scopes 里有 openid / profile（它同时也做登录）。
    如果这里放行，一枚「背后没有用户」的应用级令牌就带上了 profile ——
    拿它去调用户接口时，`sub` 是 client_id，那是一个不存在的用户。
  */
  const t = await getToken('profile', APP2.id)
  assert.equal(t.error, 'invalid_scope')
  assert.ok(!t.access_token)
})

await check('不传 scope 时也只给应用级的那部分', async () => {
  const t = await getToken(undefined, APP2.id)
  assert.equal(t.scope, 'games.read', 'openid / profile 不该出现在应用级令牌里')
})

await check('只支持 client_credentials，别的 grant 明确报错', async () => {
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', client_id: APP.id, client_secret: APP_SECRET }),
  })
  assert.equal((await r.json()).error, 'unsupported_grant_type')
})

console.log('\n三、游戏元数据：白名单 + 多语言')

await check('⚠️ 对外响应里不能出现任何内部字段', async () => {
  const { access_token } = await getToken('games.read')
  const r = await api('/api/open/v1/games/contra?lang=en', { headers: { Authorization: `Bearer ${access_token}` } })
  const g = await r.json()
  const leaked = FORBIDDEN_OUT_KEYS.filter((k) => k in g)
  assert.deepEqual(leaked, [], `漏了内部字段：${leaked.join(', ')}`)
  // ROM / 封面的对象 key 原文尤其致命：给了就等于绕过整套凭据
  const blob = JSON.stringify(g)
  assert.ok(!blob.includes('roms/contra'), 'ROM 的对象 key 原文出现在响应里')
  assert.ok(!blob.includes('"covers/'), '封面给的应该是绝对地址，不是对象 key')
  assert.equal(g.cover, 'https://assets.8bitgo.com/covers/contra.jpg')
})

await check('ROM 语言只报语言码，不报 key', async () => {
  const { access_token } = await getToken('games.read')
  const g = await (await api('/api/open/v1/games/contra', { headers: { Authorization: `Bearer ${access_token}` } })).json()
  assert.deepEqual(g.rom_langs, ['*', 'ja'])
})

await check('⚠️ 多语言按 lang 返回，并告诉接入方这一门实际是什么', async () => {
  const { access_token } = await getToken('games.read')
  const get = async (lang) =>
    (await api(`/api/open/v1/games/contra?lang=${lang}`, { headers: { Authorization: `Bearer ${access_token}` } })).json()
  const zhHant = await get('zh-Hant')
  assert.equal(zhHant.title, '魂斗羅')
  assert.equal(zhHant.lang_actual.title, 'zh-Hant')
  // 繁体没有简介译文 -> 退到中文，并**如实说明**退到了 zh-Hans
  assert.equal(zhHant.lang_actual.description, 'zh-Hans')
  const fr = await get('fr')
  assert.equal(fr.description, 'Two commandos versus aliens.', '没有法语译文时退到英文')
  assert.equal(fr.lang_actual.description, 'en')
  const ja = await get('ja')
  assert.equal(ja.lang_actual.description, 'ja')
})

await check('⚠️ 回退链必须和站内一模一样（漂了就两边显示不同的简介）', async () => {
  const { gameTitle, gameDescription } = await import('../../src/services/i18nData.ts')
  // 站内那两个函数吃的是 API 形状，这里把同一行数据翻过去
  const api1 = {
    title: GAME.title,
    titleZh: GAME.title_zh,
    titleI18n: GAME.title_i18n,
    description: GAME.description,
    descriptionEn: GAME.description_en,
    descriptionI18n: GAME.description_i18n,
  }
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'fr', 'de', 'es', 'it']) {
    assert.equal(pickTitle(GAME, lang).text, gameTitle(api1, lang), `${lang} 的标题两边不一致`)
    assert.equal(pickDescription(GAME, lang).text, gameDescription(api1, lang), `${lang} 的简介两边不一致`)
  }
})

await check('下架的游戏对外不存在（和「没这款」同一个 404）', async () => {
  const { access_token } = await getToken('games.read')
  const r = await api('/api/open/v1/games/secret-game', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(r.status, 404)
})

await check('没有令牌 / 令牌过期 -> 401', async () => {
  assert.equal((await api('/api/open/v1/games/contra')).status, 401)
  const expired = issueAppToken({
    privateKey, kid: 'test-1', issuer: 'https://8bitgo.com', appId: APP.id, scopes: ['games.read'],
    ttl: 60, now: Date.now() - 3600_000,
  })
  assert.equal((await api('/api/open/v1/games/contra', { headers: { Authorization: `Bearer ${expired}` } })).status, 401)
})

console.log('\n四、ROM：独立 scope + 短期凭据')

await check('⚠️ games.read 不附带 ROM 权限（那是两个量级的风险）', async () => {
  const { access_token } = await getToken('games.read')
  const r = await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'insufficient_scope')
})

await check('有 games.rom 才给凭据，且凭据里不含对象 key', async () => {
  const { access_token } = await getToken('games.rom')
  const r = await api('/api/open/v1/games/contra/rom?lang=ja', { headers: { Authorization: `Bearer ${access_token}` } })
  const body = await r.json()
  assert.equal(r.status, 200)
  assert.equal(body.lang_actual, 'ja')
  assert.ok(body.url.includes('/api/open/v1/rom/'))
  assert.ok(!body.url.includes('roms/contra'), '凭据地址里出现了对象 key')
  assert.ok(body.expires_in <= 900, 'ROM 凭据必须是分钟级的')
})

await check('ROM 语言不做跨语言回退（要日文没有就给通用件，不给别的语言）', async () => {
  const { access_token } = await getToken('games.rom')
  const r = await api('/api/open/v1/games/contra/rom?lang=de', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal((await r.json()).lang_actual, '*')
})

await check('⚠️ 下架的游戏也拿不到 ROM / 嵌入地址（这条路和详情页是两个查询）', async () => {
  // 详情那条走的是列表查询，ROM / embed 走的是 getRawGame —— 两处的 hidden 过滤要各测各的
  const { access_token } = await getToken('games.rom')
  const rom = await api('/api/open/v1/games/secret-game/rom', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(rom.status, 404, '下架的游戏还能要到 ROM 凭据')
  const { access_token: readTok } = await getToken('games.read')
  const embed = await api('/api/open/v1/games/secret-game/embed', { headers: { Authorization: `Bearer ${readTok}` } })
  assert.equal(embed.status, 404, '下架的游戏还能要到嵌入地址')
})

await check('⚠️ 没有通用件时，要日文以外的语言必须是 404（绝不给一份别的语言）', async () => {
  /*
    悄悄发一份别的语言的 ROM，玩家开进去是另一套文字，而接入方**无从得知** ——
    他要的是 de，我们回 200，他没有任何理由去怀疑。所以宁可 404。
  */
  const { access_token } = await getToken('games.rom')
  const r = await api('/api/open/v1/games/ja-only/rom?lang=de', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(r.status, 404)
  assert.equal((await r.json()).error, 'rom_unavailable')
  // 要日文当然给得了
  const ok = await api('/api/open/v1/games/ja-only/rom?lang=ja', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal((await ok.json()).lang_actual, 'ja')
})

await check('⚠️ 凭据被改过 / 过期 -> 兑现失败', async () => {
  const { signRomGrant, verifyRomGrant } = await import('../src/open/sign.js')
  const g = signRomGrant({ secret: 'rom-secret', appId: APP.id, slug: 'contra', lang: '*', key: 'roms/contra.zip' })
  assert.equal(verifyRomGrant(g, { secret: 'rom-secret' }).ok, true)
  // 换一个 app_id 重签 payload，但沿用原来的签名
  const [, sig] = g.split('.')
  const forged = Buffer.from(JSON.stringify({ a: 'app_other', s: 'contra', l: '*', k: 'roms/all.zip', e: 9e9 })).toString('base64url') + '.' + sig
  assert.equal(verifyRomGrant(forged, { secret: 'rom-secret' }).reason, 'bad_signature')
  assert.equal(verifyRomGrant(g, { secret: 'rom-secret', now: Date.now() + 3600_000 }).reason, 'expired')
  const r = await api(`/api/open/v1/rom/${forged}`, { redirect: 'manual' })
  assert.equal(r.status, 403)
})

await check('合法凭据 302 到资源地址，且不许被缓存', async () => {
  const { access_token } = await getToken('games.rom')
  const { url } = await (await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${access_token}` } })).json()
  const grant = url.split('/api/open/v1/rom/')[1]
  const r = await api(`/api/open/v1/rom/${grant}`, { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://assets.8bitgo.com/roms/contra.zip')
  assert.match(String(r.headers.get('cache-control')), /no-store/)
})

console.log('\n五、CORS 与自省')

await check('⚠️ 开放接口放开到任意 Origin', async () => {
  const r = await api('/api/open/v1/games/contra', { headers: { Origin: 'https://partner.example' } })
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  // 放开到 * 的接口一律不带 cookie（Bearer 走 header，天然没有 CSRF 面）
  assert.equal(r.headers.get('access-control-allow-credentials'), null)
})

await check('⚠️ 站内的 CORS 白名单没有跟着变松', async () => {
  /*
    这一条守的是「为了让开放接口能跨域，顺手把 ALLOWED_ORIGINS 改成 *」——
    那一改会把 /api/me、/api/admin 一起放开，而症状是零。
  */
  const src = stripComments((await import('node:fs')).readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))
  const cors = src.slice(src.indexOf('const origins ='), src.indexOf('app.use(express.json'))
  assert.ok(!/origin:\s*true\s*,?\s*\/\/\s*开放/.test(cors))
  assert.ok(
    src.includes("app.use('/api/open', openRouter)"),
    '开放平台要挂在自己的前缀下，别混进站内路由',
  )
})

await check('/v1/me 能自查令牌（接入方排错的第一站）', async () => {
  const { access_token } = await getToken('games.read')
  const me = await (await api('/api/open/v1/me', { headers: { Authorization: `Bearer ${access_token}` } })).json()
  assert.equal(me.client_id, APP.id)
  assert.equal(me.kind, 'app')
  assert.equal(me.scope, 'games.read')
})

console.log('\n六、token 端点的请求体：RFC 6749 要的是 form-encoded')

/*
  ## 这一节在守什么

  RFC 6749 §4.1.3 规定 token 端点收 `application/x-www-form-urlencoded`，
  而这个应用**全局只挂了 express.json**。补上之前，标准写法发过来 req.body 是空的、
  grant_type 读不到，回一句 `400 unsupported_grant_type` ——
  现成的 OAuth 客户端库默认就发 form-encoded，**一律接不上**，
  而那句错误里完全看不出真正的原因（它说「不支持这个 grant_type」，
  可调用方明明传了 client_credentials）。不抓包根本查不出来。

  所以下面四件事都要钉住：两种 content-type 都能取到令牌、两种取到的东西一样、
  解析失败回的是 OAuth 形状、以及 **urlencoded 没有被顺手挂到全局**。
*/

const form = (obj) => new URLSearchParams(obj).toString()
const FORM_CT = { 'Content-Type': 'application/x-www-form-urlencoded' }

await check('form-encoded（RFC 6749 的标准写法）能换到令牌', async () => {
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: FORM_CT,
    body: form({ grant_type: 'client_credentials', client_id: APP.id, client_secret: APP_SECRET }),
  })
  const t = await r.json()
  assert.equal(r.status, 200, `form-encoded 被拒了：${JSON.stringify(t)}`)
  assert.equal(t.token_type, 'Bearer')
  assert.ok(t.access_token)
})

await check('form-encoded + Basic 认证也认（OAuth 库最常见的组合）', async () => {
  const basic = Buffer.from(`${APP.id}:${APP_SECRET}`).toString('base64')
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { ...FORM_CT, Authorization: `Basic ${basic}` },
    body: form({ grant_type: 'client_credentials' }),
  })
  assert.equal(r.status, 200)
})

await check('两种写法取到的是同一个东西（scope 不能因为 content-type 而不同）', async () => {
  const viaForm = await (await api('/api/open/v1/token', {
    method: 'POST',
    headers: FORM_CT,
    body: form({ grant_type: 'client_credentials', client_id: APP.id, client_secret: APP_SECRET, scope: 'games.read' }),
  })).json()
  const viaJson = await getToken('games.read')
  assert.equal(viaForm.scope, viaJson.scope)
  assert.equal(viaForm.expires_in, viaJson.expires_in)
})

await check('form-encoded 里的 scope 一样不静默降级', async () => {
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: FORM_CT,
    body: form({ grant_type: 'client_credentials', client_id: APP.id, client_secret: APP_SECRET, scope: 'games.read saves.write' }),
  })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'invalid_scope')
})

await check('JSON 那条路没被弄坏', async () => {
  const t = await getToken()
  assert.ok(t.access_token, 'JSON 写法反而挂了 —— 加解析器时把上游 express.json 顶掉了')
})

await check('⚠️ 超限的表单体回 OAuth 形状，不是站内形状', async () => {
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: FORM_CT,
    body: form({ grant_type: 'client_credentials', client_id: APP.id, client_secret: 'x'.repeat(20_000) }),
  })
  assert.equal(r.status, 413)
  const body = await r.json()
  assert.equal(body.error, 'invalid_request', `回的是站内形状：${JSON.stringify(body)}`)
  assert.ok(body.error_description, 'OAuth 错误体必须带 error_description')
})

await check('⚠️ 畸形 JSON 也回 OAuth 形状（它在全局就失败了，到不了路由）', async () => {
  const r = await api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"grant_type":',
  })
  assert.ok(r.status >= 400 && r.status < 500, `畸形 JSON 回了 ${r.status}`)
  const body = await r.json()
  assert.equal(body.error, 'invalid_request', `回的是站内形状：${JSON.stringify(body)}`)
})

await check('⚠️ urlencoded 只挂在 token 这一条路由上，没有挂全局', async () => {
  /*
    挂全局的话，站内每一个 POST/PUT 都会接受表单体 —— 而跨域表单提交是
    不触发预检的「简单请求」，等于为了一个端点的兼容性平白多出一整个 CSRF 面。
  */
  const fs = (await import('node:fs')).default
  const index = stripComments(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))
  const open = stripComments(fs.readFileSync(new URL('../src/routes/open.js', import.meta.url), 'utf8'))
  assert.ok(!/app\.use\(\s*express\.urlencoded/.test(index), 'index.js 把 urlencoded 挂到全局了')
  assert.ok(/express\.urlencoded\(/.test(open), 'open.js 里没有 urlencoded 解析器')
  assert.ok(
    /openRouter\.post\('\/v1\/token', tokenBody,/.test(open),
    'token 路由上没有挂 tokenBody 解析器',
  )
})

await check('⚠️ index.js 挂了这道守卫，而且排在站内那个之前', async () => {
  /*
    上面那几条「回 OAuth 形状」的用例跑的是**本文件自己搭的 app**，
    证明的是那个函数好用。线上那个 app 有没有挂、挂在第几位，只能扫源码。

    排序是要紧的：站内那个错误处理会把 413 先截走，开放平台的请求就拿不到
    OAuth 形状了 —— 而这种错排不会有任何症状，直到某个接入方发来一张截图。
  */
  const fs = (await import('node:fs')).default
  const index = stripComments(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))
  const mine = index.indexOf('app.use(openErrorMiddleware(')
  const site = index.indexOf('app.use((err')
  assert.ok(mine > 0, 'index.js 没有挂 openErrorMiddleware')
  assert.ok(site > 0, '找不到站内的错误处理 —— 这条断言的前提没了，去看看 index.js 改成什么了')
  assert.ok(mine < site, '开放平台的守卫排在站内错误处理后面 —— 413 会先被站内形状截走')
})

await check('⚠️ 不是开放平台的请求，这道守卫原样放行（别把站内的错误也改了形状）', () => {
  const mw = openErrorMiddleware(() => 'https://8bitgo.com')
  let passed = null
  let responded = false
  const res = { status() { responded = true; return this }, json() { responded = true; return this } }
  mw(new Error('boom'), { originalUrl: '/api/me' }, res, (e) => { passed = e })
  assert.ok(passed instanceof Error, '站内请求的错误被开放平台的守卫吃掉了')
  assert.equal(responded, false, '守卫替站内请求回了响应')
})

await check('⚠️ 取站点地址抛异常也不能把错误处理本身搞挂', () => {
  const mw = openErrorMiddleware(() => { throw new Error('env 没配') })
  let status = 0
  let body = null
  mw({ status: 400 }, { originalUrl: '/api/open/v1/token' },
     { status(s) { status = s; return this }, json(b) { body = b; return this } },
     () => assert.fail('不该放行'))
  assert.equal(status, 400)
  assert.equal(body.error, 'invalid_request')
  assert.equal(body.error_uri, undefined, '取不到站点地址就不该带 error_uri')
})

console.log('\n七、错误体形状（open/errors.js，纯函数）')

await check('超限 -> 413 invalid_request', () => {
  const { status, body } = openErrorFor({ type: 'entity.too.large' }, 'https://8bitgo.com')
  assert.equal(status, 413)
  assert.equal(body.error, 'invalid_request')
  assert.equal(body.error_uri, 'https://8bitgo.com/developers/docs/errors#invalid_request')
})

await check('4xx 原样带过去，5xx 一律 server_error', () => {
  assert.equal(openErrorFor({ status: 400 }).status, 400)
  assert.equal(openErrorFor({ status: 415 }).body.error, 'invalid_request')
  assert.equal(openErrorFor(new Error('boom')).status, 500)
  assert.equal(openErrorFor(new Error('boom')).body.error, 'server_error')
})

await check('⚠️ 不把内部错误信息透出去', () => {
  const { body } = openErrorFor(new Error('/srv/8bitgo/server/src/db.js:42 ECONNREFUSED'))
  assert.ok(!JSON.stringify(body).includes('db.js'), '错误体里带上了内部路径')
  assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'))
})

await check('⚠️ 给不出站点地址就不带 error_uri（不编一个假的）', () => {
  assert.equal(openErrorFor({ status: 400 }).body.error_uri, undefined)
  assert.equal(openErrorFor({ status: 400 }, '').body.error_uri, undefined)
})

await check('⚠️ 路径前缀带尾斜杠，/api/opensesame 不算开放平台', () => {
  assert.equal(isOpenPath('/api/open/v1/token'), true)
  assert.equal(isOpenPath('/api/open/v1/games?lang=ja'), true)
  assert.equal(isOpenPath('/api/opensesame'), false)
  assert.equal(isOpenPath('/api/me'), false)
  assert.equal(isOpenPath(undefined), false)
})

server.close()
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
