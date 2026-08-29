/**
 * 生成可直接执行的建库 SQL。两种产物，都由同一份 schema.sql 派生，不会互相跑偏：
 *   node scripts/gen-sql.mjs          -> 8bitgo-setup.sql        建库建表 + 全部内置数据
 *   node scripts/gen-sql.mjs --empty  -> 8bitgo-setup-empty.sql  只建库建表，一条数据都不插
 *
 * 用法：cd server && npm run gen-sql（或 npm run gen-sql:empty）
 *
 * 说明：用 esbuild 直接读取前端的 src/data/*.ts，转成 INSERT ... ON DUPLICATE KEY UPDATE，
 * 因此重复执行是安全的（幂等）。JSON 列（genres/tags/roms）以字符串字面量写入。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gameApiToRow, postApiToRow } from '../src/mappers.js'

async function loadTsArray(relPath, exportName) {
  const { build } = await import('esbuild')
  const entry = fileURLToPath(new URL(relPath, import.meta.url))
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  const code = r.outputFiles[0].text
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  return mod[exportName]
}

/** MySQL 字符串字面量转义 */
function sqlStr(s) {
  return "'" + String(s).replace(/[\0\b\n\r\t\x1a\\'"]/g, (ch) => {
    switch (ch) {
      case '\0': return '\\0'
      case '\b': return '\\b'
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      case '\x1a': return '\\Z'
      case '\\': return '\\\\'
      case "'": return "\\'"
      case '"': return '\\"'
      default: return ch
    }
  }) + "'"
}

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0'
  if (typeof v === 'boolean') return v ? '1' : '0'
  return sqlStr(v)
}

function buildUpsertSQL(table, row, pk) {
  const cols = Object.keys(row)
  const vals = cols.map((c) => sqlVal(row[c]))
  const updates = cols.filter((c) => c !== pk).map((c) => `\`${c}\`=VALUES(\`${c}\`)`).join(', ')
  return `INSERT INTO \`${table}\` (${cols.map((c) => '`' + c + '`').join(', ')}) VALUES (${vals.join(', ')})\n  ON DUPLICATE KEY UPDATE ${updates};`
}

/** 给老库补列 / 补索引。CREATE TABLE IF NOT EXISTS 对已存在的表无效，只能这样打补丁。
 *  MySQL 没有 CREATE INDEX IF NOT EXISTS，用 information_schema 判一下再动态执行。 */
const PATCHES = [
  ['COLUMNS', 'games', 'created_at', "ALTER TABLE `games` ADD COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `roms`"],
  ['COLUMNS', 'games', 'adult', "ALTER TABLE `games` ADD COLUMN `adult` TINYINT(1) NOT NULL DEFAULT 0 AFTER `body_control`"],
  ['STATISTICS', 'favorites', 'idx_fav_game', "ALTER TABLE `favorites` ADD INDEX `idx_fav_game` (`game_slug`)"],
  ['STATISTICS', 'recents', 'idx_recent_game', "ALTER TABLE `recents` ADD INDEX `idx_recent_game` (`game_slug`)"],
]
  .map(([kind, table, name, ddl]) => {
    const col = kind === 'COLUMNS' ? 'column_name' : 'index_name'
    return [
      `SET @sql := IF(`,
      `  (SELECT COUNT(*) FROM information_schema.${kind}`,
      `     WHERE table_schema = DATABASE() AND table_name = '${table}' AND ${col} = '${name}') > 0,`,
      `  'SELECT 1', ${sqlStr(ddl)});`,
      `PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;`,
    ].join('\n')
  })
  .concat([
    '-- 清理孤儿收藏 / 最近游玩（指向已被删除的游戏）',
    'DELETE f FROM favorites f LEFT JOIN games g ON g.slug = f.game_slug WHERE g.slug IS NULL;',
    'DELETE r FROM recents   r LEFT JOIN games g ON g.slug = r.game_slug WHERE g.slug IS NULL;',
  ])
  .join('\n\n')

const EMPTY = process.argv.includes('--empty')

// 空表版本不需要读前端数据，连 esbuild 都省了
const games = EMPTY ? [] : await loadTsArray('../../src/data/games.ts', 'games')
const posts = EMPTY ? [] : await loadTsArray('../../src/data/posts.ts', 'posts')

const OUT_NAME = EMPTY ? '8bitgo-setup-empty.sql' : '8bitgo-setup.sql'

// schema.sql 末尾那段「补丁在 migrate.mjs 里」是给读源码的人看的；
// 生成出来的文件把补丁直接带在下面，留着那句反而让人以为还要另外跑 migrate。
const schema = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8')
  .replace(/\n-- 注意：上面都是 CREATE TABLE IF NOT EXISTS[\s\S]*$/, '')
  .trimEnd()

const parts = []
parts.push('-- ============================================================')
parts.push(EMPTY ? '-- 8BitGo 建库脚本（空表版）：只建库建表，不插入任何数据'
                 : '-- 8BitGo 一键建库脚本：建库 + 建表 + 导入全部内置数据')
parts.push('-- 直接粘进 DBGate 的 SQL 查询窗口执行即可（可重复执行，幂等）。')
parts.push(EMPTY ? '-- 表建好后是空的，游戏和文章到后台自己加。'
                 : `-- 生成内容：${games.length} 款游戏、${posts.length} 篇文章`)
parts.push('-- ============================================================')
parts.push('')
parts.push('-- 用法：')
parts.push(`--   mysql -u root -p < ${OUT_NAME}`)
parts.push('--   或直接把整个文件粘进 DBGate / Navicat / phpMyAdmin 的 SQL 窗口执行')
parts.push('--')
parts.push('-- 三种情况都能用：')
parts.push(EMPTY ? '--   全新的库      -> 建库建表（空表）'
                 : '--   全新的库      -> 建库建表 + 灌入全部内置数据')
parts.push(EMPTY ? '--   已有的旧库    -> 补上后加的列和索引，清掉孤儿数据，已有数据一律不动'
                 : '--   已有的旧库    -> 补上后加的列和索引，清掉孤儿数据，再按 slug 覆盖内置条目')
parts.push('--   重复执行      -> 幂等，不会重复插入，也不会动用户数据')
parts.push('--')
parts.push(EMPTY ? '-- 不会碰的东西：库里已有的任何数据。这个版本只负责把表结构弄对。'
                 : '-- 不会碰的东西：users / favorites / recents 里的真实数据，')
if (!EMPTY) parts.push('-- 以及你自己在后台加的、不在内置目录里的游戏和文章。')
parts.push('')
parts.push('-- 强制 utf8mb4：客户端默认 latin1 时中文会被双重编码存成乱码')
parts.push('SET NAMES utf8mb4;')
parts.push('')
parts.push('-- ---------- 1. 表结构 ----------')
parts.push(schema)
parts.push('')
parts.push('USE `8bitgo`;')
parts.push('')
parts.push('-- ---------- 1b. 老库升级 ----------')
parts.push('-- 上面是 CREATE TABLE IF NOT EXISTS，对**已经建好**的表不会补新增的列和索引，')
parts.push('-- 所以这里逐条判断后再补。全新的库会全部跳过；重复执行没有副作用。')
parts.push(PATCHES)
parts.push('')
if (EMPTY) {
  parts.push('-- ---------- 2. 数据 ----------')
  parts.push('-- 空表版本不插入任何游戏 / 文章。要灌内置目录有两条路：')
  parts.push('--   A) 执行 8bitgo-setup.sql（同目录，带全部内置数据）')
  parts.push('--   B) 后台「数据 → 导入内置数据到数据库」，或 `cd server && npm run seed`')
  parts.push('')
} else {
  parts.push(`-- ---------- 2. 游戏数据（${games.length} 条）----------`)
  for (const g of games) parts.push(buildUpsertSQL('games', gameApiToRow(g), 'slug'))
  parts.push('')
  parts.push(`-- ---------- 3. 博客文章（${posts.length} 条）----------`)
  for (const p of posts) parts.push(buildUpsertSQL('posts', postApiToRow(p), 'slug'))
  parts.push('')
}
parts.push(`-- ---------- ${EMPTY ? 3 : 4}. 管理员账号 ----------`)
parts.push('-- 管理员不在此脚本创建（需要密码哈希）。两种方式二选一：')
parts.push('--   A) 在网站上正常注册一个账号，然后在 DBGate 执行（把邮箱换成你的）：')
parts.push("--      UPDATE users SET role='admin' WHERE email='you@example.com';")
parts.push('--   B) 在服务器上：server/.env 填 ADMIN_EMAIL / ADMIN_PASSWORD，然后 `npm run seed`。')
parts.push('')
parts.push('-- 完成。可执行以下语句自检：')
parts.push("SELECT 'games' AS t, COUNT(*) AS n FROM games")
parts.push("UNION ALL SELECT 'posts', COUNT(*) FROM posts")
parts.push("UNION ALL SELECT 'users', COUNT(*) FROM users;")
if (!EMPTY) {
  parts.push('')
  parts.push('-- 内置数据里 plays / rating / coin_reward 应该全是 0（游玩次数由玩家真实累加）。')
  parts.push('-- 下面这句正常应返回 0 行。若返回了几行，说明那几款是你自己加的、不在内置目录里，')
  parts.push('-- 本脚本不会去动它们 —— 要清掉它们的旧假数值，跑 `cd server && npm run reset-fake-data`。')
  parts.push('SELECT slug, plays, rating, coin_reward FROM games')
  parts.push('  WHERE plays <> 0 OR rating <> 0 OR rating_count <> 0 OR coin_reward <> 0;')
}
parts.push('')

const out = fileURLToPath(new URL(EMPTY ? '../8bitgo-setup-empty.sql' : '../8bitgo-setup.sql', import.meta.url))
writeFileSync(out, parts.join('\n'), 'utf8')
console.log(`✅ 生成 ${out}`)
console.log(EMPTY ? '   空表版：只建库建表，未插入任何数据' : `   游戏 ${games.length} 条、文章 ${posts.length} 条`)
