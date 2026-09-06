/**
 * 评分的回归测试 —— 不连 MySQL。
 *
 *   node scripts/test-ratings.mjs
 *
 * 测的是 ratings-repo.js 里的**真代码**（applyRating / findRating / recomputeSql /
 * ratingStats 的算法），跑在一个内存 SQLite 上：建一张和 schema-v2.sql 等价的
 * game_ratings（三条唯一约束一条不少），然后把 run 换成 SQLite 的执行器。
 *
 * 为什么不在测试里另抄一份同形的 SQL：抄的那份和真身迟早会分叉，而分叉之后测试
 * 全绿、线上照错。这里唯一被改写的是两处 SQLite 语法不认的写法（见 toSqlite）。
 *
 * 重点覆盖的是**去重语义** —— 谁顶掉谁、什么时候算新票。这类 bug 在线上是
 * 「平均分看着不太对」，没有报错也没有日志，等发现时历史数据已经脏了。
 */
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { applyRating, findRating, recomputeSql, WEIGHT_USER, WEIGHT_ANON } from '../src/ratings-repo.js'

/**
 * 两处 MySQL 写法 SQLite 不认，按语义等价改写：
 *   - FOR UPDATE：SQLite 的写事务本来就是独占的，没有行锁这一说
 *   - UPDATE games g SET g.x = ...：SQLite 的 UPDATE 不支持表别名，也不接受
 *     赋值左边带限定名
 * 除此之外，跑的就是 ratings-repo.js 里那几条语句的原文。
 */
function toSqlite(sql) {
  return sql
    .replace(/ FOR UPDATE/g, '')
    .replace('UPDATE games g SET', 'UPDATE games SET')
    .replace(/(\n\s+)g\.(rating_\w+)(\s*)=/g, '$1$2$3=')
    .replace(/\bg\.id\b/g, 'games.id')
}

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE games (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    rating_sum REAL NOT NULL DEFAULT 0,
    rating_weight REAL NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE game_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id TEXT NULL,
    anon_id TEXT NULL,
    anon_ip TEXT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    weight REAL NOT NULL,
    country TEXT NOT NULL DEFAULT 'XX'
  );
  -- 和 schema-v2.sql 一致：三条都允许多个 NULL，登录行的 anon_* 与匿名行的 user_id 因此互不打架
  CREATE UNIQUE INDEX uniq_rating_user ON game_ratings (game_id, user_id);
  CREATE UNIQUE INDEX uniq_rating_anon ON game_ratings (game_id, anon_id);
  CREATE UNIQUE INDEX uniq_rating_ip   ON game_ratings (game_id, anon_ip);
  INSERT INTO games (id, slug) VALUES (1, 'contra'), (2, 'kof97');
`)

/** ratings-repo 期待的 run(sql, params) -> rows */
const run = async (sql, params = []) => {
  const s = toSqlite(sql)
  const stmt = db.prepare(s)
  return /^\s*select/i.test(s) ? stmt.all(...params) : (stmt.run(...params), [])
}

const rows = (sql, ...p) => db.prepare(sql).all(...p)
const one = (sql, ...p) => rows(sql, ...p)[0]

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

/** 投一票 + 重算聚合，就是 submitRating() 在事务里做的两件事 */
const vote = async (opts) => {
  const r = await applyRating(run, opts)
  await run(recomputeSql(1), [opts.gameId])
  return r
}
const agg = (gameId = 1) => one('SELECT rating_sum, rating_weight, rating_count FROM games WHERE id = ?', gameId)
const count = (gameId = 1) => one('SELECT COUNT(*) AS n FROM game_ratings WHERE game_id = ?', gameId).n

const reset = () => {
  db.exec('DELETE FROM game_ratings; UPDATE games SET rating_sum = 0, rating_weight = 0, rating_count = 0;')
}

console.log('一、权重与聚合')

await check('登录一票 1.0、匿名一票 0.5', async () => {
  reset()
  await vote({ gameId: 1, userId: 'u1', score: 5 })
  await vote({ gameId: 1, anonId: 'a'.repeat(32), anonIp: '1.1.1.1', score: 3 })
  const a = agg()
  assert.equal(Number(a.rating_weight), WEIGHT_USER + WEIGHT_ANON)
  assert.equal(Number(a.rating_count), 2)
  // (5*1.0 + 3*0.5) / 1.5 = 4.333…
  assert.equal(Number(a.rating_sum), 5 * WEIGHT_USER + 3 * WEIGHT_ANON)
})

await check('改分是 UPDATE 不是新增：人数不变、总分跟着变', async () => {
  reset()
  await vote({ gameId: 1, userId: 'u1', score: 5 })
  const second = await vote({ gameId: 1, userId: 'u1', score: 2 })
  assert.equal(second.created, false)
  assert.equal(count(), 1)
  assert.equal(Number(agg().rating_sum), 2)
})

await check('第一次投票 created=true，之后都是 false', async () => {
  reset()
  assert.equal((await vote({ gameId: 1, userId: 'u1', score: 4 })).created, true)
  assert.equal((await vote({ gameId: 1, userId: 'u1', score: 1 })).created, false)
})

await check('聚合是按明细重算的：手动删一行后再投，数字自愈', async () => {
  reset()
  await vote({ gameId: 1, userId: 'u1', score: 5 })
  await vote({ gameId: 1, userId: 'u2', score: 5 })
  // 模拟外键级联（删账号）：明细没了，聚合列还挂着旧数字
  db.exec("DELETE FROM game_ratings WHERE user_id = 'u2'")
  assert.equal(Number(agg().rating_count), 2, '前置条件：聚合此刻确实是脏的')
  await vote({ gameId: 1, userId: 'u3', score: 1 })
  assert.equal(Number(agg().rating_count), 2)
  assert.equal(Number(agg().rating_sum), 6)
})

await check('两款游戏各算各的', async () => {
  reset()
  await vote({ gameId: 1, userId: 'u1', score: 5 })
  await vote({ gameId: 2, userId: 'u1', score: 1 })
  assert.equal(Number(agg(1).rating_sum), 5)
  assert.equal(Number(agg(2).rating_sum), 1)
})

console.log('二、匿名去重')

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)

await check('同一浏览器改分：一行，不是两行', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 2 })
  assert.equal(count(), 1)
  assert.equal(Number(agg().rating_sum), 2 * WEIGHT_ANON)
})

await check('清了本地存储换个 anon_id，同 IP 仍然认领原来那一票', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  const r = await vote({ gameId: 1, anonId: B, anonIp: '1.1.1.1', score: 1 })
  assert.equal(r.created, false)
  assert.equal(count(), 1)
  assert.equal(one('SELECT anon_id FROM game_ratings WHERE game_id = 1').anon_id, B, '这一行应该被新的 anon_id 认领')
})

await check('同一浏览器换网络：按 anon_id 找回自己那票，不新增', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  await vote({ gameId: 1, anonId: A, anonIp: '2.2.2.2', score: 1 })
  assert.equal(count(), 1)
  assert.equal(one('SELECT anon_ip FROM game_ratings WHERE game_id = 1').anon_ip, '2.2.2.2')
})

await check('换到一个「别人已经投过」的网络：不撞唯一键，两票各自还在', async () => {
  reset()
  // 甲在家投（IP 1.1.1.1），乙在咖啡馆投（IP 2.2.2.2）
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  await vote({ gameId: 1, anonId: B, anonIp: '2.2.2.2', score: 1 })
  // 甲带着自己的 anon_id 去了那家咖啡馆改分 —— 这一步以前会 UNIQUE 冲突，且重试永远失败
  await vote({ gameId: 1, anonId: A, anonIp: '2.2.2.2', score: 3 })
  assert.equal(count(), 2, '乙的票不能被删掉')
  const mine = one('SELECT anon_ip, score FROM game_ratings WHERE anon_id = ?', A)
  assert.equal(mine.anon_ip, '2.2.2.2')
  assert.equal(Number(mine.score), 3)
  assert.equal(one('SELECT anon_ip FROM game_ratings WHERE anon_id = ?', B).anon_ip, null, '旧的那行让出 IP')
})

await check('拿不到真实 IP 时（anon_ip 为 NULL）仍按 anon_id 区分，不塌缩成一票', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: null, score: 5 })
  await vote({ gameId: 1, anonId: B, anonIp: null, score: 1 })
  await vote({ gameId: 1, anonId: C, anonIp: null, score: 3 })
  assert.equal(count(), 3)
})

await check('同 IP 下的两个登录用户互不影响（登录行 anon_ip 必须是 NULL）', async () => {
  reset()
  await vote({ gameId: 1, userId: 'u1', anonId: A, anonIp: '1.1.1.1', score: 5 })
  await vote({ gameId: 1, userId: 'u2', anonId: B, anonIp: '1.1.1.1', score: 1 })
  assert.equal(count(), 2)
  assert.equal(one('SELECT COUNT(*) AS n FROM game_ratings WHERE anon_ip IS NOT NULL').n, 0)
})

console.log('三、匿名 -> 登录')

await check('匿名投过再登录投：旧的 0.5 票被撤掉，不会一人两票', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  await vote({ gameId: 1, userId: 'u1', anonId: A, anonIp: '1.1.1.1', score: 4 })
  assert.equal(count(), 1)
  const a = agg()
  assert.equal(Number(a.rating_weight), WEIGHT_USER)
  assert.equal(Number(a.rating_sum), 4)
})

await check('撤匿名票只按 anon_id，不按 IP —— 不能顺手删掉室友的票', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 }) // 室友
  // 我用同一个出口 IP，但浏览器标识不同，且我是登录着的
  await vote({ gameId: 1, userId: 'u1', anonId: B, anonIp: '1.1.1.1', score: 1 })
  assert.equal(count(), 2)
  assert.ok(one('SELECT id FROM game_ratings WHERE anon_id = ?', A), '室友那票必须还在')
})

console.log('四、查询')

await check('findRating：登录只认 user_id，不会被同 IP 的匿名票串到', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  const mine = await findRating(run, 1, { userId: 'u9', anonId: A, anonIp: '1.1.1.1' })
  assert.equal(mine, null)
})

await check('findRating：匿名先按 anon_id、再按 IP', async () => {
  reset()
  await vote({ gameId: 1, anonId: A, anonIp: '1.1.1.1', score: 5 })
  assert.equal(Number((await findRating(run, 1, { anonId: A, anonIp: null })).score), 5)
  assert.equal(Number((await findRating(run, 1, { anonId: C, anonIp: '1.1.1.1' })).score), 5)
  assert.equal(await findRating(run, 1, { anonId: C, anonIp: '9.9.9.9' }), null)
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
