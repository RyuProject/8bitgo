/**
 * 开放平台的**申请 → 审核 → 发 key** 全流程自检。真的起 express、真的跑路由，
 * db.js 换成一个按 SQL 形状应答的内存假库。
 *
 * 用法：cd server && npm run test:open-apps
 *
 * 这一块的错误后果都很重，而且多数在手测时看不出来：
 *
 *   1. **敏感 scope 自助拿到手** —— 建应用时顺手把 requested 当成 approved，
 *      于是任何人注册个号就能领 ROM 凭据。审核这一层当场作废。
 *   2. **审核中还能改权限** —— 提交后把 scope 换成 saves.write，审核人批的是他看到的那一版，
 *      生效的是改过的那一版。「审的是 A、批的是 B」。
 *   3. **打回顺手清掉已批的 scope** —— 被打回一次连沙箱调试环境一起没了。
 *   4. **恢复一律回 live** —— 从沙箱被停用的应用，恢复之后直接进生产，绕过审核。
 *   5. **撤销最后一把 key** —— 应用彻底没法换令牌，而界面上看不出为什么。
 *   6. **别人的应用能看能改** —— 而且 403 会顺带确认「这个 id 存在」。
 */
import assert from 'node:assert/strict'
import express from 'express'
import { register } from 'node:module'

/* ---------------- 内存假库 ---------------- */

const STUB = 'data:text/javascript,' + encodeURIComponent(`
  export const pool = null
  export async function query(sql, params) { return globalThis.__fakeDb.query(sql, params) }
  export async function queryOne(sql, params) { const r = await globalThis.__fakeDb.query(sql, params); return Array.isArray(r) ? r[0] : r }
  export async function ping() { return true }
  export async function withTransaction(fn) { return fn({ query: (s, p) => globalThis.__fakeDb.query(s, p) }) }
  export function jsonMemberPath(n) { return n }
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

const DB = { users: [], apps: [], secrets: [], reviews: [], testers: [] }
let reviewSeq = 0
const clone = (o) => ({ ...o })

/** 极小的 SQL 应答器。只认这几个路由真正发出的形状 —— 认不出来一律抛，别静默返回空 */
globalThis.__fakeDb = {
  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim()
    const p = params

    if (q.startsWith('SELECT * FROM users WHERE id')) return DB.users.filter((u) => u.id === p[0])
    if (q.startsWith('SELECT id, status FROM users WHERE email')) return DB.users.filter((u) => u.email === p[0])
    if (q.startsWith('SELECT COUNT(*) AS n FROM oauth_apps WHERE owner_id')) {
      return [{ n: DB.apps.filter((a) => a.owner_id === p[0]).length }]
    }
    if (q.startsWith('SELECT COUNT(*) AS n FROM oauth_app_testers WHERE app_id')) {
      return [{ n: DB.testers.filter((t) => t.app_id === p[0]).length }]
    }
    if (/^SELECT .* FROM oauth_apps WHERE id = \?/.test(q)) return DB.apps.filter((a) => a.id === p[0]).map(clone)
    if (/^SELECT .* FROM oauth_apps WHERE owner_id = \?/.test(q)) {
      return DB.apps.filter((a) => a.owner_id === p[0]).map(clone)
    }
    if (/^SELECT .* FROM oauth_apps a LEFT JOIN users u ON u\.id = a\.owner_id WHERE a\.id = \?/.test(q)) {
      return DB.apps.filter((a) => a.id === p[0]).map((a) => {
        const u = DB.users.find((it) => it.id === a.owner_id)
        return { ...a, owner_nickname: u?.nickname ?? '', owner_email: u?.email ?? '' }
      })
    }
    if (/^SELECT .* FROM oauth_apps a LEFT JOIN users u/.test(q)) {
      let rows = DB.apps.map(clone)
      /*
        ⚠️ 照着 SQL 说的做。假库替被测代码把 review_state 筛掉的话，
        路由里的过滤条件被删了测试也照样绿 —— 这个仓库在别处实测踩过。
      */
      let i = 0
      if (q.includes('a.review_state = ?')) {
        const want = p[i++]
        rows = rows.filter((a) => a.review_state === want)
      }
      if (q.includes('a.status = ?')) {
        const want = p[i++]
        rows = rows.filter((a) => a.status === want)
      }
      /*
        ⚠️ **照着 SQL 的 ORDER BY 排**，别自己定顺序。
        这里原来无条件升序，于是把路由里的 ORDER BY 改成 DESC 测试也照样绿
        （变异检查实测）。假库替被测代码做事 = 那部分代码等于没测 —— 同一个坑
        这个仓库今天已经踩过第二次了（见「假库不能替被测代码做事」）。
      */
      const asc = /a\.submitted_at ASC/.test(q)
      const nullsLast = /a\.submitted_at IS NULL/.test(q)
      rows.sort((x, y) => {
        const a = x.submitted_at ?? null
        const b = y.submitted_at ?? null
        if (nullsLast && (a === null) !== (b === null)) return a === null ? 1 : -1
        /*
          ⚠️ 按**时间戳**比，别按字符串。submitted_at 在这个假库里是 Date 对象
          （路由传的就是 new Date()），而 `String(new Date())` 是「Wed Sep 11 2026 01:23:45」
          这种秒级、且字典序和时间序无关的格式 —— 同一秒里提交的两条排出来完全一样，
          于是升序降序看不出差别（变异检查里就是这么假绿的）。
        */
        const cmp = new Date(a ?? 0).getTime() - new Date(b ?? 0).getTime()
        return asc ? cmp : -cmp
      })
      return rows.map((a) => {
        const u = DB.users.find((it) => it.id === a.owner_id)
        return { ...a, owner_nickname: u?.nickname ?? '', owner_email: u?.email ?? '' }
      })
    }
    if (q.startsWith('INSERT INTO oauth_apps')) {
      /*
        ⚠️ 列和 VALUES 要**按位置逐个对**，不能拿 params 从头往列上铺 ——
        这条 INSERT 的 VALUES 里混着字面量（'sandbox' / 'none' / NOW()），
        占位符比列少 4 个。铺错的结果是 status 被写成 undefined，
        而症状是「建出来的应用没有状态」，一路串到十几条断言（实测踩过）。
      */
      const cols = q.slice(q.indexOf('(') + 1, q.indexOf(')')).split(',').map((c) => c.trim().replace(/`/g, ''))
      const vals = q.slice(q.indexOf('VALUES (') + 8, q.lastIndexOf(')')).split(',').map((v) => v.trim())
      const row = {}
      let pi = 0
      cols.forEach((c, i) => {
        const v = vals[i]
        if (v === '?') row[c] = p[pi++]
        else if (v === 'NOW()') row[c] = new Date().toISOString()
        else row[c] = v.replace(/^'|'$/g, '')
      })
      DB.apps.push(row)
      return { affectedRows: 1 }
    }
    if (q.startsWith('UPDATE oauth_apps SET')) {
      const keys = [...q.matchAll(/`([a-z_]+)` = \?/g)].map((m) => m[1])
      const row = DB.apps.find((a) => a.id === p[p.length - 1])
      if (!row) return { affectedRows: 0 }
      keys.forEach((k, i) => (row[k] = p[i]))
      return { affectedRows: 1 }
    }
    if (q.startsWith('INSERT INTO oauth_app_secrets')) {
      DB.secrets.push({ id: p[0], app_id: p[1], secret_hash: p[2], hint: p[3], created_at: new Date().toISOString(), revoked_at: null, last_used_at: null })
      return { affectedRows: 1 }
    }
    if (q.startsWith('SELECT id FROM oauth_app_secrets WHERE app_id = ? AND revoked_at IS NULL')) {
      return DB.secrets.filter((s) => s.app_id === p[0] && !s.revoked_at).map((s) => ({ id: s.id }))
    }
    if (/^SELECT id, hint, created_at/.test(q)) return DB.secrets.filter((s) => s.app_id === p[0]).map(clone)
    if (q.startsWith('UPDATE oauth_app_secrets SET revoked_at')) {
      const s = DB.secrets.find((x) => x.app_id === p[0] && x.id === p[1] && !x.revoked_at)
      if (!s) return { affectedRows: 0 }
      s.revoked_at = new Date().toISOString()
      return { affectedRows: 1 }
    }
    if (q.startsWith('INSERT INTO oauth_app_reviews')) {
      DB.reviews.push({ id: ++reviewSeq, app_id: p[0], actor_id: p[1], action: p[2], detail: p[3], created_at: new Date().toISOString() })
      return { affectedRows: 1 }
    }
    if (/^SELECT r\.id, r\.action/.test(q)) {
      return DB.reviews
        .filter((r) => r.app_id === p[0])
        .sort((a, b) => b.id - a.id)
        .map((r) => ({ ...r, actor_nickname: DB.users.find((u) => u.id === r.actor_id)?.nickname ?? '' }))
    }
    if (/^SELECT t\.user_id/.test(q)) {
      return DB.testers.filter((t) => t.app_id === p[0]).map((t) => {
        const u = DB.users.find((it) => it.id === t.user_id)
        return { ...t, nickname: u?.nickname ?? '', email: u?.email ?? '' }
      })
    }
    if (q.startsWith('INSERT IGNORE INTO oauth_app_testers')) {
      if (!DB.testers.some((t) => t.app_id === p[0] && t.user_id === p[1])) {
        DB.testers.push({ app_id: p[0], user_id: p[1], added_at: new Date().toISOString() })
      }
      return { affectedRows: 1 }
    }
    if (q.startsWith('DELETE FROM oauth_app_testers')) {
      const before = DB.testers.length
      DB.testers = DB.testers.filter((t) => !(t.app_id === p[0] && t.user_id === p[1]))
      return { affectedRows: before - DB.testers.length }
    }
    if (q.startsWith('SELECT 1 AS x FROM oauth_app_testers')) {
      return DB.testers.filter((t) => t.app_id === p[0] && t.user_id === p[1]).map(() => ({ x: 1 }))
    }
    throw new Error(`假库不认识这条 SQL：${q.slice(0, 90)}`)
  },
}

process.env.JWT_SECRET = 'test-secret'
delete process.env.ADMIN_AUTH_DISABLED
delete process.env.ADMIN_TOKEN

const { openAppsRouter } = await import('../src/routes/open-apps.js')
const { adminOpenAppsRouter } = await import('../src/routes/admin-open-apps.js')
const { signToken } = await import('../src/auth.js')
const { canAuthorize, getApp } = await import('../src/open/apps-repo.js')

DB.users.push(
  { id: 'u_dev', email: 'dev@example.com', nickname: '开发者', role: 'user', status: 'active', token_version: 0 },
  { id: 'u_admin', email: 'admin@example.com', nickname: '管理员', role: 'admin', status: 'active', token_version: 0 },
  { id: 'u_vol', email: 'vol@example.com', nickname: '志愿者', role: 'volunteer', status: 'active', token_version: 0 },
  { id: 'u_t1', email: 't1@example.com', nickname: '测试1', role: 'user', status: 'active', token_version: 0 },
  { id: 'u_t2', email: 't2@example.com', nickname: '测试2', role: 'user', status: 'active', token_version: 0 },
  { id: 'u_other', email: 'other@example.com', nickname: '路人', role: 'user', status: 'active', token_version: 0 },
  { id: 'u_banned', email: 'banned@example.com', nickname: '被封', role: 'user', status: 'banned', token_version: 0 },
  // ⚠️ 这个账号**不进任何测试名单**，专门用来验「沙箱不认的人」。
  // 拿 u_other 验的话，它一旦被加进白名单（凑测试号上限那条用例），断言就会假红
  { id: 'u_stranger', email: 'stranger@example.com', nickname: '陌生人', role: 'user', status: 'active', token_version: 0 },
  // 应用数上限那条用例专用：建应用有按账号的限流，和别的用例挤在一个号上会先撞限流
  { id: 'u_dev2', email: 'dev2@example.com', nickname: '开发者二号', role: 'user', status: 'active', token_version: 0 },
)
const TOK = {
  dev: signToken('u_dev', 0),
  admin: signToken('u_admin', 0),
  vol: signToken('u_vol', 0),
  other: signToken('u_other', 0),
  stranger: signToken('u_stranger', 0),
  dev2: signToken('u_dev2', 0),
}

const app = express()
app.use(express.json())
app.use('/api/open-apps', openAppsRouter)
app.use('/api/admin/open-apps', adminOpenAppsRouter)
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const call = async (method, path, { who = 'dev', body } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${TOK[who]}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await r.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON（不该出现），留着 text 供断言 */
  }
  return { status: r.status, body: json, text }
}

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

const LONG_NOTE = '我在做一个红白机游戏的聚合导航站，想把 8BitGo 的游戏库嵌进去让访客直接玩，同时用 8BitGo 账号登录同步收藏。'

console.log('\n一、建应用：当场进沙箱，当场发一把 key')

let APP_ID = ''
await check('⚠️ 敏感 scope 自助拿不到，只进「申请中」', async () => {
  const r = await call('POST', '/api/open-apps', {
    body: { name: '聚合导航站', scopes: 'games.read games.rom openid', homepage: 'https://partner.example' },
  })
  assert.equal(r.status, 201)
  APP_ID = r.body.app.id
  assert.match(APP_ID, /^app_[0-9a-f]{24}$/)
  assert.equal(r.body.app.status, 'sandbox')
  assert.deepEqual(r.body.app.approvedScopes, ['games.read'], '自助只该拿到 games.read')
  assert.ok(r.body.app.requestedScopes.includes('games.rom'), 'games.rom 要记进申请单')
  assert.ok(!r.body.app.approvedScopes.includes('games.rom'), 'games.rom 竟然自助就批了')
})

await check('⚠️ AppKey 只在这一刻出现，之后任何接口都取不回来', async () => {
  const r = await call('POST', '/api/open-apps', { body: { name: '第二个应用' } })
  assert.ok(r.body.secret && r.body.secret.length >= 32, '创建时要返回明文 key')
  assert.match(String(r.body.secretNotice), /唯一一次/)
  const detail = await call('GET', `/api/open-apps/${r.body.app.id}`)
  const blob = JSON.stringify(detail.body)
  assert.ok(!blob.includes(r.body.secret), '详情接口把 key 明文又发了一遍')
  assert.ok(!blob.includes('secret_hash') && !blob.includes('$2'), '哈希也不能出去')
  assert.ok(detail.body.secrets[0].hint, '只给末 6 位提示位')
})

await check('公开客户端不发 key（前端藏不住密钥）', async () => {
  const r = await call('POST', '/api/open-apps', { body: { name: '纯前端应用', clientType: 'public' } })
  assert.equal(r.body.secret, '')
  const again = await call('POST', `/api/open-apps/${r.body.app.id}/secrets`)
  assert.equal(again.body.code, 'public_client')
})

await check('回调地址要校验：生产 https、不许带 #、沙箱放行 localhost', async () => {
  const bad1 = await call('POST', '/api/open-apps', { body: { name: '回调校验', redirectUris: ['https://a.com/cb#x'] } })
  assert.equal(bad1.body.code, 'bad_redirect')
  const bad2 = await call('POST', '/api/open-apps', { body: { name: '回调校验', redirectUris: ['http://partner.example/cb'] } })
  assert.equal(bad2.body.code, 'bad_redirect', 'http（非 localhost）应该被拒')
  const ok = await call('POST', '/api/open-apps', { body: { name: '回调校验', redirectUris: ['http://localhost:5173/cb'] } })
  assert.equal(ok.status, 201, '沙箱要放行 http://localhost，否则本机开发根本没法调')
})

await check('⚠️ 别人的应用一律 404，不是 403（403 会确认这个 id 存在）', async () => {
  const r = await call('GET', `/api/open-apps/${APP_ID}`, { who: 'other' })
  assert.equal(r.status, 404)
  const w = await call('PATCH', `/api/open-apps/${APP_ID}`, { who: 'other', body: { name: '改了' } })
  assert.equal(w.status, 404)
})

console.log('\n二、提交上产申请')

await check('说明太短的申请退回（一句「做个站」审不了）', async () => {
  const r = await call('POST', `/api/open-apps/${APP_ID}/submit`, { body: { note: '做个站' } })
  assert.equal(r.body.code, 'note_too_short')
})

await check('⚠️ 申请登录类权限必须先有 https 回调地址', async () => {
  const r = await call('POST', `/api/open-apps/${APP_ID}/submit`, { body: { note: LONG_NOTE } })
  assert.equal(r.body.code, 'no_redirect')
})

await check('⚠️ 沙箱的 http://localhost 回调不能带上产（这是最常见的一种漏配）', async () => {
  /*
    localhost 在沙箱是刚需（本机开发没有 https），但带到生产环境就是个洞：
    授权码会被重定向到发起人本机的任意端口上，而那台机器不是我们能担保的。
  */
  const made = await call('POST', '/api/open-apps', {
    body: { name: '本机调试应用', scopes: 'games.read openid', redirectUris: ['http://localhost:5173/cb'] },
  })
  const r = await call('POST', `/api/open-apps/${made.body.app.id}/submit`, { body: { note: LONG_NOTE } })
  assert.equal(r.body.code, 'insecure_redirect', 'http://localhost 竟然能带上产')
})

await check('补上回调之后能提交，且沙箱**照旧可用**', async () => {
  await call('PATCH', `/api/open-apps/${APP_ID}`, { body: { redirectUris: ['https://partner.example/cb'] } })
  const r = await call('POST', `/api/open-apps/${APP_ID}/submit`, { body: { note: LONG_NOTE } })
  assert.equal(r.status, 200)
  assert.equal(r.body.app.reviewState, 'pending')
  /*
    ⚠️ status 必须还是 sandbox。把两个状态合成一个枚举（…pending…）的话，
    「这个应用能不能用」的判断会跟着变，症状是「一提交申请，正在调试的东西当场全断」。
  */
  assert.equal(r.body.app.status, 'sandbox', '提交申请不该让沙箱停摆')
})

await check('⚠️ 审核中不能改权限相关字段（否则「审的是 A、批的是 B」）', async () => {
  for (const patch of [{ scopes: 'saves.write' }, { redirectUris: ['https://evil.example/cb'] }, { embedOrigins: ['https://evil.example'] }]) {
    const r = await call('PATCH', `/api/open-apps/${APP_ID}`, { body: patch })
    assert.equal(r.status, 409, `${Object.keys(patch)[0]} 在审核中竟然改得动`)
    assert.equal(r.body.code, 'locked_while_pending')
  }
})

await check('审核中可以改名字 / 简介（它们不影响权限）', async () => {
  const r = await call('PATCH', `/api/open-apps/${APP_ID}`, { body: { name: '聚合导航站 v2' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.app.name, '聚合导航站 v2')
})

await check('重复提交会被挡下', async () => {
  const r = await call('POST', `/api/open-apps/${APP_ID}/submit`, { body: { note: LONG_NOTE } })
  assert.equal(r.body.code, 'already_pending')
})

console.log('\n三、审核：谁能审、能批什么')

await check('⚠️ 普通用户和志愿者都进不了审核接口', async () => {
  for (const who of ['dev', 'vol']) {
    const r = await call('GET', '/api/admin/open-apps', { who })
    assert.equal(r.status, 403, `${who} 竟然能看审核队列`)
    assert.match(String(r.body.error), /apps:review/, '403 要说清缺哪个权限点')
  }
})

await check('队列按提交时间正序（先交的先审）', async () => {
  /*
    ⚠️ 必须有**两个以上**在排队、而且提交时间不同，这条断言才有意义。
    只有一条时 `times === times.sort()` 恒真 —— 把 ORDER BY 改成 DESC 也照样绿（实测过）。
  */
  const later = await call('POST', '/api/open-apps', { body: { name: '后交的应用' } })
  await new Promise((r) => setTimeout(r, 15))
  await call('POST', `/api/open-apps/${later.body.app.id}/submit`, { body: { note: LONG_NOTE } })

  const r = await call('GET', '/api/admin/open-apps', { who: 'admin' })
  assert.equal(r.status, 200)
  const times = r.body.items.map((it) => it.submittedAt)
  assert.ok(times.length >= 2, '这条用例需要至少两个待审申请')
  assert.deepEqual(times, [...times].sort(), '队列顺序反了 —— 早上交的会永远压在下面')
  assert.ok(r.body.items.every((it) => it.reviewState === 'pending'), '默认只该给 pending')
})

await check('⚠️ 申请单里的敏感项要标出来', async () => {
  const r = await call('GET', `/api/admin/open-apps/${APP_ID}`, { who: 'admin' })
  assert.deepEqual(r.body.sensitive, ['games.rom'])
  assert.equal(r.body.app.reviewNote, LONG_NOTE, '审核人要能读到用途说明')
  assert.ok(r.body.app.owner.email.includes('***'), '邮箱不必给全')
})

await check('⚠️ 不能批申请单里没有的 scope', async () => {
  const r = await call('POST', `/api/admin/open-apps/${APP_ID}/approve`, { who: 'admin', body: { scopes: 'games.read saves.write' } })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'scope_not_requested')
})

await check('⚠️ 打回必须写理由，理由原样给申请人看', async () => {
  const noReason = await call('POST', `/api/admin/open-apps/${APP_ID}/reject`, { who: 'admin', body: {} })
  assert.equal(noReason.body.code, 'no_reason')
  const r = await call('POST', `/api/admin/open-apps/${APP_ID}/reject`, { who: 'admin', body: { reason: '首页打不开，先把站部署上线再来' } })
  assert.equal(r.body.app.reviewState, 'rejected')
  const mine = await call('GET', `/api/open-apps/${APP_ID}`)
  assert.equal(mine.body.app.reviewReason, '首页打不开，先把站部署上线再来')
})

await check('⚠️ 打回**不动**已批的 scope（否则被打回一次连调试环境都没了）', async () => {
  const mine = await call('GET', `/api/open-apps/${APP_ID}`)
  assert.deepEqual(mine.body.app.approvedScopes, ['games.read'])
  assert.equal(mine.body.app.status, 'sandbox')
})

await check('打回之后能改、能再提交', async () => {
  const patch = await call('PATCH', `/api/open-apps/${APP_ID}`, { body: { scopes: 'games.read games.rom' } })
  assert.equal(patch.status, 200, '打回之后字段要解锁')
  const r = await call('POST', `/api/open-apps/${APP_ID}/submit`, { body: { note: LONG_NOTE + ' 站已经上线了。' } })
  assert.equal(r.body.app.reviewState, 'pending')
})

await check('批一部分是常态：批了的进 approved，没批的不进', async () => {
  const r = await call('POST', `/api/admin/open-apps/${APP_ID}/approve`, { who: 'admin', body: { scopes: 'games.read', note: 'ROM 先不给' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.app.status, 'live')
  assert.equal(r.body.app.reviewState, 'none')
  assert.deepEqual(r.body.app.approvedScopes, ['games.read'])
})

await check('⚠️ 审核留痕：谁、什么时候、批了什么', async () => {
  const r = await call('GET', `/api/admin/open-apps/${APP_ID}`, { who: 'admin' })
  const actions = r.body.reviews.map((x) => x.action)
  assert.deepEqual(actions, ['approve', 'submit', 'reject', 'submit'], '流水顺序或条目不对')
  const approve = r.body.reviews.find((x) => x.action === 'approve')
  assert.equal(approve.actor, '管理员', '要记得是谁批的')
  assert.match(approve.detail, /games\.read/, '要记下最终批了什么')
  const reject = r.body.reviews.find((x) => x.action === 'reject')
  assert.match(reject.detail, /首页打不开/, '打回理由要留痕')
})

console.log('\n四、停用与恢复')

await check('停用要写理由，且回包提醒「令牌还有 15 分钟」', async () => {
  const noReason = await call('POST', `/api/admin/open-apps/${APP_ID}/suspend`, { who: 'admin', body: {} })
  assert.equal(noReason.body.code, 'no_reason')
  const r = await call('POST', `/api/admin/open-apps/${APP_ID}/suspend`, { who: 'admin', body: { reason: '滥用 ROM 接口' } })
  assert.equal(r.body.app.status, 'suspended')
  assert.match(String(r.body.notice), /15 分钟/, '必须把「不是当场断」说出来')
})

await check('⚠️ 恢复要回到停用前那一档，不是一律回 live', async () => {
  const back = await call('POST', `/api/admin/open-apps/${APP_ID}/restore`, { who: 'admin' })
  assert.equal(back.body.app.status, 'live', '停用前是 live，恢复回 live')

  const made = await call('POST', '/api/open-apps', { body: { name: '沙箱应用' } })
  const id = made.body.app.id
  await call('POST', `/api/admin/open-apps/${id}/suspend`, { who: 'admin', body: { reason: '测试' } })
  const r = await call('POST', `/api/admin/open-apps/${id}/restore`, { who: 'admin' })
  assert.equal(r.body.app.status, 'sandbox', '从沙箱被停用的应用恢复成了 live —— 绕过了审核')
})

console.log('\n五、密钥轮换')

await check('最多两把并存；第三把报错而不是悄悄顶掉最旧的', async () => {
  const r1 = await call('POST', `/api/open-apps/${APP_ID}/secrets`)
  assert.equal(r1.status, 201)
  assert.match(String(r1.body.secretNotice), /旧的/, '要告诉他旧的还能用（轮换的全部意义）')
  const r2 = await call('POST', `/api/open-apps/${APP_ID}/secrets`)
  assert.equal(r2.body.code, 'too_many_secrets')
})

await check('⚠️ 撤销最后一把有效 key 要被挡下（否则应用彻底取不到令牌）', async () => {
  const detail = await call('GET', `/api/open-apps/${APP_ID}`)
  const active = detail.body.secrets.filter((s) => s.active)
  assert.equal(active.length, 2)
  const first = await call('DELETE', `/api/open-apps/${APP_ID}/secrets/${active[0].id}`)
  assert.equal(first.status, 200)
  const last = await call('DELETE', `/api/open-apps/${APP_ID}/secrets/${active[1].id}`)
  assert.equal(last.status, 409)
  assert.equal(last.body.code, 'last_secret')
})

console.log('\n六、沙箱白名单 —— 「先沙箱后审核」的立足点')

let SANDBOX_ID = ''
await check('加测试账号；上限 5 个', async () => {
  const made = await call('POST', '/api/open-apps', { body: { name: '待审应用' } })
  SANDBOX_ID = made.body.app.id
  const ok = await call('POST', `/api/open-apps/${SANDBOX_ID}/testers`, { body: { email: 't1@example.com' } })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.testers.length, 1)
  assert.ok(ok.body.testers[0].email.includes('***'))
})

await check('⚠️ 测试号有上限（沙箱只能给这么几个人授权）', async () => {
  const emails = ['t2@example.com', 'other@example.com', 'admin@example.com', 'vol@example.com']
  for (const email of emails) {
    const r = await call('POST', `/api/open-apps/${SANDBOX_ID}/testers`, { body: { email } })
    assert.equal(r.status, 201, `${email} 应该加得上（还没满）`)
  }
  // 这时已经 5 个（t1 + 上面 4 个），第 6 个必须被挡下
  const full = await call('POST', `/api/open-apps/${SANDBOX_ID}/testers`, { body: { email: 'dev@example.com' } })
  assert.equal(full.body.code, 'too_many', '测试号没有上限 —— 沙箱就不再是「只给几个人」了')
})

await check('⚠️ 查不到的邮箱和被封禁的账号回同一句话（否则成了账号探针）', async () => {
  const missing = await call('POST', `/api/open-apps/${SANDBOX_ID}/testers`, { body: { email: 'nobody@example.com' } })
  const banned = await call('POST', `/api/open-apps/${SANDBOX_ID}/testers`, { body: { email: 'banned@example.com' } })
  assert.equal(missing.status, 404)
  assert.equal(banned.status, 404)
  assert.deepEqual(missing.body, banned.body, '两种失败的响应不一样 —— 可以据此判断账号状态')
})

await check('⚠️ 沙箱应用只能授权给申请人自己和白名单（这是模型成立的关键）', async () => {
  const app2 = await getApp(SANDBOX_ID)
  assert.equal(await canAuthorize(app2, 'u_dev'), true, '申请人自己当然可以')
  assert.equal(await canAuthorize(app2, 'u_t1'), true, '白名单里的测试号可以')
  assert.equal(await canAuthorize(app2, 'u_stranger'), false, '路人不该能给一个没审过的应用授权（钓鱼）')
  assert.equal(await canAuthorize({ ...app2, status: 'live' }, 'u_stranger'), true, '上产之后不限授权对象')
  assert.equal(await canAuthorize({ ...app2, status: 'suspended' }, 'u_dev'), false, '停用的应用谁都不能授权')
})

await check('上产之后不再需要白名单', async () => {
  const r = await call('POST', `/api/open-apps/${APP_ID}/testers`, { body: { email: 't2@example.com' } })
  assert.equal(r.body.code, 'not_sandbox')
})

await check('一个账号最多 10 个应用', async () => {
  // 换一个干净的账号：建应用有按账号的限流，和前面的用例挤在同一个号上会先撞限流，
  // 于是这条断言看到的是 rate_limited 而不是 too_many_apps
  let last = null
  for (let i = 0; i < 12; i++) last = await call('POST', '/api/open-apps', { who: 'dev2', body: { name: `批量 ${i}` } })
  assert.equal(last.body.code, 'too_many_apps')
})

server.close()
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
