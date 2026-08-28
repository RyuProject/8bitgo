/**
 * 游玩去重的回归测试 —— 不连 MySQL，两部分：
 *
 *   一、身份指纹（src/playcount.js 真身，纯函数，直接测）
 *   二、去重语义（用内存 SQLite 建一张等价的 game_plays，
 *       跑和 games-repo.js 里同形的两条语句，验证「插进去了才 +1」这条规则）
 *
 *   node scripts/test-playcount.mjs
 *
 * 为什么值得单独测：这类 bug 在线上是「数字看着不太对」，没有报错、没有日志，
 * 等发现时历史数据已经脏了，回不去。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

process.env.PLAY_HASH_SECRET = 'test-secret'
const { playIdentity, clientIp } = await import('../src/playcount.js')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 造一个最小的 req：只有 playcount.js 真正读到的那几个字段 */
const req = ({ user, cf, xff, socket } = {}) => ({
  user,
  headers: { ...(cf ? { 'cf-connecting-ip': cf } : {}), ...(xff ? { 'x-forwarded-for': xff } : {}) },
  socket: { remoteAddress: socket },
})

console.log('一、身份指纹')

check('已登录 -> kind=u', () => {
  assert.equal(playIdentity(req({ user: { id: 'u_abc' }, cf: '1.2.3.4' })).kind, 'u')
})

check('登录后换 IP 仍是同一个身份（跨设备不重复计数）', () => {
  const a = playIdentity(req({ user: { id: 'u_abc' }, cf: '1.2.3.4' }))
  const b = playIdentity(req({ user: { id: 'u_abc' }, cf: '9.9.9.9' }))
  assert.equal(a.identity, b.identity)
})

check('同一 IP 下的两个账号是两个身份（宿舍/公司不互相顶掉）', () => {
  const a = playIdentity(req({ user: { id: 'u_abc' }, cf: '1.2.3.4' }))
  const b = playIdentity(req({ user: { id: 'u_xyz' }, cf: '1.2.3.4' }))
  assert.notEqual(a.identity, b.identity)
})

check('未登录 -> kind=i，同 IP 同身份、不同 IP 不同身份', () => {
  const a = playIdentity(req({ cf: '1.2.3.4' }))
  const b = playIdentity(req({ cf: '1.2.3.4' }))
  const c = playIdentity(req({ cf: '5.6.7.8' }))
  assert.equal(a.kind, 'i')
  assert.equal(a.identity, b.identity)
  assert.notEqual(a.identity, c.identity)
})

check('账号身份和 IP 身份不会撞（kind 分开 + 摘要前缀不同）', () => {
  const u = playIdentity(req({ user: { id: 'abc' } }))
  const i = playIdentity(req({ cf: 'abc' }))
  assert.notEqual(`${u.kind}${u.identity}`, `${i.kind}${i.identity}`)
})

check('IP 取值优先级：cf-connecting-ip > x-forwarded-for 第一段 > socket', () => {
  assert.equal(clientIp(req({ cf: '1.1.1.1', xff: '2.2.2.2', socket: '3.3.3.3' })), '1.1.1.1')
  assert.equal(clientIp(req({ xff: '2.2.2.2, 10.0.0.1', socket: '3.3.3.3' })), '2.2.2.2')
  assert.equal(clientIp(req({ socket: '3.3.3.3' })), '3.3.3.3')
})

check('既没登录又拿不到 IP -> null（不把这类请求塞进同一个身份）', () => {
  assert.equal(playIdentity(req()), null)
})

check('摘要是 43 字符 base64url，正好塞得进 CHAR(43)', () => {
  const { identity } = playIdentity(req({ cf: '1.2.3.4' }))
  assert.equal(identity.length, 43, `长度 ${identity.length}`)
  assert.match(identity, /^[A-Za-z0-9_-]{43}$/, '出现了 base64url 之外的字符')
})

check('不存明文 IP：摘要里找不到原地址', () => {
  assert.ok(!playIdentity(req({ cf: '203.0.113.7' })).identity.includes('203.0.113'))
})

console.log('\n二、去重语义（内存 SQLite，语句与 games-repo.js 同形）')

const db = new DatabaseSync(':memory:')
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE games (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, hidden INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE game_plays (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, identity TEXT NOT NULL,
    PRIMARY KEY (game_id, kind, identity)
  );
  INSERT INTO games (id, slug, hidden, plays) VALUES (1, 'contra', 0, 7), (2, 'secret', 1, 0);
`)

/** games-repo.js recordPlay() 的等价实现 */
function recordPlay(slug, kind, identity) {
  const ins = db
    .prepare('INSERT OR IGNORE INTO game_plays (game_id, kind, identity) SELECT id, ?, ? FROM games WHERE slug = ? AND hidden = 0')
    .run(kind, identity, slug)
  if (ins.changes === 0) return false
  db.prepare('UPDATE games SET plays = plays + 1 WHERE slug = ? AND hidden = 0').run(slug)
  return true
}
const plays = (slug) => db.prepare('SELECT plays FROM games WHERE slug = ?').get(slug).plays

check('第一次上报 -> 计上，plays 在原有数字上 +1（旧数据保留）', () => {
  assert.equal(recordPlay('contra', 'i', 'AAA'), true)
  assert.equal(plays('contra'), 8)
})

check('同一身份再报十次 -> 一次都不算', () => {
  for (let i = 0; i < 10; i++) assert.equal(recordPlay('contra', 'i', 'AAA'), false)
  assert.equal(plays('contra'), 8)
})

check('换个身份 -> 各算各的', () => {
  assert.equal(recordPlay('contra', 'i', 'BBB'), true)
  assert.equal(recordPlay('contra', 'u', 'CCC'), true)
  assert.equal(plays('contra'), 10)
})

check('同一身份玩另一款游戏 -> 算数（去重是按游戏分开的）', () => {
  db.exec("INSERT INTO games (id, slug, hidden, plays) VALUES (3, 'mario', 0, 0)")
  assert.equal(recordPlay('mario', 'i', 'AAA'), true)
  assert.equal(plays('mario'), 1)
})

check('已下架的游戏 -> 不计数也不留记录', () => {
  assert.equal(recordPlay('secret', 'i', 'AAA'), false)
  assert.equal(plays('secret'), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE game_id = 2').get().n, 0)
})

check('不存在的游戏 -> 不报错，返回没计上', () => {
  assert.equal(recordPlay('nope', 'i', 'AAA'), false)
})

check('大小写不同的摘要是两个人（base64url 区分大小写）', () => {
  const before = plays('mario')
  assert.equal(recordPlay('mario', 'i', 'aaa'), true, "'aaa' 被当成了 'AAA'")
  assert.equal(plays('mario'), before + 1)
})

check('删游戏时去重记录跟着级联清掉，不留孤儿', () => {
  db.exec("DELETE FROM games WHERE slug = 'mario'")
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE game_id = 3').get().n, 0)
})

console.log('\n三、MySQL 建表语句里的排序规则')

const src = (f) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8')

check('schema-v2.sql 的 identity 列是 ascii_bin（默认排序规则会把大小写当同一个人）', () => {
  const block = src('schema-v2.sql').split('CREATE TABLE IF NOT EXISTS game_plays')[1].split(';')[0]
  assert.match(block, /`?identity`?\s+CHAR\(43\)\s+CHARACTER SET ascii COLLATE ascii_bin/)
})

check('migrate.mjs 给老库补的表也是 ascii_bin（两边必须一致）', () => {
  assert.match(src('scripts/migrate.mjs'), /`identity` CHAR\(43\) CHARACTER SET ascii COLLATE ascii_bin/)
})

check('export-d1.mjs 会导出 game_plays（漏了的话 D1 上所有人重新计一次）', () => {
  assert.match(src('scripts/export-d1.mjs'), /'game_plays'/)
})

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 个用例未通过`)
process.exit(failed === 0 ? 0 : 1)
