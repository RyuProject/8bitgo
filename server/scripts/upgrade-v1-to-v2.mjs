/**
 * v1 → v2 结构升级，**带着数据一起升**。
 *
 * 用法（默认只看不动，确认没问题再加 --yes）：
 *   cd server
 *   node scripts/upgrade-v1-to-v2.mjs          # 演练：只打印会发生什么
 *   node scripts/upgrade-v1-to-v2.mjs --yes    # 真的执行
 *
 * 和 8bitgo-v2-install.sql 的区别：那个是删表重建，数据全丢。
 * 这个脚本把 v1 的表**改名留着**（games_v1bak 之类），建好 v2 表之后再把数据搬过去。
 * 管理员账号、注册用户、游戏、文章、收藏、最近游玩，全部保留。
 * 出了任何问题，老表还在原地，随时能回滚。
 *
 * 会怎么转：
 *   users      1:1 搬过去。created_at 从 VARCHAR 转成 TIMESTAMP，coins 负数夹到 0（v2 是 UNSIGNED）
 *   games      标量列直接搬；genres / tags / roms 三个 JSON 列拆进各自的关联表；
 *              v1 的 rom 那一列并进 game_roms 的通用语言 '*'；
 *              added_at 从 VARCHAR 转 DATE（转不出来就留空，后端会用 created_at 兜底）；
 *              rating / rating_count 不搬 —— v2 把评分整个去掉了
 *   posts      同上，tags 拆进 post_tags，date 转 DATE
 *   favorites  game_slug → game_id；指向已不存在的游戏的记录会被丢掉（会告诉你丢了几条）
 *   recents    同上
 *
 * 执行前**务必**先备份（脚本自己也会导一份 JSON，但 mysqldump 才是正经的）：
 *   mysqldump -u root -p <你的库名> > backup-$(date +%F).sql
 */
import 'dotenv/config'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const DB_NAME = process.env.DB_NAME || '8bitgo'
const GO = process.argv.includes('--yes')
const GENERIC_ROM_LANG = '*'
/** v1 表改名之后的后缀。留着不删，回滚就靠它 */
const BAK = '_v1bak'
const V1_TABLES = ['games', 'posts', 'users', 'favorites', 'recents']

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: DB_NAME,
  multipleStatements: true,
  // 大表一次读回来会顶到默认的 packet 上限
  maxPreparedStatements: 100,
})

const all = async (q, p) => (await conn.query(q, p))[0]
const one = async (q, p) => (await all(q, p))[0]

async function hasTable(t) {
  const r = await one(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [t],
  )
  return Number(r?.n ?? 0) > 0
}
async function columnsOf(t) {
  const rows = await all(
    'SELECT column_name AS c FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ?',
    [t],
  )
  return new Set(rows.map((r) => String(r.c)))
}

/** JSON 列在 mysql2 里可能已经解析成对象，也可能还是字符串，两种都要接住 */
function asJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  try {
    return JSON.parse(String(v))
  } catch {
    return fallback
  }
}
/**
 * 时间列的两种来源都要接住：
 *   VARCHAR 的（v1 的 users.created_at / games.added_at / posts.date）→ 字符串
 *   TIMESTAMP 的（v1 的 favorites.created_at / recents.played_at）→ mysql2 会回一个 **Date 对象**
 *
 * 只认字符串是不行的：Date 对象 String() 出来是 "Fri Aug 01 2025 09:00:00 GMT+0000"，
 * 正则匹配不上就变成 null，而 MySQL 往 NOT NULL DEFAULT CURRENT_TIMESTAMP 的列里插 NULL
 * 会填成**当前时间** —— 所有人的「最近游玩」时间戳会齐刷刷变成迁移那一刻。
 */
function pad(n) {
  return String(n).padStart(2, '0')
}
function fromDateObj(d) {
  if (Number.isNaN(d.getTime())) return null
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  }
}
function parseTime(v) {
  if (!v) return null
  if (v instanceof Date) return fromDateObj(v)
  const s = String(v).trim()
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) {
    // 也可能是 Date 能认、正则认不出的格式，最后试一次
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : fromDateObj(d)
  }
  return {
    date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
    time: m[4] ? `${pad(Number(m[4]))}:${m[5]}:${m[6] ?? '00'}` : '00:00:00',
  }
}
/** → DATE 能吃的 'YYYY-MM-DD'，认不出来给 null */
function asDate(v) {
  return parseTime(v)?.date ?? null
}
/** → DATETIME 能吃的 'YYYY-MM-DD HH:MM:SS'，**保留原本的时分秒** */
function asDateTime(v) {
  const t = parseTime(v)
  return t ? `${t.date} ${t.time}` : null
}

const log = (...a) => console.log(...a)

try {
  /* ---------------- 体检 ---------------- */
  const version = !(await hasTable('games')) ? 'fresh' : (await hasTable('game_tags')) ? 'v2' : 'v1'
  const server = await one('SELECT VERSION() AS v')
  log(`数据库：${DB_NAME}（${server?.v ?? '?'}）　结构：${version}\n`)

  if (version === 'v2') {
    log('这个库已经是 v2 了，不需要升级。')
    process.exit(0)
  }
  if (version === 'fresh') {
    log('这是个空库，没有 v1 数据要搬。直接跑 `npm run migrate` 就会建成 v2。')
    process.exit(0)
  }
  for (const t of V1_TABLES) {
    if (await hasTable(t + BAK)) {
      log(`❌ ${t}${BAK} 已经存在 —— 说明这个脚本跑过一次了。`)
      log('   要重来的话先把这些 *_v1bak 表处理掉（确认数据已经搬好就 DROP，没搬好就先改回去）。')
      process.exit(1)
    }
  }

  /* ---------------- 读出全部 v1 数据 ---------------- */
  const gameCols = await columnsOf('games')
  const games = await all('SELECT * FROM games')
  const posts = (await hasTable('posts')) ? await all('SELECT * FROM posts') : []
  const users = (await hasTable('users')) ? await all('SELECT * FROM users') : []
  const favs = (await hasTable('favorites')) ? await all('SELECT * FROM favorites') : []
  const recents = (await hasTable('recents')) ? await all('SELECT * FROM recents') : []

  const admins = users.filter((u) => u.role === 'admin')
  let genreN = 0
  let tagN = 0
  let romN = 0
  for (const g of games) {
    genreN += asJson(g.genres, []).length
    tagN += asJson(g.tags, []).length
    romN += Object.keys(romsOfRow(g)).length
  }
  const slugSet = new Set(games.map((g) => g.slug))
  const favDrop = favs.filter((f) => !slugSet.has(f.game_slug)).length
  const recDrop = recents.filter((r) => !slugSet.has(r.game_slug)).length

  log('准备搬运：')
  log(`  users      ${String(users.length).padStart(6)} 个（其中管理员 ${admins.length} 个${admins.length ? '：' + admins.map((u) => u.email).join('、') : ''}）`)
  log(`  games      ${String(games.length).padStart(6)} 款 → 另拆出 ${genreN} 条类型、${tagN} 条标签、${romN} 条 ROM`)
  log(`  posts      ${String(posts.length).padStart(6)} 篇`)
  log(`  favorites  ${String(favs.length).padStart(6)} 条${favDrop ? `（${favDrop} 条指向已删除的游戏，会丢掉）` : ''}`)
  log(`  recents    ${String(recents.length).padStart(6)} 条${recDrop ? `（${recDrop} 条指向已删除的游戏，会丢掉）` : ''}`)
  log(`\n不搬：games.rating / rating_count（v2 已经没有评分这个概念）`)

  if (!GO) {
    log('\n这是演练，什么都没改。确认无误后加 --yes 再跑一次：')
    log('  node scripts/upgrade-v1-to-v2.mjs --yes')
    log('\n⚠️  真跑之前先 mysqldump 备份一份：')
    log(`  mysqldump -u ${process.env.DB_USER || 'root'} -p ${DB_NAME} > backup-v1.sql`)
    process.exit(0)
  }

  /* ---------------- 先落一份 JSON 备份 ---------------- */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = fileURLToPath(new URL(`../backup-v1-${stamp}.json`, import.meta.url))
  await writeFile(backupPath, JSON.stringify({ games, posts, users, favorites: favs, recents }, null, 2), 'utf8')
  log(`\n已导出 JSON 备份：${backupPath}`)

  /* ---------------- 老表改名让位 ---------------- */
  // 外键约束名在同一个库里必须唯一，老表带着 fk_fav_user 这类名字改名之后，
  // 新建 v2 表会撞名（errno 121）。所以先把老表上的外键拆掉，只留数据。
  const fks = await all(
    `SELECT table_name AS t, constraint_name AS c FROM information_schema.TABLE_CONSTRAINTS
      WHERE table_schema = DATABASE() AND constraint_type = 'FOREIGN KEY'`,
  )
  for (const { t, c } of fks) {
    await conn.query(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${c}\``)
  }
  if (fks.length) log(`已拆掉 ${fks.length} 条老表外键（约束名要让给新表）`)

  for (const t of V1_TABLES) {
    if (await hasTable(t)) await conn.query(`RENAME TABLE \`${t}\` TO \`${t}${BAK}\``)
  }
  log(`老表已改名：${V1_TABLES.map((t) => t + BAK).join('、')}（数据都还在，回滚就靠它们）`)

  /* ---------------- 建 v2 表 ---------------- */
  const schema = (await readFile(fileURLToPath(new URL('../schema-v2.sql', import.meta.url)), 'utf8'))
    .replace(/^\s*CREATE\s+DATABASE[\s\S]*?;\s*$/gim, '')
    .replace(/^\s*USE\s+[`'"]?[\w-]+[`'"]?\s*;\s*$/gim, '')
  await conn.query(schema)
  log('v2 表已建好')

  /* ---------------- 搬数据 ---------------- */
  // users 先搬：favorites / recents 的外键指着它
  if (users.length) {
    const vals = users.map((u) => [
      u.id,
      u.email,
      u.nickname,
      u.avatar || '🕹️',
      u.password_hash,
      Math.max(0, Number(u.coins) || 0),
      u.role === 'admin' ? 'admin' : 'user',
      u.status === 'banned' ? 'banned' : 'active',
      asDateTime(u.created_at) ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
    ])
    await insertBatch(
      'INSERT INTO users (id, email, nickname, avatar, password_hash, coins, role, status, created_at) VALUES',
      9,
      vals,
    )
  }
  log(`  users      ${users.length} 个已搬（管理员 ${admins.length} 个）`)

  const slugToId = new Map()
  if (games.length) {
    const has = (c) => gameCols.has(c)
    const vals = games.map((g) => [
      g.slug,
      g.title,
      g.title_zh ?? null,
      g.platform,
      Math.max(0, Number(g.year) || 0),
      g.developer || '',
      Math.max(0, Number(g.plays) || 0),
      Math.max(1, Number(g.players) || 1),
      g.multiplayer ? 1 : 0,
      Math.max(0, Number(g.coin_reward) || 0),
      g.icon || '🎮',
      g.cover ?? null,
      g.video ?? null,
      g.description ?? null,
      has('description_en') ? (g.description_en ?? null) : null,
      g.body_control ? 1 : 0,
      g.hidden ? 1 : 0,
      has('core') ? (g.core ?? null) : null,
      has('home_rank') ? (g.home_rank ?? null) : null,
      asDate(g.added_at),
    ])
    await insertBatch(
      'INSERT INTO games (slug, title, title_zh, platform, `year`, developer, plays, players, multiplayer, coin_reward, icon, cover, video, description, description_en, body_control, hidden, core, home_rank, added_at) VALUES',
      20,
      vals,
    )
    for (const r of await all('SELECT id, slug FROM games')) slugToId.set(r.slug, r.id)
  }
  log(`  games      ${games.length} 款已搬`)

  const genreVals = []
  const tagVals = []
  const romVals = []
  for (const g of games) {
    const id = slugToId.get(g.slug)
    if (!id) continue
    for (const gid of new Set(asJson(g.genres, []).filter((x) => typeof x === 'string' && x))) genreVals.push([id, gid])
    for (const tg of new Set(asJson(g.tags, []).map((x) => String(x).trim()).filter(Boolean))) tagVals.push([id, tg])
    for (const [lang, key] of Object.entries(romsOfRow(g))) romVals.push([id, lang, key])
  }
  if (genreVals.length) await insertBatch('INSERT IGNORE INTO game_genres (game_id, genre_id) VALUES', 2, genreVals)
  if (tagVals.length) await insertBatch('INSERT IGNORE INTO game_tags (game_id, tag) VALUES', 2, tagVals)
  if (romVals.length) await insertBatch('INSERT IGNORE INTO game_roms (game_id, lang, object_key) VALUES', 3, romVals)
  log(`  关联表     类型 ${genreVals.length} / 标签 ${tagVals.length} / ROM ${romVals.length} 条已搬`)

  const postSlugToId = new Map()
  if (posts.length) {
    const vals = posts.map((p) => [
      p.slug,
      p.title,
      p.excerpt ?? null,
      p.content || '',
      p.icon || '📝',
      p.author || '',
      asDate(p.date),
      p.published ? 1 : 0,
    ])
    await insertBatch('INSERT INTO posts (slug, title, excerpt, content, icon, author, `date`, published) VALUES', 8, vals)
    for (const r of await all('SELECT id, slug FROM posts')) postSlugToId.set(r.slug, r.id)
    const ptags = []
    for (const p of posts) {
      const id = postSlugToId.get(p.slug)
      if (!id) continue
      for (const tg of new Set(asJson(p.tags, []).map((x) => String(x).trim()).filter(Boolean))) ptags.push([id, tg])
    }
    if (ptags.length) await insertBatch('INSERT IGNORE INTO post_tags (post_id, tag) VALUES', 2, ptags)
    log(`  posts      ${posts.length} 篇已搬（标签 ${ptags.length} 条）`)
  }

  const userIds = new Set(users.map((u) => u.id))
  const favVals = favs
    .filter((f) => slugToId.has(f.game_slug) && userIds.has(f.user_id))
    .map((f) => [f.user_id, slugToId.get(f.game_slug), asDateTime(f.created_at)])
  if (favVals.length) {
    await insertBatch('INSERT IGNORE INTO favorites (user_id, game_id, created_at) VALUES', 3, favVals, true)
  }
  log(`  favorites  ${favVals.length} 条已搬${favs.length - favVals.length ? `（丢弃 ${favs.length - favVals.length} 条孤儿）` : ''}`)

  const recVals = recents
    .filter((r) => slugToId.has(r.game_slug) && userIds.has(r.user_id))
    .map((r) => [r.user_id, slugToId.get(r.game_slug), asDateTime(r.played_at ?? r.created_at)])
  if (recVals.length) {
    await insertBatch('INSERT IGNORE INTO recents (user_id, game_id, played_at) VALUES', 3, recVals, true)
  }
  log(`  recents    ${recVals.length} 条已搬${recents.length - recVals.length ? `（丢弃 ${recents.length - recVals.length} 条孤儿）` : ''}`)

  /* ---------------- 收尾核对 ---------------- */
  log('\n核对（新表 / 老表）：')
  for (const [t, before] of [['games', games.length], ['posts', posts.length], ['users', users.length]]) {
    const r = await one(`SELECT COUNT(*) AS n FROM \`${t}\``)
    const okMark = Number(r.n) === before ? '✅' : '⚠️ '
    log(`  ${okMark} ${t.padEnd(10)} ${String(r.n).padStart(6)} / ${String(before).padStart(6)}`)
  }
  const adminNow = await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
  log(`  ${Number(adminNow.n) === admins.length ? '✅' : '⚠️ '} 管理员账号   ${adminNow.n} / ${admins.length}`)

  log('\n✅ 升级完成。接下来：')
  log('   1. npm run migrate           # 补上 v2 之后新增的东西（搜索索引表等）')
  log('   2. npm run backfill-search   # 把游戏灌进搜索索引，不跑的话搜索是空的')
  log('   3. 打开站点确认一切正常')
  log(`   4. 确认没问题之后再删老表：DROP TABLE ${V1_TABLES.map((t) => t + BAK).join(', ')};`)
  log(`\n   出问题要回滚：老表都还在，JSON 备份在 ${backupPath}`)
} catch (e) {
  console.error('\n❌ 升级失败：', e.message)
  console.error('   老表（*_v1bak）没有被删除，数据还在。修好问题之后可以重来。')
  process.exitCode = 1
} finally {
  await conn.end()
}

/** v1 的 rom 那一列 + roms JSON，合成 v2 的 game_roms 形状 */
function romsOfRow(g) {
  const out = {}
  if (g?.rom && String(g.rom).trim()) out[GENERIC_ROM_LANG] = String(g.rom).trim()
  for (const [lang, key] of Object.entries(asJson(g?.roms, {}) ?? {})) {
    if (typeof key === 'string' && key.trim()) out[lang] = key.trim()
  }
  return out
}

/** 分批插入。一条 INSERT 塞太多占位符会顶到 max_allowed_packet */
async function insertBatch(prefix, width, values, ignore = false) {
  const per = Math.max(1, Math.floor(800 / width))
  for (let i = 0; i < values.length; i += per) {
    const part = values.slice(i, i + per)
    const holes = part.map(() => `(${Array(width).fill('?').join(',')})`).join(',')
    await conn.query(`${prefix} ${holes}${ignore ? '' : ''}`, part.flat())
  }
}
