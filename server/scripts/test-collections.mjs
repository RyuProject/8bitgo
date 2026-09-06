/**
 * 合集接口的权限自检。
 *
 * 为什么值得单独测：这一套的产品约定不是「谁权限大谁能干更多事」，而是**分工不同**——
 *   · 作者本人：能改标题描述、能增删游戏，但不能下架
 *   · 管理员：能删、能下架，**但不能改别人的标题描述**
 * 这种「大权限反而不能做某件事」的规则最容易在后续重构里被顺手抹平
 * （「管理员当然什么都能干」是个很自然的直觉），而抹平之后手测根本发现不了。
 * 所以这里真的把路由跑起来，用真 JWT 分别以三种身份打一遍。
 *
 * 不连数据库：用 node:module 的 register() 钩子把 src/db.js 换成假实现。
 * 用法：cd server && npm run test:collections
 */
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

const AUTHOR = 'u-author'
const OTHER = 'u-other'
const ADMIN = 'u-admin'

/** 这一轮的数据。每个用例开头 reset() 一次，互不影响 */
let users
let collections
let items
let games

function reset() {
  users = {
    [AUTHOR]: { id: AUTHOR, nickname: '作者', avatar: '🕹️', role: 'user', status: 'active', token_version: 0 },
    [OTHER]: { id: OTHER, nickname: '路人', avatar: '👾', role: 'user', status: 'active', token_version: 0 },
    [ADMIN]: { id: ADMIN, nickname: '管理员', avatar: '👑', role: 'admin', status: 'active', token_version: 0 },
  }
  collections = [
    { id: 1, user_id: AUTHOR, title: '合金弹头', kind: '系列', description: '', hidden: 0, updated_at: new Date('2026-01-01T00:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z') },
  ]
  items = [{ collection_id: 1, game_id: 10, created_at: new Date('2026-01-01T00:00:00Z') }]
  games = [
    { id: 10, slug: 'metal-slug', title: 'Metal Slug', platform: 'arcade', hidden: 0 },
    { id: 11, slug: 'contra', title: 'Contra', platform: 'nes', hidden: 0 },
  ]
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim()

globalThis.__fakeDb = {
  async query(sql, params = []) {
    const q = norm(sql)

    if (q.startsWith('SELECT * FROM users WHERE id')) {
      const u = users[params[0]]
      return u ? [{ ...u }] : []
    }
    if (q.startsWith('SELECT COUNT(*) AS n FROM collections WHERE hidden = 0')) {
      return [{ n: collections.filter((c) => !c.hidden).length }]
    }
    if (q.startsWith('SELECT COUNT(*) AS n FROM collections WHERE user_id')) {
      return [{ n: collections.filter((c) => c.user_id === params[0]).length }]
    }
    if (q.startsWith('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id')) {
      return [{ n: items.filter((i) => i.collection_id === Number(params[0])).length }]
    }
    // 列表 / 详情：合集 JOIN 作者
    if (q.startsWith('SELECT c.*, u.nickname, u.avatar FROM collections c')) {
      let rows = collections
      if (q.includes('WHERE c.id = ?')) rows = rows.filter((c) => c.id === Number(params[0]))
      else if (q.includes('WHERE c.user_id = ?')) rows = rows.filter((c) => c.user_id === params[0])
      else if (q.includes('WHERE c.hidden = 0')) rows = rows.filter((c) => !c.hidden)
      return rows.map((c) => ({ ...c, nickname: users[c.user_id]?.nickname, avatar: users[c.user_id]?.avatar }))
    }
    if (q.startsWith('SELECT * FROM collections WHERE id')) {
      return collections.filter((c) => c.id === Number(params[0])).map((c) => ({ ...c }))
    }
    if (q.startsWith('SELECT id, user_id FROM collections WHERE id')) {
      return collections.filter((c) => c.id === Number(params[0])).map((c) => ({ id: c.id, user_id: c.user_id }))
    }
    if (q.startsWith('INSERT INTO collections')) {
      const id = Math.max(0, ...collections.map((c) => c.id)) + 1
      collections.push({ id, user_id: params[0], title: params[1], kind: params[2], description: params[3], hidden: 0, updated_at: new Date(), created_at: new Date() })
      return { insertId: id, affectedRows: 1 }
    }
    if (q.startsWith('UPDATE collections SET')) {
      const id = Number(params[params.length - 1])
      const c = collections.find((x) => x.id === id)
      if (!c) return { affectedRows: 0 }
      // 只关心测试要断言的几列
      if (q.includes('title = ?')) c.title = params[0]
      if (q.includes('hidden = ?')) c.hidden = Number(params[0])
      if (q.includes('updated_at = CURRENT_TIMESTAMP(3)')) c.updated_at = new Date()
      return { affectedRows: 1 }
    }
    if (q.startsWith('DELETE FROM collections WHERE id')) {
      const id = Number(params[0])
      const before = collections.length
      collections = collections.filter((c) => c.id !== id)
      items = items.filter((i) => i.collection_id !== id) // 外键级联
      return { affectedRows: before - collections.length }
    }
    if (q.startsWith('SELECT id FROM games WHERE slug')) {
      const g = games.find((x) => x.slug === params[0] && (!q.includes('hidden = 0') || !x.hidden))
      return g ? [{ id: g.id }] : []
    }
    if (q.startsWith('SELECT * FROM games WHERE id IN')) {
      const ids = params.slice(0, params.length).map(String)
      return games.filter((g) => ids.includes(String(g.id)) && !g.hidden).map((g) => ({ ...g }))
    }
    if (q.startsWith('INSERT IGNORE INTO collection_items')) {
      const [cid, gid] = [Number(params[0]), Number(params[1])]
      if (items.some((i) => i.collection_id === cid && i.game_id === gid)) return { affectedRows: 0 }
      items.push({ collection_id: cid, game_id: gid, created_at: new Date() })
      return { affectedRows: 1 }
    }
    if (q.startsWith('DELETE FROM collection_items')) {
      const [cid, gid] = [Number(params[0]), Number(params[1])]
      const before = items.length
      items = items.filter((i) => !(i.collection_id === cid && i.game_id === gid))
      return { affectedRows: before - items.length }
    }
    if (q.startsWith('SELECT ci.game_id, ci.created_at FROM collection_items')) {
      return items
        .filter((i) => i.collection_id === Number(params[0]))
        .sort((a, b) => b.created_at - a.created_at || b.game_id - a.game_id)
        .map((i) => ({ game_id: i.game_id, created_at: i.created_at }))
    }
    // 封面：窗口函数那条
    if (q.includes('ROW_NUMBER() OVER (PARTITION BY collection_id')) {
      const limit = Number(params[params.length - 1])
      const ids = params.slice(0, -1).map(Number)
      const out = []
      for (const cid of ids) {
        const top = items
          .filter((i) => i.collection_id === cid)
          .sort((a, b) => b.created_at - a.created_at || b.game_id - a.game_id)
          .slice(0, limit)
        for (const i of top) out.push({ collection_id: cid, game_id: i.game_id })
      }
      return out
    }
    if (q.startsWith('SELECT collection_id, COUNT(*) AS n FROM collection_items')) {
      const ids = params.map(Number)
      return ids.map((cid) => ({ collection_id: cid, n: items.filter((i) => i.collection_id === cid).length })).filter((r) => r.n)
    }
    // attachRelations 的三条
    if (/^SELECT game_id, (genre_id|tag|lang)/.test(q)) return []
    throw new Error(`假数据库没准备这条 SQL：${q}`)
  },
  async queryOne(sql, params) {
    return (await globalThis.__fakeDb.query(sql, params))[0]
  },
}

const temp = await mkdtemp(path.join(tmpdir(), '8bitgo-collections-'))
try {
  const fakeDb = path.join(temp, 'fake-db.mjs')
  await writeFile(
    fakeDb,
    [
      'export const query = (sql, params) => globalThis.__fakeDb.query(sql, params)',
      'export const queryOne = (sql, params) => globalThis.__fakeDb.queryOne(sql, params)',
      'export const pool = { query: () => { throw new Error("测试不该直接用 pool") } }',
      // games-repo.js 会 import 它（合集详情要用 attachRelations），少一个导出整个模块就加载不了
      'export const withTransaction = async (fn) => fn({ query: globalThis.__fakeDb.query, queryOne: globalThis.__fakeDb.queryOne })',
      '',
    ].join('\n'),
    'utf8',
  )
  const hooks = path.join(temp, 'hooks.mjs')
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

  const { collectionsRouter } = await import('../src/routes/collections.js')
  const { signToken } = await import('../src/auth.js')

  const app = express()
  app.use(express.json())
  app.use('/api/collections', collectionsRouter)
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const tok = { [AUTHOR]: signToken(AUTHOR, 0), [OTHER]: signToken(OTHER, 0), [ADMIN]: signToken(ADMIN, 0) }
  const call = (method, url, { as, body } = {}) =>
    fetch(`${base}/api/collections${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${tok[as]}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  let n = 0
  const ok = (cond, msg) => {
    assert.ok(cond, msg)
    n++
    console.log('✅ ' + msg)
  }

  console.log('── 没登录 ──')
  reset()
  ok((await call('POST', '/', { body: { title: 'x' } })).status === 401, '没登录不能建合集')
  ok((await call('PATCH', '/1', { body: { title: 'x' } })).status === 401, '没登录不能改')
  ok((await call('DELETE', '/1')).status === 401, '没登录不能删')
  ok((await call('POST', '/1/games', { body: { gameSlug: 'contra' } })).status === 401, '没登录不能加游戏')
  ok((await call('GET', '/')).status === 200, '但列表是公开的')
  ok((await call('GET', '/1')).status === 200, '详情也是公开的')

  console.log('\n── 作者本人 ──')
  reset()
  ok((await call('PATCH', '/1', { as: AUTHOR, body: { title: '合金弹头合集' } })).status === 200, '作者能改标题')
  ok(collections[0].title === '合金弹头合集', '标题真的写进去了')
  ok((await call('POST', '/1/games', { as: AUTHOR, body: { gameSlug: 'contra' } })).status === 201, '作者能加游戏')
  ok(items.length === 2, '游戏真的加进去了')

  console.log('\n── 别人 ──')
  reset()
  ok((await call('PATCH', '/1', { as: OTHER, body: { title: '我改了' } })).status === 403, '路人不能改别人的合集')
  ok((await call('DELETE', '/1', { as: OTHER })).status === 403, '路人不能删别人的合集')
  ok((await call('POST', '/1/games', { as: OTHER, body: { gameSlug: 'contra' } })).status === 403, '路人不能往别人的合集里加游戏')
  ok((await call('DELETE', '/1/games/metal-slug', { as: OTHER })).status === 403, '路人不能从别人的合集里移除游戏')
  ok(collections[0].title === '合金弹头' && items.length === 1, '被拒的这几次一个字都没落库')

  console.log('\n── 管理员：能删不能改（这一组是重点）──')
  reset()
  ok((await call('PATCH', '/1', { as: ADMIN, body: { title: '管理员改的' } })).status === 403, '⭐ 管理员**不能**改别人的标题描述')
  ok(collections[0].title === '合金弹头', '标题没被管理员动过')
  ok((await call('POST', '/1/games', { as: ADMIN, body: { gameSlug: 'contra' } })).status === 403, '⭐ 管理员也不能替作者加游戏')
  ok((await call('PATCH', '/1/hidden', { as: ADMIN, body: { hidden: true } })).status === 200, '管理员能下架')
  ok(collections[0].hidden === 1, '下架状态写进去了')
  ok((await call('PATCH', '/1/hidden', { as: AUTHOR, body: { hidden: true } })).status === 403, '作者自己不能下架（要藏只能删）')
  reset()
  ok((await call('DELETE', '/1', { as: ADMIN })).status === 200, '管理员能删违规合集')
  ok(collections.length === 0 && items.length === 0, '合集和里面的条目一起没了（外键级联）')

  console.log('\n── 下架之后谁看得见 ──')
  reset()
  collections[0].hidden = 1
  ok((await call('GET', '/1')).status === 404, '下架的合集对外人是 404，不是 403（403 等于承认它存在）')
  ok((await call('GET', '/1', { as: AUTHOR })).status === 200, '作者本人仍看得到自己的')
  ok((await call('GET', '/1', { as: ADMIN })).status === 200, '有审核权的人看得到')
  ok((await (await call('GET', '/')).json()).items.length === 0, '公开列表里不出现')

  console.log('\n── 加游戏是幂等的 ──')
  reset()
  const firstAt = items[0].created_at
  const again = await call('POST', '/1/games', { as: AUTHOR, body: { gameSlug: 'metal-slug' } })
  ok(again.status === 201 && (await again.json()).added === false, '重复加入不报错，只是 added=false')
  ok(items.length === 1, '没有插出第二条')
  ok(items[0].created_at === firstAt, '⭐ 也没有刷新时间 —— 刷了封面顺序会莫名其妙地变')

  console.log('\n── 封面取「最新放入的四款」 ──')
  reset()
  collections.push({ id: 2, user_id: AUTHOR, title: '空的', kind: '', description: '', hidden: 0, updated_at: new Date(), created_at: new Date() })
  // 按时间递增放入 5 款，封面应当拿到最后 4 款、且最新的在最前
  for (let i = 0; i < 5; i++) {
    games.push({ id: 100 + i, slug: `g${i}`, title: `G${i}`, platform: 'nes', hidden: 0 })
    items.push({ collection_id: 2, game_id: 100 + i, created_at: new Date(Date.UTC(2026, 2, i + 1)) })
  }
  const detail = await (await call('GET', '/2')).json()
  ok(detail.collection.covers.length === 4, '封面正好四张')
  ok(detail.collection.covers.map((g) => g.slug).join(',') === 'g4,g3,g2,g1', '⭐ 是最新放入的四款，最新的在最前')
  ok(detail.collection.gameCount === 5, '游戏数报的是全部，不是封面那四张')

  console.log('\n── 校验 ──')
  reset()
  ok((await call('POST', '/', { as: AUTHOR, body: { title: '   ' } })).status === 400, '纯空白标题拒绝')
  ok((await call('POST', '/', { as: AUTHOR, body: {} })).status === 400, '缺标题拒绝')
  const long = await call('POST', '/', { as: AUTHOR, body: { title: 'x'.repeat(200), description: 'y'.repeat(9999) } })
  ok(long.status === 201, '超长的截断而不是报错')
  const created = await long.json()
  ok(created.title.length === 80, '标题截到 80（和列宽对齐）')
  ok((await call('POST', '/1/games', { as: AUTHOR, body: { gameSlug: '不存在的游戏' } })).status === 404, '加不存在的游戏 404')
  ok((await call('GET', '/999')).status === 404, '不存在的合集 404')
  ok((await call('GET', '/mine', { as: AUTHOR })).status === 200, '⭐ /mine 没有被 /:id 抢走（路由顺序）')

  server.close()
  console.log(`\n✅ 合集接口权限测试通过（${n} 项）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
