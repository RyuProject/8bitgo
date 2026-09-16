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
  export async function ping() {
    globalThis.__pingCount = (globalThis.__pingCount || 0) + 1
    // 可控延迟：单飞只有在 ping 真的慢的时候才起作用，而「慢」正是要防的那个场景
    const d = globalThis.__pingDelayMs || 0
    if (d) await new Promise((r) => setTimeout(r, d))
    return true
  }
  export async function withTransaction(fn) { return fn((s, p) => globalThis.__fakeDb.query(s, p)) }
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
/**
 * 成人游戏。专门用来验「列表的 total 和实际条目算在同一层」。
 *
 * 原来 `listGames` 完全不认识 adult，而 `openGamesBySlugs` 自己加了 `adult = 0` ——
 * 于是 total 把它算进去、条目里又没有它。症状是「total 说 3，一页页翻到底只有 2 款」，
 * 而且夹着它的那一页比 page_size 短。接入方查不出原因，只会觉得我们的分页时好时坏。
 */
const ADULT_GAME = { ...GAME, id: 4, slug: 'adult-game', adult: 1 }
const GBA_GAME = { ...GAME, id: 5, slug: 'gba-rpg', platform: 'gba' }
const DOS_GAME = { ...GAME, id: 6, slug: 'dos-game', platform: 'dos', dos_backend: null }
const WIN31_GAME = { ...GAME, id: 7, slug: 'win31-game', platform: 'dos', dos_backend: 'dosboxX', dos_windows_version: '3x' }
const WIN9X_GAME = { ...GAME, id: 8, slug: 'win9x-game', platform: 'dos', dos_backend: 'dosboxX', dos_windows_version: '9x' }
const ALL_GAMES = [GAME, HIDDEN_GAME, JA_ONLY, ADULT_GAME, GBA_GAME, DOS_GAME, WIN31_GAME, WIN9X_GAME]
const GAME_GENRES = [
  { game_id: 1, genre_id: 'action' },
  { game_id: 3, genre_id: 'puzzle' },
  { game_id: 5, genre_id: 'rpg' },
]
const ROMS = [
  { game_id: 1, lang: '*', object_key: 'roms/contra.zip' },
  { game_id: 1, lang: 'ja', object_key: 'roms/contra-ja.zip' },
  { game_id: 3, lang: 'ja', object_key: 'roms/ja-only.zip' },
]
const SAMPLES = [{ platform: 'nes', game_id: 1 }]

const APP = {
  id: 'app_0123456789abcdef01234567',
  name: '测试应用',
  client_type: 'confidential',
  status: 'live',
  /*
    ⚠️ 这里**混着两级 scope**，是有意的：
    games.read / games.rom 是应用级（client_credentials 就能拿），
    library.read / saves.read 是用户级（只有设备码换来的令牌才拿得到）。
    混在一把 key 上才测得出「同一个应用，两条取令牌的路给的东西不一样」——
    而那正是这套权限模型的核心。
  */
  approved_scopes: 'games.read games.rom library.read library.write live.write saves.read',
  requested_scopes: 'games.read games.rom library.read library.write live.write saves.read',
  rate_tier: 'live',
  redirect_uris: '["https://partner.example/cb"]',
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
  name: '只批了 games.read 的沙箱应用',
  client_type: 'confidential',
  /*
    ⚠️ `status` 和 `rate_tier` **是两个字段，别看混**（设计稿 §1.4 专门讲了这件事）：
    status = 这个应用现在有什么能力（sandbox / live / suspended），
    rate_tier = 按哪一档限流。canAuthorize 看的是 **status**。

    原来这里是 `status: 'live'` 而 `rate_tier: 'sandbox'`，于是「沙箱应用只能授权给
    开发者和测试账号」那条用例恒为绿 —— canAuthorize 在 `status === 'live'` 那一行
    就直接返回 true 了，根本走不到白名单判断。改成真的沙箱。
  */
  status: 'sandbox',
  approved_scopes: 'openid profile games.read',
  requested_scopes: 'openid profile games.read',
  rate_tier: 'sandbox',
  redirect_uris: '["https://partner2.example/cb"]',
  embed_origins: '[]',
}
/** 第三个应用申请了 games.rom，但没有通过审核；只能使用站长选的样本。 */
const APP3 = {
  ...APP2,
  id: 'app_222222222222222222222222',
  name: '申请了 ROM 权限的沙箱应用',
  requested_scopes: 'games.read games.rom',
}
const APP_SECRET = 'test-secret-value'
let SECRET_HASH = ''

/* ---------- 用户数据的假行。只有设备码换来的**用户级**令牌读得到 ---------- */
const USER_ID = 'u_device_owner'
const SAVE_BYTES = Buffer.from('SAVEDATA')
const SAVES = [
  {
    runtime: 'jsdos',
    game_slug: 'contra',
    slot: 0,
    size: SAVE_BYTES.length,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
  },
]
/** 开放设备上报游玩的内存去重表；key 与 game_plays 主键同形。 */
const PLAY_ROWS = new Set()
const OAUTH_CODES = new Map()

/** 照着 WHERE 里真的写了什么来筛。多一个字少一个字都会反映到结果上 */
function listVisible(s, params = []) {
  let rows = ALL_GAMES
  if (s.includes('g.hidden = 0')) rows = rows.filter((g) => !g.hidden)
  if (s.includes('g.adult = 0')) rows = rows.filter((g) => !g.adult)
  // 类型参数排在 JOIN 里，机型参数排在 WHERE 里；假库必须按 SQL 的占位符顺序取值。
  // 否则两个条件同时传时，测试只验证了“有返回值”，没验证实际交集。
  const hasGenre = s.includes('gg.genre_id = ?')
  if (hasGenre) rows = rows.filter((g) => GAME_GENRES.some((r) => r.game_id === g.id && r.genre_id === params[0]))
  if (s.includes('g.platform = ?')) rows = rows.filter((g) => g.platform === params[hasGenre ? 1 : 0])
  if (s.includes("g.platform = 'dos' AND g.dos_backend = 'dosboxX'")) {
    rows = rows.filter((g) => g.platform === 'dos' && g.dos_backend === 'dosboxX')
  }
  if (s.includes("g.platform <> 'dos' OR COALESCE(g.dos_backend, '') <> 'dosboxX'")) {
    rows = rows.filter((g) => g.platform !== 'dos' || g.dos_backend !== 'dosboxX')
  }
  return rows
}

globalThis.__fakeDb = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    // authenticateApp 用的是另一套列（id, name, client_type, status, ...），和 getApp 不是一句 SQL
    if (s.startsWith('SELECT id, name, client_type, status, approved_scopes')) {
      return [APP, APP2, APP3].filter((a) => a.id === params[0])
    }
    if (s.startsWith('SELECT status, approved_scopes, requested_scopes FROM oauth_apps')) {
      return [APP, APP2, APP3].filter((a) => a.id === params[0])
    }
    if (s.startsWith('SELECT id, owner_id, name, description')) {
      return [APP, APP2, APP3].filter((a) => a.id === params[0])
    }
    if (s.startsWith('SELECT id, secret_hash FROM oauth_app_secrets')) {
      return [APP.id, APP2.id, APP3.id].includes(params[0]) ? [{ id: 's1', secret_hash: SECRET_HASH }] : []
    }
    if (s.startsWith('UPDATE oauth_app_secrets')) return []
    if (s.startsWith('DELETE FROM oauth_codes WHERE expires_at')) return { affectedRows: 0 }
    if (s.startsWith('INSERT INTO oauth_codes')) {
      const [codeHash, appId, userId, scopes, redirectUri, challenge, expiresAt] = params
      OAUTH_CODES.set(codeHash, {
        code_hash: codeHash,
        app_id: appId,
        user_id: userId,
        scopes,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        expires_at: expiresAt,
        used_at: null,
      })
      return { affectedRows: 1 }
    }
    if (s.startsWith('SELECT code_hash, app_id, user_id, scopes, redirect_uri, code_challenge')) {
      const row = OAUTH_CODES.get(params[0])
      return row ? [row] : []
    }
    if (s.startsWith('UPDATE oauth_codes SET used_at')) {
      const row = OAUTH_CODES.get(params[0])
      if (row) row.used_at = new Date()
      return { affectedRows: row ? 1 : 0 }
    }
    // 同意页（/api/oauth/authorize、/api/open-device）要登录：这里给一个 id 对得上的用户
    if (s.startsWith('SELECT * FROM users WHERE id = ?')) {
      return params[0] === USER_ID ? [{ id: USER_ID, token_version: 0, status: 'active' }] : []
    }
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
    if (s.startsWith('SELECT id FROM games WHERE slug = ?')) {
      const game = ALL_GAMES.find((g) => g.slug === params[0])
      return game ? [{ id: game.id }] : []
    }
    if (s.startsWith('INSERT IGNORE INTO game_plays')) {
      const [kind, identity, slug] = params
      const game = ALL_GAMES.find((g) => g.slug === slug && !g.hidden)
      if (!game) return { affectedRows: 0 }
      const key = `${game.id}:${kind}:${identity}`
      if (PLAY_ROWS.has(key)) return { affectedRows: 0 }
      PLAY_ROWS.add(key)
      return { affectedRows: 1 }
    }
    if (s.startsWith('UPDATE games SET plays = plays + 1')) {
      const game = ALL_GAMES.find((g) => g.slug === params[0] && !g.hidden)
      if (game) game.plays += 1
      return { affectedRows: game ? 1 : 0 }
    }
    /*
      列表和它的 COUNT。**两条走同一个过滤函数** —— 这正是要测的那件事：
      真库里 total 和条目也是两条 SQL，只要路由漏传 excludeAdult，
      两边就会不一致。假库自己替被测代码筛掉 adult 的话，这个 bug 永远测不出来。
    */
    if (s.startsWith('SELECT g.* FROM games')) {
      const rows = listVisible(s, params)
      const page = s.match(/LIMIT (\d+) OFFSET (\d+)/)
      return page ? rows.slice(Number(page[2]), Number(page[2]) + Number(page[1])) : rows
    }
    if (s.startsWith('SELECT COUNT') && s.includes('FROM games')) return [{ n: listVisible(s, params).length }]
    if (s.startsWith('SELECT COUNT')) return [{ n: 1 }]
    if (s.startsWith('SELECT game_id, genre_id')) return GAME_GENRES.filter((r) => params.includes(r.game_id))
    if (s.startsWith('SELECT game_id, tag')) return [{ game_id: 1, tag: '经典' }]
    if (s.startsWith('SELECT game_id, lang, object_key')) return ROMS
    if (s.startsWith('SELECT s.platform, g.slug, g.title FROM open_rom_samples')) {
      return SAMPLES.flatMap((sample) => {
        const game = ALL_GAMES.find((g) => g.id === sample.game_id && g.platform === sample.platform && !g.hidden && !g.adult)
        return game && ROMS.some((rom) => rom.game_id === game.id)
          ? [{ platform: sample.platform, slug: game.slug, title: game.title }]
          : []
      })
    }
    if (s.startsWith('SELECT 1 AS ok FROM open_rom_samples')) {
      return SAMPLES.some((r) => r.platform === params[0] && r.game_id === params[1]) ? [{ ok: 1 }] : []
    }
    if (s.startsWith('SELECT s.platform FROM open_rom_samples')) {
      return SAMPLES.flatMap((sample) => {
        const game = ALL_GAMES.find((g) => g.id === sample.game_id && g.platform === sample.platform && g.slug === params[0] && !g.hidden && !g.adult)
        return game && ROMS.some((rom) => rom.game_id === game.id && rom.object_key === params[1])
          ? [{ platform: sample.platform }]
          : []
      })
    }
    /* ---- 用户数据（library / saves）。同样照着 SQL 说的做，不替被测代码过滤 ---- */
    if (s.startsWith('SELECT g.slug FROM favorites')) {
      return params[0] === USER_ID ? [{ slug: 'contra' }] : []
    }
    if (s.startsWith('SELECT g.slug FROM recents')) {
      return params[0] === USER_ID ? [{ slug: 'contra' }] : []
    }
    if (s.startsWith('INSERT INTO recents')) return { affectedRows: 1 }
    if (s.startsWith('DELETE FROM recents')) return { affectedRows: 0 }
    if (s.startsWith('SELECT runtime, game_slug, slot, size, created_at, updated_at FROM saves')) {
      return params[0] === USER_ID ? SAVES : []
    }
    if (s.startsWith('SELECT data, updated_at FROM saves')) {
      const [uid, runtime, slug, slot] = params
      const hit = SAVES.find(
        (r) => uid === USER_ID && r.runtime === runtime && r.game_slug === slug && r.slot === slot,
      )
      return hit ? [{ data: SAVE_BYTES, updated_at: hit.updated_at }] : []
    }
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
const { oauthRouter } = await import('../src/routes/oauth.js')
const { openDeviceRouter } = await import('../src/routes/open-device.js')
const { hashSecret } = await import('../src/open/apps.js')
const { verifyToken } = await import('../src/auth.js')
const { issueAppToken, verifyOpenToken } = await import('../src/open/tokens.js')
const { verifyLivePublisherToken } = await import('../src/open/live-publisher.js')
const { signToken } = await import('../src/auth.js')
const { FORBIDDEN_OUT_KEYS } = await import('../src/open/mapper.js')
const { isOpenPath, openErrorFor, openErrorMiddleware } = await import('../src/open/errors.js')
const device = await import('../src/open/device.js')
const { pickDescription, pickTitle } = await import('../src/open/i18n.js')
const jwtLib = (await import('jsonwebtoken')).default
SECRET_HASH = await hashSecret(APP_SECRET)

const app = express()
app.use(express.json())
app.use('/api/open', openRouter)
app.use('/api/oauth', oauthRouter)
/*
  设备码流程里「用户确认」那一步的站内接口。它在真实应用里挂在 /api/open-device
  （index.js），是**站内**路由（登录态 + 站内 CORS），和 /api/open 不是一套。
  这里挂上它，下面那条「同意页走的是同一套」的用例才是真的打到了 HTTP 层。
*/
app.use('/api/open-device', openDeviceRouter)
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
/** 测试里「已登录用户」的站点 JWT（和资源拥有者 USER_ID 对上，token_version=0） */
const userBearer = () => ({ Authorization: `Bearer ${signToken(USER_ID, 0)}` })

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

await check('⚠️ access token 的 aud 必须和 cid 指向同一个应用', () => {
  const crossed = jwtLib.sign(
    { cid: APP.id, aud: APP2.id, sub: APP.id, kind: 'app', scope: 'games.read' },
    privateKey,
    { algorithm: 'RS256', header: { typ: 'at+jwt' } },
  )
  assert.equal(verifyOpenToken(crossed, { publicKey }), null, '受众和客户端混用的令牌被接受了')
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

await check('仍然要令牌的接口：没有令牌 / 令牌过期 -> 401', async () => {
  /*
    ⚠️ 这条原来打的是 /v1/games/contra —— 那条 2026-09-13 起是**公开**的，
    再用它测「没令牌就 401」只会把一条本该变绿的用例钉在旧行为上。
    换成两条仍然要令牌的：一条要 scope（rom），一条只要令牌（me）。
  */
  for (const path of ['/api/open/v1/games/contra/rom', '/api/open/v1/me']) {
    assert.equal((await api(path)).status, 401, `${path} 放了匿名请求进来`)
  }
  const expired = issueAppToken({
    privateKey, kid: 'test-1', issuer: 'https://8bitgo.com', appId: APP.id, scopes: ['games.rom'],
    ttl: 60, now: Date.now() - 3600_000,
  })
  assert.equal(
    (await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${expired}` } })).status,
    401,
  )
})

console.log('\n三之二、公开目录：游戏列表不要令牌，ROM 要')

/*
  ## 这一节在守什么

  2026-09-13 把游戏目录整个改成公开（`optionalApp`），只有 ROM 那条还要 Appkey。
  一改成公开，三件事同时变成了「错了也看不出来」：

    1. **坏令牌被当成匿名放行**。最自然的写法就是错的写法：
       `const claims = verify(token); if (claims) req.openClaims = claims; next()`。
       接入方的令牌过期之后列表照常 200，只是悄悄降了权限 ——
       他们要到调 ROM 时才发现，而那句错误说的是「ROM 权限不够」，
       不是「你的令牌两小时前就过期了」。**必须 401。**
    2. **ROM 跟着一起开了**。用户明确要的是「列表公开、ROM 要 Appkey」。
    3. **匿名那条路没有任何配额**。原来每一条都有 appId 可以计数，公开之后没有了。

  另外补一条 total/条目一致性：见 ADULT_GAME 那段注释。
*/

await check('⚠️ 匿名（完全不带 Authorization 头）能读列表和详情', async () => {
  const list = await api('/api/open/v1/games')
  assert.equal(list.status, 200, '匿名读列表被挡了')
  const page = await list.json()
  assert.ok(Array.isArray(page.items) && page.items.length > 0, '匿名拿到的是空列表')

  const one = await api('/api/open/v1/games/contra')
  assert.equal(one.status, 200, '匿名读详情被挡了')
  assert.equal((await one.json()).slug, 'contra')

  for (const path of ['/api/open/v1/platforms', '/api/open/v1/genres', '/api/open/v1/languages',
                      '/api/open/v1/live/capacity', '/api/open/v1/live/rooms', '/api/open/v1/collections']) {
    assert.equal((await api(path)).status, 200, `${path} 匿名读不了`)
  }
})

await check('⚠️⚠️ 带了一枚坏令牌 -> 401，**不能**静默当成匿名放行', async () => {
  const expired = issueAppToken({
    privateKey, kid: 'test-1', issuer: 'https://8bitgo.com', appId: APP.id, scopes: ['games.read'],
    ttl: 60, now: Date.now() - 3600_000,
  })
  for (const header of [
    `Bearer ${expired}`,
    'Bearer not-a-jwt-at-all',
    'Bearer ',
    'Basic ' + Buffer.from('a:b').toString('base64'),
  ]) {
    const r = await api('/api/open/v1/games', { headers: { Authorization: header } })
    assert.equal(r.status, 401, `「${header.slice(0, 20)}…」被当成匿名放行了`)
    assert.equal((await r.json()).error, 'invalid_token')
  }
})

await check('⚠️⚠️ 开放平台密钥没配时，公开目录照样能读（它一把密钥都用不上）', async () => {
  /*
    这一条是 2026-09-13 线上实测逼出来的：当时生产环境 `/api/open/v1/platforms`
    回的是 501 `开放平台未启用` —— server/.env 里一个 OPEN_ 变量都没有。

    第一版的 optionalApp 里跟着查了一遍 openConfig()，于是「游戏列表公开」
    **依赖一个和它完全无关的环境变量**：部署上去之后匿名调用方拿到的还是 501，
    整个改动等于没做，而且本地测试全绿（测试环境里密钥是现生成的）。

    公开目录只查数据库，不签也不验任何东西。要密钥的那些才该 501。
  */
  const { resetOpenConfig } = await import('../src/open/config.js')
  const savedKey = process.env.OPEN_JWT_PRIVATE_KEY
  delete process.env.OPEN_JWT_PRIVATE_KEY
  resetOpenConfig()
  try {
    for (const path of ['/api/open/v1/games', '/api/open/v1/games/contra', '/api/open/v1/platforms',
                        '/api/open/v1/genres', '/api/open/v1/languages', '/api/open/v1/live/capacity', '/api/open/v1/live/rooms',
                        '/api/open/v1/netplay/rooms', '/api/open/v1/collections', '/api/open/v1/health']) {
      assert.equal((await api(path)).status, 200, `${path} 因为没配签名密钥而不可用 —— 它根本用不到密钥`)
    }
    // 反过来：真的需要密钥的那些必须照旧 501，而不是被一起放开
    for (const path of ['/api/open/v1/me', '/api/open/v1/games/contra/rom', '/api/open/v1/library']) {
      assert.equal((await api(path)).status, 501, `${path} 在没有密钥的情况下没有报 501`)
    }
  } finally {
    process.env.OPEN_JWT_PRIVATE_KEY = savedKey
    resetOpenConfig()
  }
})

await check('带了**有效**令牌时，公开接口不再挑 scope（否则匿名能读、带令牌反而 403）', async () => {
  // 这枚令牌只有 games.rom，没有 games.read
  const { access_token } = await getToken('games.rom')
  const r = await api('/api/open/v1/games', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(r.status, 200, '有效令牌反而比匿名权限还小')
})

await check('⚠️ ROM 凭据没跟着一起公开（用户要的是「列表公开、ROM 要 Appkey」）', async () => {
  const r = await api('/api/open/v1/games/contra/rom')
  assert.equal(r.status, 401, 'ROM 凭据接口变成匿名可取了')
  // 拿一枚只有 games.read 的令牌也不行 —— 两个量级的风险，scope 分开
  const { access_token } = await getToken('games.read')
  const r2 = await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(r2.status, 403)
})

await check('⚠️ 用户数据和自省也没跟着公开', async () => {
  for (const path of ['/api/open/v1/me', '/api/open/v1/library', '/api/open/v1/saves',
                      '/api/open/v1/games/contra/embed']) {
    assert.equal((await api(path)).status, 401, `${path} 变成匿名可读了`)
  }
  const play = await api('/api/open/v1/games/contra/play', { method: 'POST' })
  assert.equal(play.status, 401, '跨设备游玩上报变成匿名可写了')
  const publish = await api('/api/open/v1/live/publish-token', { method: 'POST' })
  assert.equal(publish.status, 401, '设备开播凭证变成匿名可领了')
})

await check('直播与 P2P 联机房间发现都有公开列表和详情', async () => {
  const capacityResponse = await api('/api/open/v1/live/capacity')
  assert.equal(capacityResponse.status, 200)
  const capacity = await capacityResponse.json()
  assert.deepEqual(Object.keys(capacity).sort(), ['available', 'max', 'remaining', 'used'])
  assert.equal(capacity.available, capacity.used < capacity.max)
  for (const path of ['/api/open/v1/live/rooms', '/api/open/v1/netplay/rooms?game=contra']) {
    const r = await api(path)
    assert.equal(r.status, 200, path)
    assert.ok(Array.isArray((await r.json()).items), `${path} 没回 items`)
  }
  const missing = await api('/api/open/v1/netplay/rooms/not-a-room')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'not_found')
})

await check('按机型、按类型可单独或组合筛选，分页总数与交集一致', async () => {
  const cases = [
    ['platform=gba', ['gba-rpg']],
    ['genre=action', ['contra']],
    ['platform=nes&genre=puzzle', ['ja-only']],
    ['platform=gba&genre=action', []],
  ]
  for (const [query, slugs] of cases) {
    const response = await api(`/api/open/v1/games?${query}`)
    assert.equal(response.status, 200, query)
    const page = await response.json()
    assert.deepEqual(page.items.map((g) => g.slug), slugs, query)
    assert.equal(page.total, slugs.length, query)
    assert.equal(page.total_pages, 1, query)
  }

  const secondPage = await (await api('/api/open/v1/games?platform=nes&page_size=1&page=2')).json()
  assert.equal(secondPage.page, 2)
  assert.equal(secondPage.page_size, 1)
  assert.equal(secondPage.total, 2)
  assert.equal(secondPage.total_pages, 2)
  assert.equal(secondPage.items.length, 1)
  assert.equal(secondPage.items[0].platform, 'nes')
})

await check('DOS 与 Windows 客体按后台复选框筛选，详情标记和分页总数一致', async () => {
  const cases = [
    ['platform=dos', ['dos-game', 'win31-game', 'win9x-game']],
    ['platform=dos&requires_windows=false', ['dos-game']],
    ['platform=dos&requires_windows=true', ['win31-game', 'win9x-game']],
  ]
  for (const [query, slugs] of cases) {
    const response = await api(`/api/open/v1/games?${query}`)
    assert.equal(response.status, 200, query)
    const page = await response.json()
    assert.deepEqual(page.items.map((g) => g.slug), slugs, query)
    assert.equal(page.total, slugs.length, query)
  }

  const smallPage = await (await api('/api/open/v1/games?platform=dos&requires_windows=false&page_size=1')).json()
  assert.equal(smallPage.total, 1)
  assert.equal(smallPage.total_pages, 1)
  assert.equal(smallPage.items[0].requires_windows, false)

  const allCapable = await (await api('/api/open/v1/games?requires_windows=false&page_size=50')).json()
  assert.equal(allCapable.total, 4)
  assert.ok(allCapable.items.every((g) => g.requires_windows === false))
  for (const [slug, expected] of [['dos-game', false], ['win31-game', true], ['win9x-game', true]]) {
    const detail = await (await api(`/api/open/v1/games/${slug}`)).json()
    assert.equal(detail.requires_windows, expected, slug)
    assert.ok(!('dos_backend' in detail), '对外响应泄漏了运行核心的内部字段')
  }
  const bad = await api('/api/open/v1/games?requires_windows=maybe')
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'invalid_request')
})

await check('⚠️ total 和实际条目算在同一层（成人内容不能只在后半程被筛掉）', async () => {
  const page = await (await api('/api/open/v1/games?page_size=50')).json()
  assert.equal(
    page.items.length, page.total,
    `total=${page.total} 但这一页只有 ${page.items.length} 条 —— 两处过滤不一致`,
  )
  assert.ok(!page.items.some((g) => g.slug === 'adult-game'), '成人游戏出现在公开列表里')
  assert.ok(!page.items.some((g) => g.slug === 'secret-game'), '下架游戏出现在公开列表里')
  assert.ok(page.items.some((g) => g.slug === 'contra'), '正常游戏反而没了')
})

await check('⚠️ 公开之后匿名那条路仍然有配额（原来每条都有 appId 可以计数，现在没有）', async () => {
  const { resetBuckets, take } = await import('../src/rateLimit.js')
  const src = stripComments(
    (await import('node:fs')).readFileSync(new URL('../src/routes/open.js', import.meta.url), 'utf8'),
  )
  /*
    ⚠️ 这里断言的是**两个桶都在**，不是「代码里出现过 take 这个词」。
    按 IP 那一道在反代没透传真实 IP 时会整个跳过（isMeaningfulIp），
    所以全站那一道不是冗余，是唯一的下限 —— 只留一个都不算数。
  */
  assert.ok(src.includes('open:pub:ip:'), '匿名按 IP 那一层没了')
  assert.ok(src.includes('open:pub:global'), '匿名全站兜底那一层没了')
  assert.ok(src.includes('isMeaningfulIp('), '没判 IP 可不可信，反代配错会把所有人锁在门外')

  // 真的把桶打满，确认 429 会发出来，而且带 Retry-After
  resetBuckets()
  for (let i = 0; i < 3000; i++) take('open:pub:global', 3000, 60_000)
  const r = await api('/api/open/v1/games')
  assert.equal(r.status, 429, '全站兜底那一道没接上')
  assert.ok(Number(r.headers.get('retry-after')) > 0, '429 没带 Retry-After')
  assert.equal((await r.json()).error, 'rate_limited')
  resetBuckets() // 别把后面的用例一起锁死
})

await check('⚠️ /v1/health 不会被打穿数据库（缓存 + 单飞），但也不会被冻住', async () => {
  const { expireHealthCache } = await import('../src/routes/open.js')
  expireHealthCache()
  globalThis.__pingCount = 0
  // 并发 50 条 + 随后再来 10 条：真的 ping 只应该发生一次
  await Promise.all(Array.from({ length: 50 }, () => api('/api/open/v1/health')))
  for (let i = 0; i < 10; i++) await api('/api/open/v1/health')
  assert.equal(
    globalThis.__pingCount, 1,
    `60 条请求打出了 ${globalThis.__pingCount} 次真实 ping —— 这条接口公开、匿名、不限流，` +
      '而连接池是和 SSR / 直播共用的',
  )
  assert.equal((await (await api('/api/open/v1/health')).json()).db, true)

  /*
    ⚠️ 另一半：TTL 过了必须**真的再探一次**。
    只测「不重复 ping」是不够的 —— 把 `healthInFlight = null` 那行删掉同样不重复 ping，
    但那是因为它从此永远返回第一次的结果：数据库挂了这条接口也回 200。
    健康检查撒谎比健康检查慢危险得多。（expireHealthCache 刻意不碰 in-flight，见那边注释。）
  */
  expireHealthCache()
  await api('/api/open/v1/health')
  assert.equal(
    globalThis.__pingCount, 2,
    'TTL 过期之后没有再探 —— 探测状态被冻在第一次的结果上了',
  )

  /*
    ⚠️ 第三半：**单飞**本身。

    上面那 50 条并发其实测不到它 —— 假的 ping 是同步落定的，第一条请求在第二条
    从 socket 上被读出来之前就已经写好缓存了，于是全被 TTL 挡住，
    `if (!healthInFlight)` 那道删掉照样绿（变异测试实测）。
    而真实环境里 ping 要走一趟数据库，正是「慢」的时候并发才会堆起来 ——
    也正是这条接口被当成打点用的那一刻。所以这里必须让 ping 真的慢下来再并发打。
  */
  expireHealthCache()
  globalThis.__pingCount = 0
  globalThis.__pingDelayMs = 150
  try {
    await Promise.all(Array.from({ length: 30 }, () => api('/api/open/v1/health')))
  } finally {
    globalThis.__pingDelayMs = 0
  }
  assert.equal(
    globalThis.__pingCount, 1,
    `ping 慢的时候 30 条并发打出了 ${globalThis.__pingCount} 次真实探测 —— 单飞没接上，` +
      '而连接池是和 SSR / 直播共用的',
  )
})

await check('⚠️ openapi.json 的 security 和真实路由表一致（规格骗人比没有规格更糟）', async () => {
  const fs = await import('node:fs')
  const spec = JSON.parse(fs.readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
  const src = stripComments(fs.readFileSync(new URL('../src/routes/open.js', import.meta.url), 'utf8'))

  /** 从源码里把「这条路由挂的是哪个中间件」抠出来 */
  const guards = new Map()
  for (const m of src.matchAll(/openRouter\.(get|post)\('([^']+)'\s*,\s*([A-Za-z]+)\(([^)]*)\)/g)) {
    guards.set(`${m[1]} ${m[2]}`, { fn: m[3], scope: m[4].replace(/['"]/g, '').trim() })
  }
  // 完全没有中间件的（health / rom 兑现 / token / device）单独认出来
  for (const m of src.matchAll(/openRouter\.(get|post)\('([^']+)'\s*,\s*(?:tokenBody\s*,\s*)?async/g)) {
    if (!guards.has(`${m[1]} ${m[2]}`)) guards.set(`${m[1]} ${m[2]}`, { fn: 'none', scope: '' })
  }
  assert.ok(guards.size >= 18, `只认出了 ${guards.size} 条路由，正则漂了`)

  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (typeof op !== 'object') continue
      // openapi 的 {slug} <-> express 的 :slug
      const expressPath = path.replace(/\{(\w+)\}/g, ':$1')
      const g = guards.get(`${method} ${expressPath}`)
      assert.ok(g, `openapi.json 里有 ${method.toUpperCase()} ${path}，源码里没有这条路由`)
      const sec = op.security ?? null
      const anonymousOk = Array.isArray(sec) && sec.some((o) => Object.keys(o).length === 0)
      const scopes = Array.isArray(sec) ? sec.flatMap((o) => Object.values(o).flat()) : []

      if (g.fn === 'optionalApp') {
        assert.ok(anonymousOk, `${path}：代码是公开的，规格却说必须带令牌`)
        assert.deepEqual(scopes, [], `${path}：公开接口不该在规格里要 scope`)
      } else if (g.fn === 'none') {
        assert.equal(sec, null, `${path}：代码里没有任何鉴权，规格却写了 security`)
      } else {
        assert.ok(sec && !anonymousOk, `${path}：代码要令牌，规格却标成了可匿名`)
        assert.deepEqual(
          scopes, g.scope ? [g.scope] : [],
          `${path}：规格写的 scope 和代码里的 ${g.fn}('${g.scope}') 对不上`,
        )
      }
    }
  }
})

console.log('\n四、ROM：独立 scope + 短期凭据')

await check('⚠️ games.read 不附带 ROM 权限（那是两个量级的风险）', async () => {
  const { access_token } = await getToken('games.read')
  const r = await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'insufficient_scope')
})

await check('未审核应用申请 games.rom 后拿到样本权限，而不是整库权限', async () => {
  const token = await getToken('games.read games.rom', APP3.id)
  assert.ok(token.access_token)
  assert.equal(token.scope, 'games.read games.rom')
  assert.equal(token.rom_access, 'samples')
  assert.equal((await getToken('games.rom')).rom_access, 'full')
  const samples = await (await api('/api/open/v1/rom-samples')).json()
  assert.deepEqual(samples.items, [{ platform: 'nes', slug: 'contra', title: 'Contra' }])
  assert.ok(!JSON.stringify(samples).includes('roms/contra'), '公开样本目录泄露了对象 key')
})

await check('沙箱只能领样本的 ROM 凭据，不能领同机型其他游戏', async () => {
  try {
    const { access_token } = await getToken('games.rom', APP3.id)
    const headers = { Authorization: `Bearer ${access_token}` }
    const sample = await api('/api/open/v1/games/contra/rom', { headers })
    assert.equal(sample.status, 200)
    const { url } = await sample.json()
    const grant = url.split('/api/open/v1/rom/')[1]
    const redeemed = await api(`/api/open/v1/rom/${grant}`, { redirect: 'manual' })
    assert.equal(redeemed.status, 302)
    const other = await api('/api/open/v1/games/ja-only/rom?lang=ja', { headers })
    assert.equal(other.status, 403)
    assert.equal((await other.json()).error, 'sandbox_resource_only')

    // 撤换样本后，已签发但未过期的沙箱票也必须立即失效。
    SAMPLES.length = 0
    const revoked = await api(`/api/open/v1/rom/${grant}`, { redirect: 'manual' })
    assert.equal(revoked.status, 403)

    // 旧票自身带沙箱标记，上产也不能把它变成一张不受样本限制的票。
    APP3.status = 'live'
    APP3.approved_scopes += ' games.rom'
    const upgraded = await api(`/api/open/v1/rom/${grant}`, { redirect: 'manual' })
    assert.equal(upgraded.status, 403)
    APP3.status = 'sandbox'
    APP3.approved_scopes = 'openid profile games.read'
    SAMPLES.push({ platform: 'nes', game_id: 1 })

    // 停用应用后，旧令牌与旧票都不能继续下载。
    APP3.status = 'suspended'
    const denied = await api('/api/open/v1/games/contra/rom', { headers })
    assert.equal(denied.status, 403)
    const stopped = await api(`/api/open/v1/rom/${grant}`, { redirect: 'manual' })
    assert.equal(stopped.status, 403)
  } finally {
    APP3.status = 'sandbox'
    APP3.approved_scopes = 'openid profile games.read'
    SAMPLES.splice(0, SAMPLES.length, { platform: 'nes', game_id: 1 })
  }
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

await check('⚠️ 一张 ROM 凭据不能被无限兑现（它是唯一一条既没令牌、原先也没配额的路）', async () => {
  const { resetBuckets } = await import('../src/rateLimit.js')
  resetBuckets()
  const { access_token } = await getToken('games.rom')
  const { url } = await (
    await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${access_token}` } })
  ).json()
  const grant = url.split('/api/open/v1/rom/')[1]
  /*
    上游 /v1/games/:slug/rom 那道 600/小时 限的是**领票**，不是**兑票**。
    领一张之后在五分钟里兑多少次，原来完全不设限 —— 抄走一张票就等于五分钟无限下。
  */
  let sawLimit = false
  for (let i = 0; i < 40; i++) {
    const r = await api(`/api/open/v1/rom/${grant}`, { redirect: 'manual' })
    if (r.status === 429) { sawLimit = true; break }
    assert.equal(r.status, 302, `第 ${i + 1} 次兑现回了 ${r.status}`)
  }
  assert.ok(sawLimit, '同一张凭据兑了 40 次都没被拦，按票的配额没接上')
  resetBuckets()
})

await check('⚠️ 公开目录可以被边缘缓存，但用户数据和 ROM 绝不可以', async () => {
  // 公开之后不盖掉 /api 那道 no-store 的话，每一条爬虫请求都会真的落到数据库上
  for (const path of ['/api/open/v1/games', '/api/open/v1/games/contra']) {
    const cc = String((await api(path)).headers.get('cache-control'))
    assert.match(cc, /public/, `${path} 没有可缓存的响应头`)
    assert.match(cc, /s-maxage=\d+/, `${path} 没给边缘节点缓存时间`)
  }
  /*
    ⚠️ 反过来那一半更要紧：缓存头一旦写错方向，边缘会把一个人的数据发给下一个人。
    直播房间是秒级变化的，缓存它等于把「谁在播」变成假的。
  */
  const { access_token } = await getToken('games.rom')
  const { url } = await (
    await api('/api/open/v1/games/contra/rom', { headers: { Authorization: `Bearer ${access_token}` } })
  ).json()
  const grant = url.split('/api/open/v1/rom/')[1]
  for (const [path, init] of [
    ['/api/open/v1/rom/' + grant, { redirect: 'manual' }],
    ['/api/open/v1/live/capacity', undefined],
    ['/api/open/v1/live/rooms', undefined],
  ]) {
    const cc = String((await api(path, init)).headers.get('cache-control'))
    assert.ok(!/public/.test(cc), `${path} 被标成了可公开缓存：${cc}`)
  }
})

console.log('\n五、CORS 与自省')

await check('⚠️ 开放接口放开到任意 Origin', async () => {
  const r = await api('/api/open/v1/games/contra', { headers: { Origin: 'https://partner.example' } })
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  // 放开到 * 的接口一律不带 cookie（Bearer 走 header，天然没有 CSRF 面）
  assert.equal(r.headers.get('access-control-allow-credentials'), null)
})

await check('⚠️ 站内 /api/health 不把数据库异常原文回给匿名调用方', async () => {
  /*
    mysql2 的连接错误里带着主机名、端口，有时还带着出错的那条 SQL，
    而这条接口任何人都能打。一句 db:false 调用方已经够用了，
    真要排错的人看的是进程日志。
  */
  const src = stripComments(
    (await import('node:fs')).readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'),
  )
  const route = src.slice(src.indexOf("app.get('/api/health'"), src.indexOf("'/.well-known/openapi.json'"))
  assert.ok(route.length > 50, '没定位到 /api/health 那段源码，断言漂了')
  assert.ok(!/error:\s*String\(/.test(route), '/api/health 把异常原文回出去了')
  assert.ok(/console\.error/.test(route), '异常既没回给调用方也没记日志，等于吞了')
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

console.log('\n八、设备码流程（RFC 8628）：设备上没有浏览器')

/*
  ## 这一节在守什么

  开放平台原本只有 client_credentials 一条取令牌的路，而它签出来的令牌**背后没有用户** ——
  所以 library.* / saves.* 这些 user 级 scope 永远拿不到。scopes.js 里声明了它们，
  routes/open.js 里却连路由都没有，而且就算有也没人调得到：`issueUserToken`
  在此之前**一个调用方都没有**。

  设备码流程补的就是这一半：设备显示一串码，人在手机上输进去点同意，设备轮询拿令牌。

  下面每一条对应协议里一个**接入方必然会写错**的地方，或者一个安全边界。
*/

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const askDevice = async (scope, appId = APP.id, secret = APP_SECRET) =>
  api('/api/open/v1/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: appId, client_secret: secret, ...(scope ? { scope } : {}) }),
  })
const pollDevice = async (deviceCode, appId = APP.id) =>
  api('/api/open/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: DEVICE_GRANT,
      client_id: appId,
      client_secret: APP_SECRET,
      device_code: deviceCode,
    }),
  })

await check('设备能要到一串码，回的字段是协议规定的那几个', async () => {
  device.resetDeviceAuths()
  const r = await askDevice('library.read')
  assert.equal(r.status, 200)
  const j = await r.json()
  for (const k of ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval']) {
    assert.ok(j[k] !== undefined, `少了 ${k}`)
  }
  // 能显示二维码的设备直接把它编成码，用户不用手打
  assert.match(j.verification_uri_complete, /\/open\/device\?code=/)
  assert.match(j.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
})

await check('⚠️ 用户码的字母表里没有元音和形近字符', () => {
  /*
    用户是照着小屏幕念出来手打的：0/O、1/I/L 认错一个就白输一遍；
    有元音的话八位随机串迟早拼出脏话，而那串码要显示在别人的设备上。
  */
  for (let i = 0; i < 200; i++) {
    const c = device.newUserCode()
    assert.match(c, /^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/, c)
  }
})

await check('用户码的比对认得出大小写、空格和横线的各种写法', () => {
  assert.equal(device.normalizeUserCode('bcdf-ghjk'), 'BCDFGHJK')
  assert.equal(device.normalizeUserCode('BCDF GHJK'), 'BCDFGHJK')
  assert.equal(device.normalizeUserCode('BCDFGHJK'), 'BCDFGHJK')
})

await check('⚠️ 没人确认时轮询回 authorization_pending（这不是失败，是「接着等」）', async () => {
  device.resetDeviceAuths()
  const { device_code } = await (await askDevice('library.read')).json()
  const r = await pollDevice(device_code)
  assert.equal(r.status, 400, '协议规定这一支就是 400')
  const j = await r.json()
  assert.equal(j.error, 'authorization_pending')
  assert.ok(j.error_description, '没说清楚该接着等 —— 接入方会把 400 当失败退出')
})

await check('⚠️ 轮询太快回 slow_down，而且**不把节流时间戳往后推**', async () => {
  device.resetDeviceAuths()
  const { device_code } = await (await askDevice('library.read')).json()
  const opts = (t) => ({ appId: APP.id, now: t, intervalSec: 5 })
  const t0 = Date.now()

  assert.equal(device.pollDeviceAuth(device_code, opts(t0)).error, 'authorization_pending')
  assert.equal(device.pollDeviceAuth(device_code, opts(t0 + 1000)).error, 'slow_down', '1 秒后又轮了一次，没被节流')

  /*
    ⚠️ 关键的一条，而且**必须卡着时间点测**。

    如果 slow_down 那一支也把 lastPolledAt 往后推，一台死循环轮询的设备会**永远**
    收到 slow_down —— 它每次都把闸门重新顶到最新时刻，减速之后反而更难恢复。

    下面这个时间点就是用来分辨两种实现的：距离**第一次**轮询 5.5 秒（够了），
    但距离那次被拒的快轮只有 4.5 秒（不够）。
    正确实现看前者 -> 放行；把时间戳往后推的实现看后者 -> 还是 slow_down。
    （第一版这条用例用的是 now + 10 秒，两种实现都放行，等于没测 —— 变异测试抓出来的。）
  */
  assert.equal(
    device.pollDeviceAuth(device_code, opts(t0 + 5500)).error,
    'authorization_pending',
    '被拒的那次把节流窗口顶后了 —— 设备减速之后永远恢复不了',
  )
})

await check('用户同意之后，设备换到的是**用户级**令牌', async () => {
  device.resetDeviceAuths()
  const { device_code, user_code } = await (await askDevice('library.read saves.read')).json()
  assert.ok(device.approveDeviceAuth(user_code, USER_ID))
  const j = await (await pollDevice(device_code)).json()
  assert.ok(j.access_token, `没拿到令牌：${JSON.stringify(j)}`)
  assert.equal(j.scope, 'library.read saves.read')
  const me = await (await api('/api/open/v1/me', { headers: { Authorization: `Bearer ${j.access_token}` } })).json()
  assert.equal(me.kind, 'user')
  assert.equal(me.user_id, USER_ID, '/v1/me 没报出这枚令牌是谁的')
})

await check('⚠️ 一串 device_code 只能兑现一次', async () => {
  device.resetDeviceAuths()
  const { device_code, user_code } = await (await askDevice('library.read')).json()
  device.approveDeviceAuth(user_code, USER_ID)
  assert.ok((await (await pollDevice(device_code)).json()).access_token)
  const again = await (await pollDevice(device_code)).json()
  assert.equal(again.error, 'invalid_grant', '同一串码换出了第二枚令牌 —— 抄走它的人可以一直换')
})

await check('⚠️ 拿别的应用的 key 去兑现别人的 device_code：invalid_grant，且和「没这条」同一句话', async () => {
  device.resetDeviceAuths()
  const { device_code, user_code } = await (await askDevice('library.read')).json()
  device.approveDeviceAuth(user_code, USER_ID)
  const stolen = await (await pollDevice(device_code, APP2.id)).json()
  const nonsense = await (await pollDevice('no-such-device-code', APP2.id)).json()
  assert.equal(stolen.error, 'invalid_grant')
  assert.deepEqual(
    { e: stolen.error, d: stolen.error_description },
    { e: nonsense.error, d: nonsense.error_description },
    '两种失败的说法不一样 —— 可以据此确认「这个 device_code 存在」',
  )
})

await check('用户拒绝 -> access_denied', async () => {
  device.resetDeviceAuths()
  const { device_code, user_code } = await (await askDevice('library.read')).json()
  assert.ok(device.denyDeviceAuth(user_code))
  assert.equal((await (await pollDevice(device_code)).json()).error, 'access_denied')
})

await check('⚠️ 同意页（/api/open-device）走的是同一套，HTTP 层也能端到端', async () => {
  /*
    设备码流程的「用户确认」那一半（open-device.js）也是要登录的站内接口；
    上面那些用例是直连 device.js 纯函数验证逻辑，这一条走真 HTTP，
    确认 approve 之后设备真能轮询到用户级令牌。
  */
  device.resetDeviceAuths()
  const { device_code, user_code } = await (await askDevice('library.read saves.read')).json()
  const approve = await api(`/api/open-device/${user_code}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...userBearer() },
    body: JSON.stringify({ approve: true }),
  })
  assert.equal(approve.status, 200)
  assert.equal((await approve.json()).approved, true, '同意页没把授权落下来')
  const j = await (await pollDevice(device_code)).json()
  assert.ok(j.access_token, `同意页批准后换不到令牌：${JSON.stringify(j)}`)
  assert.equal(j.scope, 'library.read saves.read')
})

await check('过期 -> expired_token', () => {
  device.resetDeviceAuths()
  const made = device.createDeviceAuth({ appId: APP.id, scopes: ['library.read'], ttlSec: 1 })
  const r = device.pollDeviceAuth(made.deviceCode, { appId: APP.id, now: Date.now() + 2000 })
  assert.equal(r.error, 'expired_token')
})

await check('⚠️ 两个人先后输同一串码，只有第一个算数', () => {
  device.resetDeviceAuths()
  const made = device.createDeviceAuth({ appId: APP.id, scopes: ['library.read'] })
  assert.equal(device.approveDeviceAuth(made.userCode, 'u_first'), true)
  assert.equal(device.approveDeviceAuth(made.userCode, 'u_second'), false, '第二个人把授权改到了自己名下')
  const r = device.pollDeviceAuth(made.deviceCode, { appId: APP.id })
  assert.equal(r.userId, 'u_first')
})

await check('⚠️ scope 不静默降级（和 client_credentials 同一条规矩）', async () => {
  device.resetDeviceAuths()
  const r = await askDevice('library.read this.is.not.a.scope')
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'invalid_scope')

  /*
    ⚠️ 这一条要**批过的和没批过的混着要**，不能只要一个没批过的。

    只要 `saves.write` 的话，「静默降级」的实现过滤完是空集，接着撞上
    「这个应用没有任何已获批的权限」那道判断，照样回 invalid_scope ——
    测试绿，而 bug 还在（变异测试实测）。
    混着要才分得开：降级的实现会把 library.read 发出去，装作一切正常。
  */
  const mixed = await askDevice('library.read saves.write') // APP 批了前者，没批后者
  assert.equal(mixed.status, 400, '少给了一个 scope 却照发了码 —— 接入方要到线上功能失效才发现')
  assert.equal((await mixed.json()).error, 'invalid_scope')

  const r2 = await askDevice('saves.write', APP2.id) // APP2 压根没批 saves.write
  assert.equal((await r2.json()).error, 'invalid_scope')
})

console.log('\n九、用户数据：library / saves（只读）')

/** 走完整条设备码流程拿一枚用户级令牌 */
const userToken = async (scope) => {
  device.resetDeviceAuths()
  const { device_code, user_code } = await (await askDevice(scope)).json()
  device.approveDeviceAuth(user_code, USER_ID)
  const j = await (await pollDevice(device_code)).json()
  assert.ok(j.access_token, `拿不到用户令牌：${JSON.stringify(j)}`)
  return j.access_token
}
const asUser = async (path, token) => api(path, { headers: { Authorization: `Bearer ${token}` } })
const postAsUser = async (path, token) => api(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })

await check('/v1/library 回收藏和最近在玩，而且是完整的游戏对象', async () => {
  const t = await userToken('library.read')
  const r = await asUser('/api/open/v1/library?lang=zh-Hans', t)
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.favorites[0].slug, 'contra')
  assert.equal(j.favorites[0].title, '魂斗罗', '只回了 slug —— 接入方还得再发十次请求去换标题')
  assert.equal(j.recent[0].slug, 'contra')
  assert.equal(j.favorites_total, 1)
})

await check('⚠️ 用户数据也走对外白名单，不能漏内部字段', async () => {
  const t = await userToken('library.read')
  const j = await (await asUser('/api/open/v1/library', t)).json()
  const text = JSON.stringify(j)
  for (const k of FORBIDDEN_OUT_KEYS) {
    assert.ok(!text.includes(`"${k}"`), `library 里漏了内部字段 ${k}`)
  }
})

await check('其它设备真开玩后会计数；同账号换设备或重试不会重复加', async () => {
  PLAY_ROWS.clear()
  const before = GAME.plays
  try {
    // 两枚令牌代表同一账号在两台设备上分别完成了一次设备码授权。
    const firstDevice = await userToken('library.write')
    const secondDevice = await userToken('library.write')
    const first = await postAsUser('/api/open/v1/games/contra/play', firstDevice)
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true, counted: true })
    const repeated = await postAsUser('/api/open/v1/games/contra/play', secondDevice)
    assert.equal(repeated.status, 200)
    assert.deepEqual(await repeated.json(), { ok: true, counted: false })
    assert.equal(GAME.plays, before + 1, '同一账号在两台设备上把次数加了两遍')
    assert.match(repeated.headers.get('cache-control') ?? '', /no-store/)
  } finally {
    GAME.plays = before
    PLAY_ROWS.clear()
  }
})

await check('游玩上报必须是带 library.write 的用户令牌，应用令牌不能冒充玩家', async () => {
  const readOnly = await userToken('library.read')
  const noScope = await postAsUser('/api/open/v1/games/contra/play', readOnly)
  assert.equal(noScope.status, 403)
  assert.equal((await noScope.json()).error, 'insufficient_scope')

  // 绕过正常取令牌流程，直接造一枚“有 scope 但 kind=app”的令牌，验证第二道门也在。
  const appOnly = issueAppToken({
    privateKey, kid: 'test-1', issuer: 'https://8bitgo.com', appId: APP.id, scopes: ['library.write'],
  })
  const noUser = await postAsUser('/api/open/v1/games/contra/play', appOnly)
  assert.equal(noUser.status, 403)
  assert.equal((await noUser.json()).error, 'insufficient_scope')
})

await check('游玩写接口不能用来探测下架、成人或不存在的游戏', async () => {
  const token = await userToken('library.write')
  for (const slug of ['secret-game', 'adult-game', 'does-not-exist']) {
    const r = await postAsUser(`/api/open/v1/games/${slug}/play`, token)
    assert.equal(r.status, 404, slug)
    assert.equal((await r.json()).error, 'not_found', slug)
  }
})

await check('Linux / 外部设备能用 live.write 换用途单一的长时段开播凭证', async () => {
  const access = await userToken('live.write')
  const r = await postAsUser('/api/open/v1/live/publish-token', access)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('cache-control') ?? '', /no-store/)
  const body = await r.json()
  assert.equal(body.protocol, '8bitgo-live-v1')
  assert.equal(body.namespace, '/live')
  assert.equal(body.auth_field, 'publisherToken')
  assert.equal(body.signaling_url, 'https://8bitgo.com/live')
  assert.equal(body.capacity_url, 'https://8bitgo.com/api/open/v1/live/capacity')
  assert.equal(body.ice_url, 'https://8bitgo.com/api/netplay/ice')
  assert.ok(body.expires_in >= 900)
  const claims = verifyLivePublisherToken(body.publisher_token, {
    publicKey,
    issuer: 'https://8bitgo.com',
  })
  assert.equal(claims?.userId, USER_ID)
  assert.equal(claims?.appId, APP.id)
  // 这枚票只能开播；REST access-token 验证器必须明确拒绝它。
  assert.equal(verifyOpenToken(body.publisher_token, { publicKey, issuer: 'https://8bitgo.com' }), null)
})

await check('开播凭证必须由带 live.write 的用户令牌领取', async () => {
  const wrongScope = await userToken('library.write')
  assert.equal((await postAsUser('/api/open/v1/live/publish-token', wrongScope)).status, 403)
  const appOnly = issueAppToken({
    privateKey, kid: 'test-1', issuer: 'https://8bitgo.com', appId: APP.id, scopes: ['live.write'],
  })
  assert.equal((await postAsUser('/api/open/v1/live/publish-token', appOnly)).status, 403)
})

await check('/v1/saves 只给元信息，不带存档内容', async () => {
  const t = await userToken('saves.read')
  const j = await (await asUser('/api/open/v1/saves', t)).json()
  assert.equal(j.items.length, 1)
  assert.equal(j.items[0].game_slug, 'contra')
  assert.equal(j.items[0].runtime, 'jsdos')
  assert.ok(!JSON.stringify(j).includes('SAVEDATA'), '清单里把存档内容也吐出来了')
})

await check('/v1/saves/:runtime/:slug 给二进制，而且不许被缓存', async () => {
  const t = await userToken('saves.read')
  const r = await asUser('/api/open/v1/saves/jsdos/contra?slot=0', t)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/octet-stream')
  assert.match(r.headers.get('cache-control') ?? '', /no-store/, '别人的存档被允许缓存了')
  assert.equal(await r.text(), 'SAVEDATA')
})

await check('存档坐标校验和站内共用同一份（未知引擎 -> 400）', async () => {
  const t = await userToken('saves.read')
  const r = await asUser('/api/open/v1/saves/not-an-engine/contra', t)
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'invalid_request')
})

await check('没有这份存档 -> 404', async () => {
  const t = await userToken('saves.read')
  const r = await asUser('/api/open/v1/saves/jsdos/contra?slot=3', t)
  assert.equal(r.status, 404)
})

await check('⚠️ scope 不够就进不去（library.read 的令牌读不了存档）', async () => {
  const t = await userToken('library.read')
  const r = await asUser('/api/open/v1/saves', t)
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'insufficient_scope')
})

await check('⚠️⚠️ 应用级令牌进不了用户数据接口，哪怕它带着那个 scope', async () => {
  /*
    这是纵深防御那一道。正常情况下 client_credentials 根本发不出带 user 级 scope 的令牌
    （那边挡着），所以这里得**自己伪造**一枚 kind='app' 却带着 saves.read 的令牌 ——
    也就是「上游那道哪天破了」的样子。

    为什么必须挡：kind 不是 user 的话 userId 是空串，而下面的查询全是
    `WHERE user_id = ?` —— 空串查出来是空集，看起来像「这个用户没有存档」，
    而真相是「这枚令牌背后压根没有用户」。静默给一个错的空结果，比报错糟得多。
  */
  const forged = jwtLib.sign(
    { iss: 'https://8bitgo.com', sub: APP.id, aud: APP.id, cid: APP.id, kind: 'app', scope: 'saves.read library.read' },
    privateKey,
    { algorithm: 'RS256', expiresIn: 600, header: { typ: 'at+jwt' } },
  )
  for (const path of ['/api/open/v1/saves', '/api/open/v1/library']) {
    const r = await asUser(path, forged)
    assert.equal(r.status, 403, `${path} 放了一枚应用级令牌进来`)
    assert.equal((await r.json()).error, 'insufficient_scope')
  }
})

console.log('\n十、授权码流程（RFC 6749 授权码 + PKCE）')

/*
  ## 这一节在守什么

  用户级令牌的另一条路：有浏览器的 Web 应用把用户重定向到 /open/authorize，
  用户点同意，浏览器带着 code 跳回应用的 redirect_uri，应用用 code + PKCE 换令牌。
  和 device.js 那条路一样最终调 issueUserToken，但中间多了「授权码 + 强制 PKCE」。

  守的是几件接入方必然写错、或安全边界的事：
    · 强制 PKCE（缺 challenge / 用 plain 一律 invalid_request）；
    · redirect_uri 必须命中白名单（否则成了开放重定向）；
    · 授权码一次性、PKCE 对不上就是 invalid_grant；
    · 沙箱应用对陌生账号，同意页 allowed=false、POST 真正 403。
*/

const ACCEPT_JSON = { Accept: 'application/json' }
const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64url')
const makePkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return { verifier, challenge: sha256b64(verifier) }
}
const authzGet = (q) =>
  api(`/api/oauth/authorize?${new URLSearchParams(q).toString()}`, { headers: { ...ACCEPT_JSON, ...userBearer() } })
/*
  ⚠️ POST 必须带上登录令牌。

  2026-09-12 之前这条路由**没有 requireUser**，所以这里不带令牌也能过 ——
  也就是说原来的用例在断言一个漏洞是「正常」的：那段代码会在没有任何身份证明的
  情况下，铸一枚指向某个 sub 的授权码。补上守卫之后不带令牌就是 401，这是对的。
  下面另有一条用例专门钉「不带令牌必须 401」。
*/
const authzPost = (body) =>
  api('/api/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ACCEPT_JSON, ...userBearer() },
    body: JSON.stringify(body),
  })
const CB = 'https://partner.example/cb'

await check('GET 同意页回应用信息和要申请的权限（JSON 形状）', async () => {
  const { challenge } = makePkce()
  const r = await authzGet({
    client_id: APP.id, redirect_uri: CB, response_type: 'code',
    scope: 'library.read saves.read', state: 'st1',
    code_challenge: challenge, code_challenge_method: 'S256',
  })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.client_id, APP.id)
  assert.equal(j.app.name, APP.name)
  assert.deepEqual(j.scopes.map((s) => s.id), ['library.read', 'saves.read'], '返回的 scope 和申请的不一致')
  assert.equal(j.allowed, true, 'live 应用应当允许任意用户授权')
})

await check('⚠️ 强制 PKCE：缺 code_challenge / method=plain -> invalid_request', async () => {
  const noChallenge = await authzGet({ client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read', state: 's' })
  assert.equal((await noChallenge.json()).error, 'invalid_request')
  const plain = await authzGet({ client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read', state: 's', code_challenge: 'abc', code_challenge_method: 'plain' })
  assert.equal((await plain.json()).error, 'invalid_request')
})

await check('⚠️ redirect_uri 不在白名单 -> invalid_redirect_uri（否则成了开放重定向）', async () => {
  const { challenge } = makePkce()
  const r = await authzGet({ client_id: APP.id, redirect_uri: 'https://evil.example/cb', response_type: 'code', scope: 'library.read', state: 's', code_challenge: challenge, code_challenge_method: 'S256' })
  assert.equal((await r.json()).error, 'invalid_redirect_uri')
})

await check('⚠️ 未知 scope -> invalid_scope', async () => {
  const { challenge } = makePkce()
  const r = await authzGet({ client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read noscope', state: 's', code_challenge: challenge, code_challenge_method: 'S256' })
  assert.equal((await r.json()).error, 'invalid_scope')
})

await check('完整的授权码 + PKCE 流程换来用户级令牌，并读得到用户数据', async () => {
  const { verifier, challenge } = makePkce()
  const q = { client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read saves.read', state: 'st2', code_challenge: challenge, code_challenge_method: 'S256' }
  assert.equal((await authzGet(q)).status, 200)
  const postR = await authzPost({ ...q, decision: 'approve' })
  assert.equal(postR.status, 200)
  const { code, state } = await postR.json()
  assert.ok(code, '同意页没发回授权码')
  assert.equal(state, 'st2', 'state 没原样带回来 —— 第三方挡不住 CSRF')
  const storedHash = crypto.createHash('sha256').update(code).digest('hex')
  assert.equal(OAUTH_CODES.has(code), false, '数据库里存了授权码明文')
  assert.ok(OAUTH_CODES.has(storedHash), '授权码没有以 SHA-256 形式落库，多实例之间无法共享')

  // 换令牌（机密客户端要 client_secret）
  const tokR = await api('/api/oauth/token', {
    method: 'POST',
    headers: FORM_CT,
    body: form({
      grant_type: 'authorization_code', client_id: APP.id, client_secret: APP_SECRET,
      code, code_verifier: verifier, redirect_uri: CB,
    }),
  })
  // ⚠️ 响应体只能读一次。断言消息里再 await 一次 .json() 会把它读空，
  // 于是下一行抛「Body has already been read」—— 真正的失败原因反而看不到了
  const tok = await tokR.json()
  assert.equal(tokR.status, 200, `换令牌失败：${JSON.stringify(tok)}`)
  assert.ok(tok.access_token)
  assert.equal(tok.token_type, 'Bearer')

  const me = await (await api('/api/open/v1/me', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()
  assert.equal(me.kind, 'user', '授权码换来的不是用户级令牌')
  assert.equal(me.user_id, USER_ID, '/v1/me 没报出这枚令牌是谁的')

  const lib = await (await api('/api/open/v1/library', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()
  assert.equal(lib.favorites[0].slug, 'contra', '用户级令牌读不到 library')
})

await check('⚠️ PKCE 对不上（verifier 错）-> invalid_grant', async () => {
  const { challenge } = makePkce()
  const wrongVerifier = makePkce().verifier
  const { code } = await (await authzPost({ client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve' })).json()
  const tokR = await api('/api/oauth/token', {
    method: 'POST', headers: FORM_CT,
    body: form({ grant_type: 'authorization_code', client_id: APP.id, client_secret: APP_SECRET, code, code_verifier: wrongVerifier, redirect_uri: CB }),
  })
  assert.equal((await tokR.json()).error, 'invalid_grant')
})

await check('⚠️ 授权码绑定 client_id + redirect_uri，串到别的应用或回调地址不能兑现', async () => {
  const { verifier, challenge } = makePkce()
  const q = { client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read', state: 's', code_challenge: challenge, code_challenge_method: 'S256' }
  const { code } = await (await authzPost({ ...q, decision: 'approve' })).json()

  // 以前这里会成功，并签出 cid=APP2、scope 却来自 APP 的混合令牌。
  const wrongApp = await api('/api/oauth/token', {
    method: 'POST', headers: FORM_CT,
    body: form({
      grant_type: 'authorization_code', client_id: APP2.id, client_secret: APP_SECRET,
      code, code_verifier: verifier, redirect_uri: CB,
    }),
  })
  assert.equal((await wrongApp.json()).error, 'invalid_grant')

  const wrongRedirect = await api('/api/oauth/token', {
    method: 'POST', headers: FORM_CT,
    body: form({
      grant_type: 'authorization_code', client_id: APP.id, client_secret: APP_SECRET,
      code, code_verifier: verifier, redirect_uri: 'https://partner.example/other',
    }),
  })
  assert.equal((await wrongRedirect.json()).error, 'invalid_grant')

  // 错误的兑换尝试不能替真正的客户端烧掉授权码。
  const correct = await api('/api/oauth/token', {
    method: 'POST', headers: FORM_CT,
    body: form({
      grant_type: 'authorization_code', client_id: APP.id, client_secret: APP_SECRET,
      code, code_verifier: verifier, redirect_uri: CB,
    }),
  })
  assert.equal(correct.status, 200, JSON.stringify(await correct.json()))
})

await check('⚠️ 授权码一次性：重放同一枚 code -> invalid_grant', async () => {
  const { verifier, challenge } = makePkce()
  const { code } = await (await authzPost({ client_id: APP.id, redirect_uri: CB, response_type: 'code', scope: 'library.read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve' })).json()
  const first = await api('/api/oauth/token', { method: 'POST', headers: FORM_CT, body: form({ grant_type: 'authorization_code', client_id: APP.id, client_secret: APP_SECRET, code, code_verifier: verifier, redirect_uri: CB }) })
  assert.equal(first.status, 200, `第一次换令牌就失败了：${JSON.stringify(await first.json())}`)
  const again = await api('/api/oauth/token', { method: 'POST', headers: FORM_CT, body: form({ grant_type: 'authorization_code', client_id: APP.id, client_secret: APP_SECRET, code, code_verifier: verifier, redirect_uri: CB }) })
  assert.equal((await again.json()).error, 'invalid_grant', '同一枚 code 被换出两枚令牌 —— 抄走它的人可以一直换')
})

await check('⚠️ 沙箱应用对未授权的账号：同意页 allowed=false，POST 真正 403', async () => {
  // APP2 是 sandbox：canAuthorize 只对开发者 / 测试账号放行，USER_ID 不是，所以不允许
  const { challenge } = makePkce()
  const j = await (await authzGet({ client_id: APP2.id, redirect_uri: 'https://partner2.example/cb', response_type: 'code', scope: 'games.read', state: 's', code_challenge: challenge, code_challenge_method: 'S256' })).json()
  assert.equal(j.allowed, false, '沙箱应用对陌生账号也放行了')
  const postR = await authzPost({ client_id: APP2.id, redirect_uri: 'https://partner2.example/cb', response_type: 'code', scope: 'games.read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve' })
  assert.equal(postR.status, 403)
  assert.equal((await postR.json()).error, 'access_denied')
})


console.log('\n十一、自发现：JWKS + RFC 8414（刻意不提供 openid-configuration）')

/*
  ## 这一节在守什么

  2026-09-13 核对：docs/open-platform.md §2.1 登记了 6 个 OIDC 端点，
  而 oauth.js 里**只有 3 条路由**，签出来的**只有 access_token**。
  也就是说 id_token / userinfo / revoke / refresh_token 四样都不存在，
  jwks.json 和 openid-configuration 也不存在（jwkFromPublicKey 一个调用点都没有）。

  这一节把新补的两条钉住，同时钉住那条**故意不做**的：
  提供一份 openid-configuration 会让接入方的 OIDC 库去要 id_token、去调 userinfo，
  然后在一个和真正原因毫无关系的地方失败。一个诚实的 404 比一份撒谎的发现文档好。
*/

const { wellKnownRouter } = await import('../src/routes/well-known.js')
const { jwksFor } = await import('../src/open/discovery.js')
const wkApp = express()
wkApp.use('/.well-known', wellKnownRouter)
const wkServer = wkApp.listen(0)
await new Promise((r) => wkServer.once('listening', r))
const wk = (p) => fetch(`http://127.0.0.1:${wkServer.address().port}/.well-known/${p}`)

await check('JWKS 发得出来，而且 kid / alg 和签令牌用的那把对得上', async () => {
  const r = await wk('jwks.json')
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.keys.length, 1)
  const k = body.keys[0]
  assert.equal(k.kid, 'test-1', 'kid 和 OPEN_JWT_KID 对不上，接入方按 kid 选不中这把')
  assert.equal(k.alg, 'RS256')
  assert.equal(k.use, 'sig')
  assert.ok(k.n && k.e, '没有 n / e，这不是一把能用的 RSA 公钥')
})

await check('⚠️ JWKS 的字段集合被钉死（哪怕喂进去的是私钥）', () => {
  /*
    ⚠️ 这条原来叫「绝不能出现私钥字段」，理由写的是「展开写法会漏 d / p / q」。
    **那个理由是错的**：变异测试把挑字段换成 `{ ...jwk }`，测试照样全绿 ——
    因为 `createPublicKey()` 喂进去私钥 PEM 也只导出 kty / n / e。
    那条断言当时是在测一件不可能发生的事。

    真正值得钉的是**字段集合本身**：这个响应是公开、可缓存的，
    多一个没人审过的字段就是多一分信息外泄面。将来 Node 给 jwk 导出加了字段时，
    这一条会红，逼人去看一眼那是什么 —— 这才是它的作用。
  */
  const fromPrivate = jwksFor({ publicKey: privateKey, kid: 'x', createPublicKey: crypto.createPublicKey })
  assert.deepEqual(Object.keys(fromPrivate.keys[0]).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use'])
  const fromPublic = jwksFor({ publicKey, kid: 'x', createPublicKey: crypto.createPublicKey })
  assert.deepEqual(fromPrivate.keys[0].n, fromPublic.keys[0].n, '私钥和公钥导出的模数应该一样')
})

await check('JWKS 里那把公钥真的验得过我们签的令牌（端到端）', async () => {
  const { access_token } = await getToken('games.read')
  const k = (await (await wk('jwks.json')).json()).keys[0]
  // 用 JWKS 里的 JWK 重建公钥，再去验一枚真的令牌 —— 对不上就是发了把没用的钥匙
  const pub = crypto.createPublicKey({ key: k, format: 'jwk' })
  const payload = jwtLib.verify(access_token, pub, { algorithms: ['RS256'] })
  assert.equal(payload.cid, APP.id)
})

await check('开放平台没启用时 JWKS 回 503 而不是 404（404 的意思是「没这东西」）', async () => {
  const { resetOpenConfig } = await import('../src/open/config.js')
  const saved = process.env.OPEN_JWT_PRIVATE_KEY
  delete process.env.OPEN_JWT_PRIVATE_KEY
  resetOpenConfig()
  try {
    const r = await wk('jwks.json')
    assert.equal(r.status, 503, `回了 ${r.status}`)
    assert.match(String(r.headers.get('cache-control')), /no-store/, '把「暂时不可用」缓存起来了')
  } finally {
    process.env.OPEN_JWT_PRIVATE_KEY = saved
    resetOpenConfig()
  }
})

await check('⚠️ 元数据里**每一个** endpoint 都指向真实存在的路由', async () => {
  /*
    这才是这份文档唯一的价值：接入方的库会照着它发请求。
    登记一个不存在的地址，对方得到的是 404，而 404 说的是「你路径写错了」——
    真相却是「我们文档写错了」。

    ⚠️ 原来这条只挑了两个端点手工核对，于是**加一个凭空捏造的
    `introspection_endpoint` 照样全绿**（变异测试实测）。改成遍历所有 *_endpoint。
  */
  const m = await (await wk('oauth-authorization-server')).json()
  assert.equal(m.issuer, 'https://8bitgo.com')
  assert.deepEqual(m.code_challenge_methods_supported, ['S256'], 'PKCE 是强制的，且不收 plain')
  assert.ok(m.grant_types_supported.includes('client_credentials'))
  assert.ok(m.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'))

  const fs = await import('node:fs')
  const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'))
  /** 真实路由表：挂载前缀 -> 那个文件里声明的路径 */
  const routes = new Set()
  const collect = (prefix, src, re) => {
    for (const mm of src.matchAll(re)) routes.add(prefix + mm[1])
  }
  collect('/api/oauth', read('../src/routes/oauth.js'), /oauthRouter\.(?:get|post)\(\s*'([^']+)'/g)
  collect('/api/open', read('../src/routes/open.js'), /openRouter\.(?:get|post)\(\s*'([^']+)'/g)
  collect('/.well-known', read('../src/routes/well-known.js'), /wellKnownRouter\.get\(\s*'([^']+)'/g)
  // /oauth/authorize 是**前端路由**（SSR catch-all 兜住），不在 Express 里
  const appRoutes = fs.readFileSync(new URL('../../src/AppRoutes.tsx', import.meta.url), 'utf8')
  for (const mm of appRoutes.matchAll(/path="(\/open\/[a-z-]+)"/g)) routes.add(mm[1])

  assert.ok(routes.size >= 15, `只认出 ${routes.size} 条路由，正则漂了`)

  const endpoints = Object.entries(m).filter(([k]) => k.endsWith('_endpoint') || k.endsWith('_uri'))
  assert.ok(endpoints.length >= 4, `只有 ${endpoints.length} 个端点字段，断言的前提没了`)
  for (const [key, url] of endpoints) {
    const path = String(url).replace('https://8bitgo.com', '')
    assert.ok(routes.has(path), `元数据的 ${key} 指向 ${path}，但源码里没有这条路由`)
  }
})

await check('⚠️ 元数据明说不支持 id_token / userinfo / refresh / revoke（它们真的不存在）', async () => {
  const m = await (await wk('oauth-authorization-server')).json()
  assert.deepEqual(m['x-not-supported'].sort(), ['id_token', 'refresh_token', 'revocation', 'userinfo'])
  // 反向核对：这四样在源码里确实一个都没有。哪天做了，要把它从这张「不支持」名单里拿掉
  const oauthSrc = stripComments((await import('node:fs')).readFileSync(new URL('../src/routes/oauth.js', import.meta.url), 'utf8'))
  assert.ok(!oauthSrc.includes('id_token'), 'id_token 已经做了，元数据还在说不支持')
  assert.ok(!oauthSrc.includes('refresh_token'), 'refresh_token 已经做了，元数据还在说不支持')
  assert.ok(!/userinfo|\/revoke/.test(oauthSrc), 'userinfo / revoke 已经做了，元数据还在说不支持')
})

await check('⚠️ 刻意不提供 openid-configuration（撒谎的发现文档比没有更糟）', async () => {
  assert.equal((await wk('openid-configuration')).status, 404)
  const src = stripComments((await import('node:fs')).readFileSync(new URL('../src/routes/well-known.js', import.meta.url), 'utf8'))
  assert.ok(!src.includes('openid-configuration'), '加上了 openid-configuration —— 先把 id_token / userinfo 做出来再说')
})

await check('这两条放开到任意 Origin，且元数据不依赖密钥（没启用时也回）', async () => {
  const r = await wk('oauth-authorization-server')
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  const { resetOpenConfig } = await import('../src/open/config.js')
  const saved = process.env.OPEN_JWT_PRIVATE_KEY
  delete process.env.OPEN_JWT_PRIVATE_KEY
  resetOpenConfig()
  try {
    // 它只是一张地址表 —— 没配密钥时照样该回，接入方正好知道该往哪儿发
    assert.equal((await wk('oauth-authorization-server')).status, 200)
  } finally {
    process.env.OPEN_JWT_PRIVATE_KEY = saved
    resetOpenConfig()
  }
})

wkServer.close()

server.close()
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
