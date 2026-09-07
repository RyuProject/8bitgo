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
let views
let viewsBroken

function reset() {
  users = {
    [AUTHOR]: { id: AUTHOR, nickname: '作者', avatar: '🕹️', role: 'user', status: 'active', token_version: 0 },
    [OTHER]: { id: OTHER, nickname: '路人', avatar: '👾', role: 'user', status: 'active', token_version: 0 },
    [ADMIN]: { id: ADMIN, nickname: '管理员', avatar: '👑', role: 'admin', status: 'active', token_version: 0 },
  }
  collections = [
    { id: 1, user_id: AUTHOR, title: '合金弹头', kind: '系列', description: '', hidden: 0, updated_at: new Date('2026-01-01T00:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z') },
  ]
  items = [{ collection_id: 1, game_id: 10, created_at: new Date('2026-01-01T00:00:00Z'), position: null }]
  // 浏览记录。主键 (collection_id, kind, identity)，和真表一样靠它判重
  views = []
  // 把 collection_views 的读写全变成抛错，用来验「表还没迁移」时的容错
  viewsBroken = false
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
    // 封面用的瘦身查询（列名对齐 coverGame()）
    if (q.startsWith('SELECT id, slug, title, title_zh, platform, icon, cover, video FROM games WHERE id IN')) {
      const ids = params.map(String)
      return games
        .filter((g) => ids.includes(String(g.id)) && !g.hidden)
        .map((g) => ({ id: g.id, slug: g.slug, title: g.title, title_zh: g.title_zh ?? null, platform: g.platform, icon: g.icon ?? '🎮', cover: g.cover ?? null, video: g.video ?? null }))
    }
    if (q.startsWith('SELECT * FROM games WHERE id IN')) {
      const ids = params.slice(0, params.length).map(String)
      return games.filter((g) => ids.includes(String(g.id)) && !g.hidden).map((g) => ({ ...g }))
    }
    /*
      浏览量的两条。viewsBroken 打开时抛错，模拟「collection_views 还没迁移」——
      读写两侧都必须容错（读按 0、写按没数到），页面不能因为一个装饰性的数字挂掉。
    */
    if (q.startsWith('SELECT collection_id, COUNT(*) AS n FROM collection_views')) {
      if (viewsBroken) throw new Error("Table 'collection_views' doesn't exist")
      const ids = params.map(Number)
      return ids
        .map((cid) => ({ collection_id: cid, n: views.filter((v) => v.collection_id === cid).length }))
        .filter((r) => r.n)
    }
    if (q.startsWith('INSERT IGNORE INTO collection_views')) {
      if (viewsBroken) throw new Error("Table 'collection_views' doesn't exist")
      const [cid, kind, identity] = [Number(params[0]), params[1], params[2]]
      // 主键判重，和真表一致
      if (views.some((v) => v.collection_id === cid && v.kind === kind && v.identity === identity)) {
        return { affectedRows: 0 }
      }
      views.push({ collection_id: cid, kind, identity })
      return { affectedRows: 1 }
    }
    if (q.startsWith('SELECT id, user_id, hidden FROM collections WHERE id')) {
      return collections
        .filter((c) => c.id === Number(params[0]))
        .map((c) => ({ id: c.id, user_id: c.user_id, hidden: c.hidden }))
    }
    if (q.startsWith('INSERT IGNORE INTO collection_items')) {
      const [cid, gid] = [Number(params[0]), Number(params[1])]
      if (items.some((i) => i.collection_id === cid && i.game_id === gid)) return { affectedRows: 0 }
      items.push({ collection_id: cid, game_id: gid, created_at: new Date(), position: null })
      return { affectedRows: 1 }
    }
    if (q.startsWith('DELETE FROM collection_items')) {
      const [cid, gid] = [Number(params[0]), Number(params[1])]
      const before = items.length
      items = items.filter((i) => !(i.collection_id === cid && i.game_id === gid))
      return { affectedRows: before - items.length }
    }
    if (q.startsWith('SELECT ci.game_id, ci.created_at, ci.position FROM collection_items')) {
      // 和真 SQL 一致：排过的在前按 position 升序，没排过的垫后按加入时间倒序
      const pos = (i) => (i.position == null ? Number.POSITIVE_INFINITY : i.position)
      return items
        .filter((i) => i.collection_id === Number(params[0]))
        .sort((a, b) => pos(a) - pos(b) || b.created_at - a.created_at || b.game_id - a.game_id)
        .map((i) => ({ game_id: i.game_id, created_at: i.created_at, position: i.position ?? null }))
    }
    if (q.startsWith('SELECT game_id FROM collection_items WHERE collection_id')) {
      return items.filter((i) => i.collection_id === Number(params[0])).map((i) => ({ game_id: i.game_id }))
    }
    if (q.startsWith('SELECT id, slug FROM games WHERE slug IN')) {
      return games.filter((g) => params.includes(g.slug)).map((g) => ({ id: g.id, slug: g.slug }))
    }
    if (q.startsWith('UPDATE collection_items SET position = CASE game_id')) {
      // 参数排列见路由：[gid, pos, gid, pos, ..., collection_id, gid, gid, ...]
      const k = (params.length - 1) / 3
      const cid = Number(params[2 * k])
      let touched = 0
      for (let i = 0; i < k; i++) {
        const gid = Number(params[2 * i])
        const it = items.find((x) => x.collection_id === cid && x.game_id === gid)
        if (it) {
          it.position = Number(params[2 * i + 1])
          touched++
        }
      }
      return { affectedRows: touched }
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

  console.log('\n── 封面：最新放入的在前，最多给 12 张（前 4 张摆四宫格，其余给卡片轮播） ──')
  reset()
  collections.push({ id: 2, user_id: AUTHOR, title: '空的', kind: '', description: '', hidden: 0, updated_at: new Date(), created_at: new Date() })
  // 按时间递增放入 5 款：全给出来，最新的在最前，四宫格摆的就是前四张
  for (let i = 0; i < 5; i++) {
    games.push({ id: 100 + i, slug: `g${i}`, title: `G${i}`, platform: 'nes', hidden: 0, cover: `covers/g${i}.jpg` })
    items.push({ collection_id: 2, game_id: 100 + i, created_at: new Date(Date.UTC(2026, 2, i + 1)) })
  }
  const detail = await (await call('GET', '/2')).json()
  ok(detail.collection.covers.length === 5, '5 款全给（不到 12 张上限）')
  ok(detail.collection.covers.slice(0, 4).map((g) => g.slug).join(',') === 'g4,g3,g2,g1', '⭐ 前四张是最新放入的四款，最新的在最前')
  ok(detail.collection.gameCount === 5, '游戏数报的是全部，不是封面的张数')
  const cover0 = detail.collection.covers[0]
  ok(cover0.cover === 'covers/g4.jpg' && cover0.platform === 'nes' && !('description' in cover0) && !('genres' in cover0), '⭐ 封面是瘦身版：有 cover / platform，没有简介和类型（首页那一栏的数据量）')
  // 再塞到 13 款：封面上限 12
  for (let i = 5; i < 13; i++) {
    games.push({ id: 100 + i, slug: `g${i}`, title: `G${i}`, platform: 'nes', hidden: 0 })
    items.push({ collection_id: 2, game_id: 100 + i, created_at: new Date(Date.UTC(2026, 2, i + 1)) })
  }
  const detail13 = await (await call('GET', '/2')).json()
  ok(detail13.collection.covers.length === 12 && detail13.collection.covers[0].slug === 'g12', '13 款只给 12 张，还是最新的在最前')
  ok(detail13.collection.gameCount === 13, '游戏数照样是 13')


  console.log('\n── 手动排序（PATCH /:id/order） ──')
  const seedSorted = () => {
    reset()
    collections.push({ id: 2, user_id: AUTHOR, title: '拳皇', kind: '系列', description: '', hidden: 0, updated_at: new Date('2026-01-01T00:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z') })
    for (let i = 0; i < 5; i++) {
      games.push({ id: 100 + i, slug: `g${i}`, title: `G${i}`, platform: 'nes', hidden: 0 })
      items.push({ collection_id: 2, game_id: 100 + i, created_at: new Date(Date.UTC(2026, 2, i + 1)), position: null })
    }
  }
  const orderOf = async () => (await (await call('GET', '/2')).json()).games.map((g) => g.slug).join(',')

  seedSorted()
  ok((await orderOf()) === 'g4,g3,g2,g1,g0', '没排过：还是「最新放入的在前」，和以前一模一样')
  const before = collections.find((c) => c.id === 2).updated_at
  const sorted = await call('PATCH', '/2/order', { as: AUTHOR, body: { slugs: ['g1', 'g3', 'g0', 'g4', 'g2'] } })
  ok(sorted.status === 200 && (await sorted.json()).ordered === 5, '作者排序 200，5 款都写了位置')
  ok((await orderOf()) === 'g1,g3,g0,g4,g2', '⭐ 详情按作者排的顺序返回')
  ok(collections.find((c) => c.id === 2).updated_at > before, '排序算「有动静」，updated_at 往前推')

  // 排过之后再加进来的：垫到末尾，别插到作者排好的前面
  await call('POST', '/2/games', { as: AUTHOR, body: { gameSlug: 'contra' } })
  ok((await orderOf()) === 'g1,g3,g0,g4,g2,contra', '⭐ 排过之后新加的排到末尾')

  seedSorted()
  ok((await call('PATCH', '/2/order', { as: ADMIN, body: { slugs: ['g0', 'g1', 'g2', 'g3', 'g4'] } })).status === 403, '⭐ 管理员不能给别人的合集排序（顺序也是作者的表达）')
  ok((await call('PATCH', '/2/order', { as: OTHER, body: { slugs: ['g0', 'g1'] } })).status === 403, '路人更不能')
  ok((await call('PATCH', '/2/order', { body: { slugs: ['g0'] } })).status === 401, '没登录不能')
  ok((await orderOf()) === 'g4,g3,g2,g1,g0', '被拒的请求一个位置都没动')

  seedSorted()
  const partial = await call('PATCH', '/2/order', { as: AUTHOR, body: { slugs: ['g2', 'nope', 'metal-slug', 'g0', 'g2'] } })
  ok(partial.status === 200 && (await partial.json()).ordered === 2, '不认识的 / 别的合集里的 / 重复的 slug 忽略不报错，只算真写进去的')
  ok((await orderOf()) === 'g2,g0,g4,g3,g1', '⭐ 只发一部分：发了的在前按发的顺序，没发的垫后按加入时间倒序')

  ok((await call('PATCH', '/2/order', { as: AUTHOR, body: {} })).status === 400, '缺 slugs 400')
  ok((await call('PATCH', '/2/order', { as: AUTHOR, body: { slugs: 'g0' } })).status === 400, 'slugs 不是数组 400')
  ok((await call('PATCH', '/999/order', { as: AUTHOR, body: { slugs: ['g0'] } })).status === 404, '不存在的合集 404')

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

  console.log('\n── 浏览量（多少人看过，按人去重） ──')
  reset()
  const viewCountOf = async (id = 1) => (await (await call('GET', `/${id}`)).json()).collection.viewCount

  ok(await (async () => {
    const r = await call('POST', '/1/view')
    return r.status === 200 && (await r.json()).counted === true
  })(), '游客浏览记上一次')
  ok((await viewCountOf()) === 1, '详情里 viewCount 变成 1')
  ok(!(await (await call('POST', '/1/view')).json()).counted, '⭐ 同一个游客再浏览不重复计数（按 IP 去重）')
  ok((await viewCountOf()) === 1, '刷新多少次都还是 1 —— 这就是「多少人看过」的意思')

  // 登录之后身份从 IP 换成账号，算另一个人（playcount.js 开头写明的取舍）
  ok((await (await call('POST', '/1/view', { as: OTHER })).json()).counted, '路人登录后算一个新的人')
  ok((await viewCountOf()) === 2, 'viewCount 变成 2')
  ok(!(await (await call('POST', '/1/view', { as: OTHER })).json()).counted, '同一个账号再浏览不重复计数')

  /*
    ⭐⭐ 这两条是这一块最容易被后人顺手破坏的，都做过变异检查。
  */
  ok(!(await (await call('POST', '/1/view', { as: AUTHOR })).json()).counted, '⭐ 作者本人看自己的合集不算')
  ok((await viewCountOf()) === 2, '⭐ 作者浏览之后 viewCount 一个都没涨')

  const beforeTouch = collections[0].updated_at.getTime()
  await call('POST', '/1/view')
  await call('POST', '/1/view', { as: ADMIN })
  ok(
    collections[0].updated_at.getTime() === beforeTouch,
    '⭐ 浏览绝不能碰 updated_at —— 列表按它排，一碰就把被围观的合集顶到最前面（建表注释点名说过「加个浏览计数之类」）',
  )

  ok((await (await call('POST', '/1/view', { as: ADMIN })).json()).counted === false, '管理员也是人，第二次不重复计数')

  // 列表那一路也要带上，不然卡片上没有数字
  ok(
    (await (await call('GET', '/')).json()).items[0].viewCount === 3,
    '列表里也带 viewCount（游客 + 路人 + 管理员 = 3，作者不算）',
  )

  console.log('\n── 浏览量：不存在 / 已下架 / 表没迁移 ──')
  reset()
  ok((await call('POST', '/999/view')).status === 404, '不存在的合集 404')
  ok((await call('POST', '/abc/view')).status === 404, 'id 不是数字也 404，不是 400')
  await call('PATCH', '/1/hidden', { as: ADMIN, body: { hidden: true } })
  ok((await call('POST', '/1/view')).status === 404, '⭐ 已下架的合集 404（403 等于承认这里确实有个东西）')
  ok(views.length === 0, '下架的合集一条浏览记录都不该留下')

  reset()
  viewsBroken = true
  const brokenPost = await call('POST', '/1/view')
  ok(brokenPost.status === 200, '⭐ 表还没迁移时上报不能 500')
  ok((await brokenPost.json()).counted === false, '而是老实说「没数到」')
  const brokenGet = await call('GET', '/1')
  ok(brokenGet.status === 200, '⭐ 表还没迁移时详情页照常能看')
  ok((await brokenGet.json()).collection.viewCount === 0, '数字按 0 处理')
  ok((await call('GET', '/')).status === 200, '列表也照常 —— decorate 里它和封面是并列的，一抛就是整份 500')
  viewsBroken = false

  server.close()
  console.log(`\n✅ 合集接口权限测试通过（${n} 项）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
