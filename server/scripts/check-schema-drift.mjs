#!/usr/bin/env node
/**
 * 迁移漏项检查（2026-11-15 系统优化 #6）。不连库，纯静态对账：
 *   node server/scripts/check-schema-drift.mjs        （prebuild 会跑）
 *
 * 三份东西必须互相对得上，以前全靠人记：
 *   - src/schema-check.js 的 EXPECTED_TABLES / EXPECTED_COLUMNS：启动时提醒「库落后于代码」；
 *   - scripts/migrate.mjs：真正给**已有库**补表补列的地方；
 *   - schema-v2.sql：只对全新库生效（CREATE TABLE IF NOT EXISTS 不会给旧表加列）。
 *
 * 踩过的坑：
 *   - 只在 schema-v2.sql 里加了表 / 列、忘了写进 migrate.mjs —— 新库好的、生产库永远缺（§2.15 saves 表）；
 *   - 写了迁移、忘了登记进 schema-check —— 生产机没跑 migrate 时一句提醒都没有，只有某条接口 500；
 *   - 登记了 schema-check、迁移里没有 —— 启动永远告警，运维照提示跑完 migrate 什么都没变。
 *
 * 所以这里检查三件事：
 *   A. schema-check 期望的每张表，migrate 都会建（migrate.mjs 里 CREATE，或它加载的 schema-v2.sql 里 CREATE）；
 *   B. schema-check 期望的每个列，migrate.mjs 都会补（ADD COLUMN，或这张表本身就是 migrate.mjs 建的）；
 *   C. 反过来：migrate.mjs 建的表 / 补的列都登记在 schema-check 里，除非在下面的白名单里写明了原因。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * migrate.mjs 建了、但 schema-check 故意不查的表。每条写原因。
 * 新增迁移时首选登记进 schema-check；只有「查了反而误报 / 缺了也不影响任何接口」才放这里。
 */
export const TABLE_ALLOWLIST = {
  oauth_authorizations: '当前代码不查（access token 自包含、长期授权未启用）；登记会对正常库误报缺表（见 schema-check.js 注释）',
  oauth_tokens: '同上：refresh token 尚未启用，代码不读写',
}

/**
 * migrate.mjs 补了、但 schema-check 故意不查的列。键为 `表.列`，每条写原因。
 * 这批绝大多数是 v1 → v2 迁移期加的列：早于 schema-check 存在，生产库早已补齐；
 * 新加的列不要往这里塞，应当登记进 EXPECTED_COLUMNS。
 */
export const COLUMN_ALLOWLIST = {}

/** 去掉 JS 注释，免得注释里举例的 SQL 被当成迁移 */
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

const unescape = (s) => s.replace(/\\`/g, '`')

/** CREATE TABLE 名 → 列名集合，同时记下重复列（MySQL 会拒绝整份建表语句）。 */
function parseCreateDefinitions(sql) {
  const out = new Map()
  const duplicates = []
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(/gi
  let m
  while ((m = re.exec(sql))) {
    let depth = 1
    let i = re.lastIndex
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') depth--
    }
    const body = sql.slice(re.lastIndex, i - 1)
    const cols = new Set(out.get(m[1].toLowerCase()) ?? [])
    // 按顶层逗号切
    let level = 0
    let start = 0
    const parts = []
    for (let j = 0; j <= body.length; j++) {
      const ch = body[j]
      if (ch === '(') level++
      else if (ch === ')') level--
      else if ((ch === ',' && level === 0) || j === body.length) {
        parts.push(body.slice(start, j))
        start = j + 1
      }
    }
    for (const part of parts) {
      const p = part.replace(/'\s*\+\s*'/g, ' ').trim()
      const id = /^`?(\w+)`?\s/.exec(p)
      if (!id) continue
      if (/^(PRIMARY|KEY|UNIQUE|INDEX|CONSTRAINT|FULLTEXT|FOREIGN|CHECK)$/i.test(id[1])) continue
      const column = id[1].toLowerCase()
      if (cols.has(column)) duplicates.push(`${m[1].toLowerCase()}.${column}`)
      else cols.add(column)
    }
    out.set(m[1].toLowerCase(), cols)
  }
  return { tables: out, duplicates }
}

/** CREATE TABLE 名 → 列名集合（按括号配对取出表体）。 */
export function parseCreates(sql) {
  return parseCreateDefinitions(sql).tables
}

/** ALTER TABLE 表 ... ADD COLUMN 列：返回 Set('表.列') */
export function parseAddColumns(sql) {
  const out = new Set()
  const re = /ALTER\s+TABLE\s+`?(\w+)`?/gi
  const hits = [...sql.matchAll(re)]
  hits.forEach((h, idx) => {
    const end = idx + 1 < hits.length ? hits[idx + 1].index : sql.length
    // 一条 ALTER 语句最多到下一条 ALTER，且不会长于 1500 字符（多列 ADD 的那种也在内）
    const chunk = sql.slice(h.index, Math.min(end, h.index + 1500))
    const stmtEnd = chunk.search(/['"]\s*\)|`\s*\)|;/)
    const stmt = stmtEnd > 0 ? chunk.slice(0, stmtEnd + 1) : chunk
    for (const c of stmt.matchAll(/ADD\s+COLUMN\s+`?(\w+)`?/gi)) out.add(`${h[1].toLowerCase()}.${c[1].toLowerCase()}`)
  })
  return out
}

export function analyze({ migrateSrc, schemaV2Sql, expectedTables, expectedColumns, tableAllow = TABLE_ALLOWLIST, columnAllow = COLUMN_ALLOWLIST }) {
  const migrate = unescape(stripJsComments(migrateSrc))
  const migrateDefinitions = parseCreateDefinitions(migrate)
  const schemaDefinitions = parseCreateDefinitions(schemaV2Sql)
  const migrateCreates = migrateDefinitions.tables
  const schemaCreates = schemaDefinitions.tables
  const added = parseAddColumns(migrate)
  const problems = []

  for (const key of migrateDefinitions.duplicates) {
    problems.push(`migrate.mjs 的 CREATE TABLE 重复定义了列 ${key}，执行迁移会失败`)
  }
  for (const key of schemaDefinitions.duplicates) {
    problems.push(`schema-v2.sql 的 CREATE TABLE 重复定义了列 ${key}，新库初始化会失败`)
  }

  const expectedTableSet = new Set(expectedTables.filter((e) => !e.column).map((e) => e.table.toLowerCase()))
  const expectedColumnSet = new Set([
    ...expectedColumns.map((e) => `${e.table}.${e.column}`.toLowerCase()),
    // EXPECTED_TABLES 里也夹着带 column 的条目（collection_items.position）
    ...expectedTables.filter((e) => e.column).map((e) => `${e.table}.${e.column}`.toLowerCase()),
  ])

  // A
  for (const t of expectedTableSet) {
    if (!migrateCreates.has(t) && !schemaCreates.has(t)) {
      problems.push(`schema-check 期望表 ${t}，但 migrate.mjs 和 schema-v2.sql 都不建它 —— 启动会永远告警，跑 migrate 也补不上`)
    }
  }
  // B
  for (const key of expectedColumnSet) {
    const [t, c] = key.split('.')
    if (added.has(key)) continue
    if (migrateCreates.get(t)?.has(c)) continue
    problems.push(`schema-check 期望列 ${key}，但 migrate.mjs 里没有 ADD COLUMN（只写在 schema-v2.sql 的话，已有库永远补不上）`)
  }
  // C：迁移建的表
  for (const t of migrateCreates.keys()) {
    if (expectedTableSet.has(t) || tableAllow[t]) continue
    problems.push(`migrate.mjs 建了表 ${t}，但 schema-check.js 的 EXPECTED_TABLES 没登记（生产库没跑 migrate 时不会有任何提醒）；不该查就写进 check-schema-drift.mjs 的 TABLE_ALLOWLIST 并注明原因`)
  }
  // C：迁移补的列
  for (const key of added) {
    if (expectedColumnSet.has(key) || columnAllow[key]) continue
    problems.push(`migrate.mjs 补了列 ${key}，但 schema-check.js 的 EXPECTED_COLUMNS 没登记；不该查就写进 COLUMN_ALLOWLIST 并注明原因`)
  }
  // 白名单本身也要对得上：迁移里已经没有的条目是死规则
  for (const t of Object.keys(tableAllow)) {
    if (!migrateCreates.has(t)) problems.push(`TABLE_ALLOWLIST 里的 ${t} 已不在 migrate.mjs 中，删掉这条`)
  }
  for (const k of Object.keys(columnAllow)) {
    if (!added.has(k)) problems.push(`COLUMN_ALLOWLIST 里的 ${k} 已不在 migrate.mjs 中，删掉这条`)
  }
  return { problems, migrateCreates, added }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const { EXPECTED_TABLES, EXPECTED_COLUMNS } = await import('../src/schema-check.js')
  const { problems, migrateCreates, added } = analyze({
    migrateSrc: readFileSync(join(serverDir, 'scripts/migrate.mjs'), 'utf8'),
    schemaV2Sql: readFileSync(join(serverDir, 'schema-v2.sql'), 'utf8'),
    expectedTables: EXPECTED_TABLES,
    expectedColumns: EXPECTED_COLUMNS,
  })
  if (problems.length) {
    console.error('✖ 迁移与启动自检对不上：')
    for (const p of problems) console.error(`  · ${p}`)
    process.exit(1)
  }
  console.log(`✔ 迁移与启动自检一致（migrate 建表 ${migrateCreates.size} 张、补列 ${added.size} 个）`)
}
