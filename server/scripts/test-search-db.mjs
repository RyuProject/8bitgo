/**
 * 搜索功能的端到端测试：**要连数据库**，走的是真的 games-repo 代码路径。
 *
 * 用法（必须显式给一个测试库名，脚本会把这个库里的表删了重建）：
 *   cd server && SEARCH_TEST_DB=8bitgo_searchtest node scripts/test-search-db.mjs
 *
 * ⚠️ 故意不允许跑在 DB_NAME 上 —— 这个脚本会写入、改标题、删游戏，
 * 手滑指到生产库就是一场事故。没给 SEARCH_TEST_DB 直接拒绝执行。
 *
 * 覆盖的是「单元测试测不到」的那半边：索引维护有没有跟着写操作走、
 * 搜索能不能和平台筛选/分页组合、下架的会不会漏出去。
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const TEST_DB = process.env.SEARCH_TEST_DB
if (!TEST_DB) {
  console.error('❌ 需要显式指定测试库：SEARCH_TEST_DB=8bitgo_searchtest node scripts/test-search-db.mjs')
  console.error('   （这个脚本会删表重建并写入测试数据，不能跑在正式库上）')
  process.exit(1)
}
if (TEST_DB === process.env.DB_NAME) {
  console.error(`❌ SEARCH_TEST_DB 不能和 DB_NAME 一样（都是 ${TEST_DB}）`)
  process.exit(1)
}

// games-repo 通过 db.js 读 DB_NAME，这里在导入之前改掉，让它连到测试库
process.env.DB_NAME = TEST_DB

const admin = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
})
await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``)
await admin.query(`CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
await admin.query(`USE \`${TEST_DB}\``)
const schema = (await readFile(fileURLToPath(new URL('../schema-v2.sql', import.meta.url)), 'utf8'))
  .replace(/^\s*CREATE\s+DATABASE[\s\S]*?;\s*$/gim, '')
  .replace(/^\s*USE\s+[`'"]?[\w-]+[`'"]?\s*;\s*$/gim, '')
await admin.query(schema)
await admin.end()

const { upsertGame, listGames, suggestGames, searchFallback, patchGame, deleteGame } = await import('../src/games-repo.js')
const { pool, query } = await import('../src/db.js')

const games = [
  { slug: 'contra', title: 'Contra', titleZh: '魂斗罗', platform: 'nes', year: 1988, developer: 'Konami', tags: ['射击', '经典'], genres: ['shooter'] },
  { slug: 'super-contra', title: 'Super Contra', titleZh: '超级魂斗罗', platform: 'nes', year: 1990, developer: 'Konami', tags: ['射击'], genres: ['shooter'] },
  { slug: 'smb', title: 'Super Mario Bros.', titleZh: '超级马里奥兄弟', platform: 'nes', year: 1985, developer: 'Nintendo', tags: ['平台', '经典'], genres: ['platformer'] },
  { slug: 'smk', title: 'Super Mario Kart', titleZh: '超级马里奥赛车', platform: 'snes', year: 1992, developer: 'Nintendo', tags: ['竞速'], genres: ['racing'] },
  { slug: 'zelda-oot', title: 'The Legend of Zelda: Ocarina of Time', titleZh: '塞尔达传说：时之笛', platform: 'n64', year: 1998, developer: 'Nintendo', tags: ['冒险'], genres: ['adventure'] },
  { slug: 'zelda-loz', title: 'The Legend of Zelda', titleZh: '塞尔达传说', platform: 'nes', year: 1986, developer: 'Nintendo', tags: ['冒险', '经典'], genres: ['adventure'] },
  { slug: 'sf2', title: 'Street Fighter II', titleZh: '街头霸王2', platform: 'arcade', year: 1991, developer: 'Capcom', tags: ['格斗'], genres: ['fighting'] },
  { slug: 'hidden-one', title: 'Secret Contra', titleZh: '隐藏魂斗罗', platform: 'nes', year: 1999, developer: 'Konami', tags: [], genres: [], hidden: true },
]

const ok = []
const bad = []
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' — ' + extra : ''}`)
const titles = (r) => r.items.map((g) => g.titleZh || g.title)

try {
  for (const g of games) await upsertGame(g.slug, g)

  let r = await listGames({ q: '魂斗罗' })
  check('中文精确', titles(r)[0] === '魂斗罗' && r.total === 2, JSON.stringify(titles(r)))
  check('下架的不出现在公开搜索', !titles(r).includes('隐藏魂斗罗'))

  r = await listGames({ q: '魂鬥羅' })
  check('繁体查简体', titles(r)[0] === '魂斗罗', JSON.stringify(titles(r)))

  r = await listGames({ q: 'hdl' })
  check('首字母', titles(r)[0] === '魂斗罗', JSON.stringify(titles(r)))

  r = await listGames({ q: 'chaojimaliao' })
  check('全拼', titles(r).length === 2, JSON.stringify(titles(r)))

  r = await listGames({ q: '马里奥 超级' })
  check('多词乱序', titles(r).length === 2, JSON.stringify(titles(r)))

  r = await listGames({ q: '塞尔达时之笛' })
  check('中文不加空格 + 标题里夹字', titles(r)[0] === '塞尔达传说：时之笛', JSON.stringify(titles(r)))

  r = await listGames({ q: 'zelda', platform: 'nes' })
  check('搜索 + 平台筛选可组合', titles(r).length === 1 && titles(r)[0] === '塞尔达传说', JSON.stringify(titles(r)))

  r = await listGames({ q: 'konami' })
  check('开发商', r.total === 2, String(r.total))

  r = await listGames({ q: '经典' })
  check('标签', r.total === 3, String(r.total))

  r = await listGames({ q: 'zelda', pageSize: 1, page: 2 })
  check('分页正确', r.total === 2 && r.totalPages === 2 && r.items.length === 1, JSON.stringify([r.total, r.totalPages]))

  r = await listGames({ q: '！！！' })
  check('纯标点给空而不是给全部', r.total === 0, String(r.total))

  r = await listGames({ q: '不存在的游戏名' })
  check('搜不到就是搜不到', r.total === 0, String(r.total))

  r = await listGames({ q: 'zelda', sort: 'name' })
  check('显式排序优先于相关性', titles(r)[0] === '塞尔达传说', JSON.stringify(titles(r)))

  r = await listGames({ q: '魂斗罗', includeHidden: true })
  check('管理员视角能看到下架的', r.total === 3, String(r.total))

  const s = await suggestGames('塞尔')
  check('联想：前缀', s.length === 2 && s[0].titleZh.startsWith('塞尔达'), JSON.stringify(s.map((x) => x.titleZh)))
  const s2 = await suggestGames('sed')
  check('联想：拼音前缀', s2.length === 2, JSON.stringify(s2.map((x) => x.titleZh)))
  check('联想只回轻量字段', s[0] && !('tags' in s[0]) && !('roms' in s[0]), JSON.stringify(Object.keys(s[0] ?? {})))

  const fb = await searchFallback('街霸')
  check('兜底：缩写', fb.related[0]?.titleZh === '街头霸王2', JSON.stringify(fb.related.map((x) => x.titleZh)))
  const fb2 = await searchFallback('zeldaa')
  check('兜底：拼写纠正', fb2.suggestion === 'zelda', String(fb2.suggestion))

  // 索引维护：改了标题，旧标题就不该还能搜到（这是最容易漏的一类 bug）
  await patchGame('sf2', { title_zh: '快打旋风' }, {}, { titleZh: '快打旋风' })
  check('改译名后旧名搜不到了', (await listGames({ q: '街头霸王' })).total === 0)
  check('改译名后新名能搜到', (await listGames({ q: '快打旋风' })).total === 1)
  check('改译名后拼音也跟着更新', (await listGames({ q: 'kdxf' })).total === 1)

  const before = (await query('SELECT COUNT(*) n FROM game_search_tokens'))[0].n
  await deleteGame('smk')
  const after = (await query('SELECT COUNT(*) n FROM game_search_tokens'))[0].n
  check('删游戏级联清索引', after < before, `${before} -> ${after}`)
  check('删掉的搜不到了', (await listGames({ q: '超级马里奥赛车' })).total === 0)

  console.log(`通过 ${ok.length} 项`)
  for (const o of ok) console.log('  ✓ ' + o)
  if (bad.length) {
    console.log(`\n失败 ${bad.length} 项：`)
    for (const b of bad) console.log('  ✗ ' + b)
    process.exitCode = 1
  }
} catch (e) {
  console.error('❌ 测试异常：', e)
  process.exitCode = 1
} finally {
  await pool.end()
}
