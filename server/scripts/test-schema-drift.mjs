/**
 * check-schema-drift.mjs 的解析与对账逻辑（2026-11-15）。跑：cd server && npm run test:schema-drift
 * 用合成的迁移 / schema 文本触发每一类漏项，再对真仓库跑一遍确认当前是干净的。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze, parseAddColumns, parseCreates } from './check-schema-drift.mjs'

// 解析：字符串拼接的 CREATE、模板字符串里转义的反引号、一条 ALTER 加多列
const creates = parseCreates("CREATE TABLE IF NOT EXISTS `foo` (' + '`id` INT NOT NULL,' + '`name` VARCHAR(10) NULL, PRIMARY KEY (`id`), KEY idx_n (`name`))")
assert.deepEqual([...creates.get('foo')].sort(), ['id', 'name'])
const added = parseAddColumns("conn.query(`ALTER TABLE `games`\n ADD COLUMN `a` INT,\n ADD COLUMN `b` INT`)\nconn.query('ALTER TABLE `users` ADD COLUMN `c` INT')")
assert.deepEqual([...added].sort(), ['games.a', 'games.b', 'users.c'])

const base = {
  migrateSrc: "conn.query('CREATE TABLE IF NOT EXISTS `t1` (`id` INT, `x` INT)')\nconn.query('ALTER TABLE `games` ADD COLUMN `c1` INT')",
  schemaV2Sql: 'CREATE TABLE games (id INT, legacy INT);\nCREATE TABLE only_v2 (id INT);',
  expectedTables: [{ table: 't1' }, { table: 'only_v2' }],
  expectedColumns: [{ table: 'games', column: 'c1' }, { table: 't1', column: 'x' }],
  tableAllow: {},
  columnAllow: {},
}
assert.deepEqual(analyze(base).problems, [], '一致时没有问题')

// A：期望的表谁都不建
let r = analyze({ ...base, expectedTables: [...base.expectedTables, { table: 'ghost' }] })
assert.ok(r.problems.some((p) => p.includes('期望表 ghost')))
// B：期望的列只在 schema-v2 里（旧库补不上）
r = analyze({ ...base, expectedColumns: [...base.expectedColumns, { table: 'games', column: 'legacy' }] })
assert.ok(r.problems.some((p) => p.includes('期望列 games.legacy')))
// C：迁移补了列却没登记；迁移建了表却没登记
r = analyze({ ...base, expectedColumns: [{ table: 't1', column: 'x' }] })
assert.ok(r.problems.some((p) => p.includes('补了列 games.c1')))
r = analyze({ ...base, expectedTables: [{ table: 'only_v2' }] })
assert.ok(r.problems.some((p) => p.includes('建了表 t1')))
// 白名单生效，且失效的白名单条目会被点名
assert.deepEqual(analyze({ ...base, expectedTables: [{ table: 'only_v2' }], tableAllow: { t1: '测试' } }).problems, [])
r = analyze({ ...base, tableAllow: { gone: '测试' }, columnAllow: { 'games.gone': '测试' } })
assert.ok(r.problems.some((p) => p.includes('TABLE_ALLOWLIST 里的 gone')))
assert.ok(r.problems.some((p) => p.includes('COLUMN_ALLOWLIST 里的 games.gone')))
// 注释里的示例 SQL 不算迁移
assert.deepEqual(analyze({ ...base, migrateSrc: base.migrateSrc + "\n// conn.query('ALTER TABLE `games` ADD COLUMN `zz` INT')\n/* CREATE TABLE nope (id INT) */" }).problems, [])

// 真仓库当前必须干净
const { EXPECTED_TABLES, EXPECTED_COLUMNS } = await import('../src/schema-check.js')
const real = analyze({
  migrateSrc: readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8'),
  schemaV2Sql: readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8'),
  expectedTables: EXPECTED_TABLES,
  expectedColumns: EXPECTED_COLUMNS,
})
assert.deepEqual(real.problems, [])

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
assert.match(pkg.scripts.prebuild, /check-schema-drift\.mjs/, 'prebuild 要跑迁移对账')
console.log('✔ 迁移漏项检查：解析、三类对账、白名单与真仓库')
