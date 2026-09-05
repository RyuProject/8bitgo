/**
 * PUT /api/me/birth-date 的自检 —— 成人内容年龄验证「填一次就锁定」这条规则。
 *
 * 为什么值得单独测：这条规则的全部力量都在**一句 SQL 的 WHERE 里**
 * （`UPDATE ... WHERE id = ? AND birth_date IS NULL`，再看 affectedRows）。
 * 把它写成「先 SELECT 看看填没填，再 UPDATE」在单机手测时表现完全一样，
 * 但两个标签页同时提交就能把第一个覆盖掉 —— 未满 18 的人只要开两个页面就能改成成年日期。
 * 所以这里真的把路由跑起来，用一个能数出并发的假数据库去验它，而不是只测纯函数。
 *
 * 不连数据库：用 node:module 的 register() 钩子把 src/db.js 换成假实现。
 * 用法：cd server && npm run test:birth-date
 */
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

/* ---------------- 假数据库 ---------------- */

const USER_ID = 'u-test'
/** 当前这一轮的用户行。行为都从这里读，测试之间互不影响 */
let userRow

/** 记下每一条 UPDATE，供断言检查它到底带没带 IS NULL 那道闸 */
const updates = []

globalThis.__fakeDb = {
  async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ').trim()
    if (q.startsWith('SELECT * FROM users WHERE id')) return userRow && params[0] === userRow.id ? [{ ...userRow }] : []
    if (q.startsWith('SELECT g.slug FROM favorites') || q.startsWith('SELECT g.slug FROM recents')) return []
    if (q.startsWith('UPDATE users SET birth_date')) {
      updates.push(q)
      // 这里就是重点：只有 SQL 自己带了 IS NULL 那道闸，重复提交才会 affectedRows = 0。
      // 假库照着 MySQL 的语义执行 —— 路由要是把闸去掉，下面「第二次提交」的断言当场就红。
      const guarded = q.includes('AND birth_date IS NULL')
      if (guarded && userRow.birth_date) return { affectedRows: 0 }
      userRow.birth_date = params[0]
      return { affectedRows: 1 }
    }
    throw new Error(`假数据库没准备这条 SQL：${q}`)
  },
  async queryOne(sql, params) {
    return (await globalThis.__fakeDb.query(sql, params))[0]
  },
}

const temp = await mkdtemp(path.join(tmpdir(), '8bitgo-birth-date-'))
try {
  const fakeDb = path.join(temp, 'fake-db.mjs')
  await writeFile(
    fakeDb,
    [
      'export const query = (sql, params) => globalThis.__fakeDb.query(sql, params)',
      'export const queryOne = (sql, params) => globalThis.__fakeDb.queryOne(sql, params)',
      'export const pool = { query: () => { throw new Error("测试不该直接用 pool") } }',
      '',
    ].join('\n'),
    'utf8',
  )

  const hooks = path.join(temp, 'hooks.mjs')
  // 用 endsWith 而不是正则：钩子源码是拼出来的，反斜杠在这里最容易被吃掉一层
  await writeFile(
    hooks,
    [
      `const FAKE = ${JSON.stringify(pathToFileURL(fakeDb).href)}`,
      'export async function resolve(specifier, context, next) {',
      '  const r = await next(specifier, context)',
      '  if (r.url.endsWith("/src/db.js")) return { ...r, url: FAKE, shortCircuit: true }',
      '  return r',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  register(pathToFileURL(hooks))

  // 钩子装好之后再 import，否则 db.js 已经以真身进了模块缓存
  const { meRouter } = await import('../src/routes/me.js')
  const { signToken } = await import('../src/auth.js')

  const app = express()
  app.use(express.json())
  app.use('/api/me', meRouter)
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const token = signToken(USER_ID, 0)

  const put = (body, auth = token) =>
    fetch(`${base}/api/me/birth-date`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    })

  const freshUser = () => {
    userRow = { id: USER_ID, email: 'a@b.c', nickname: '测试', avatar: '🕹️', password_hash: '', coins: 0, role: 'user', status: 'active', token_version: 0, created_at: '2026-01-01', birth_date: null }
    updates.length = 0
  }

  let n = 0
  const ok = (cond, msg) => {
    assert.ok(cond, msg)
    n++
    console.log('✅ ' + msg)
  }

  console.log('── 没登录 ──')
  freshUser()
  ok((await put({ birthDate: '2000-01-01' }, '')).status === 401, '不带令牌一律 401')

  console.log('\n── 日期本身 ──')
  freshUser()
  ok((await put({ birthDate: '2000-02-30' })).status === 400, '不存在的日期拒绝')
  ok((await put({ birthDate: '' })).status === 400, '空值拒绝')
  ok((await put({})).status === 400, '缺字段拒绝')
  ok((await put({ birthDate: '2999-01-01' })).status === 400, '未来日期拒绝')
  ok((await put({ birthDate: '0200-01-01' })).status === 400, '年份多敲一位（1900 之前）拒绝')
  ok(userRow.birth_date === null && updates.length === 0, '被拒的这几次一个字都没写进库')

  console.log('\n── 正常写入 ──')
  freshUser()
  const first = await put({ birthDate: '2000-01-01' })
  const body = await first.json()
  ok(first.status === 200, '第一次提交成功')
  ok(userRow.birth_date === '2000-01-01', '出生日期落到了 users.birth_date')
  ok(body.birthDate === '2000-01-01' && body.adultVerified === true, '回包带上 birthDate 和 adultVerified')
  ok(body.password_hash === undefined && body.passwordHash === undefined, '回包不含密码哈希')
  ok(updates.every((q) => q.includes('AND birth_date IS NULL')), 'UPDATE 必须带 IS NULL 那道闸')

  console.log('\n── 填一次就锁定 ──')
  ok((await put({ birthDate: '1990-01-01' })).status === 409, '第二次提交被拒（409）')
  ok(userRow.birth_date === '2000-01-01', '被拒之后库里还是第一次那个日期')

  // 两个标签页同时提交：路由里的预检查（req.user.birth_date）在两条请求上都会看到 NULL，
  // 真正分出胜负的只能是那句 SQL。这一条是整个测试的理由。
  console.log('\n── 并发提交 ──')
  freshUser()
  const results = await Promise.all([put({ birthDate: '2000-01-01' }), put({ birthDate: '1990-01-01' })])
  const codes = results.map((r) => r.status).sort()
  ok(codes[0] === 200 && codes[1] === 409, '同时提交两次，只有一次成功（200 + 409）')
  ok(userRow.birth_date === '2000-01-01' || userRow.birth_date === '1990-01-01', '库里只留下其中一个日期')

  console.log('\n── 未满 18 也照样记下 ──')
  freshUser()
  const minor = await put({ birthDate: localMinorDate() })
  const minorBody = await minor.json()
  ok(minor.status === 200, '未满 18 的日期不在这里拒绝')
  ok(minorBody.adultVerified === false, 'adultVerified 为 false，由年龄门去拦')
  ok((await put({ birthDate: '1990-01-01' })).status === 409, '未满 18 的也一样锁定，不能改成成年日期')

  server.close()
  console.log(`\n全部通过（${n} 项）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}

/** 一个「今天往前十年」的日期：写死年份的话，这个测试过几年就会自己变成成年 */
function localMinorDate() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear() - 10}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
