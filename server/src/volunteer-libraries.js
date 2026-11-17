/**
 * 志愿者的个人游戏库 / 文章库。
 *
 * 这里故意不复用 games / posts 主表：只加 owner_id 看似省事，但公开列表、随机游戏、
 * 搜索、直播、翻译、收藏等几十条查询只要漏一个 owner_id IS NULL，志愿者的草稿就会进入公网。
 * 独立表是数据层的硬隔离：主站代码根本不查它，删错也不可能级联到主库。
 *
 * payload 存的是后台 API 对象，而不是主表的数十列 + 三张关联表。个人库当前是
 * 准备 / 沙盒区，没有前台联表查询、评分、收藏等需求；这种形状让每个账号天然用
 * (owner_id, slug) 做唯一键，同一个 slug 可以在主库和不同志愿者库同时存在。
 */
import { query, queryOne } from './db.js'
import {
  gameApiToRow,
  gameRowToApi,
  postApiToRow,
  postRowToApi,
  romRelationRows,
} from './mappers.js'

const MAX_PAGE_SIZE = 100
const GAME_PAYLOAD_MAX = 2 * 1024 * 1024
const POST_PAYLOAD_MAX = 16 * 1024 * 1024

function parsedPayload(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value
  try {
    const parsed = JSON.parse(String(value ?? ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function payloadJson(value, maxBytes, label) {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    const error = new Error(`${label}内容过大，请精简后再保存`)
    error.status = 400
    error.expose = true
    throw error
  }
  return json
}

const cleanList = (value) => [...new Set((Array.isArray(value) ? value : []).map((x) => String(x).trim()).filter(Boolean))]

/**
 * 复用主库 mapper 做形状与安全校验，再还原成 API Game。
 * plays / rating 是主站真实行为的聚合值，个人库不允许伪造，固定为 0。
 */
export function normalizeVolunteerGame(slug, input, createdAt = new Date()) {
  const source = { ...(input && typeof input === 'object' ? input : {}), slug: String(slug) }
  // 个人库把内容保存在 JSON payload，可容纳上限与主库 VARCHAR / TEXT 不同。
  const row = gameApiToRow(source, { enforceColumnLimits: false })
  const relationRows = romRelationRows(source)
  const rel = {
    genres: cleanList(source.genres),
    tags: cleanList(source.tags),
    roms: Object.fromEntries(relationRows.map((r) => [r.lang, r.key])),
    romBackups: Object.fromEntries(relationRows.filter((r) => r.backupKey).map((r) => [r.lang, r.backupKey])),
    dosExecutables: Object.fromEntries(relationRows.filter((r) => r.dosExecutable).map((r) => [r.lang, r.dosExecutable])),
    dosStartupCommands: Object.fromEntries(
      relationRows.filter((r) => r.dosStartupCommands).map((r) => [r.lang, r.dosStartupCommands]),
    ),
    dosSockdrives: Object.fromEntries(
      relationRows.filter((r) => r.dosSockdrive).map((r) => [r.lang, r.dosSockdrive]),
    ),
  }
  const now = new Date()
  return gameRowToApi(
    {
      ...row,
      id: 0,
      plays: 0,
      rating_sum: 0,
      rating_weight: 0,
      rating_count: 0,
      created_at: createdAt,
      updated_at: now,
    },
    rel,
  )
}

export function normalizeVolunteerPost(slug, input, createdAt = new Date()) {
  const row = postApiToRow({ ...(input && typeof input === 'object' ? input : {}), slug: String(slug) })
  return postRowToApi(
    {
      ...row,
      id: 0,
      title_i18n: null,
      excerpt_i18n: null,
      content_i18n: null,
      created_at: createdAt,
      updated_at: new Date(),
    },
    { tags: cleanList(input?.tags) },
  )
}

function pageNumber(value, fallback) {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function gameSearchText(game) {
  return [game.slug, game.title, game.titleZh, game.developer, ...(game.tags ?? [])]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase()
}

/** 纯函数：用于固定筛选 / 排序语义的轻量回归检查。 */
export function pageVolunteerGames(items, filters = {}) {
  const needle = String(filters.q ?? '').trim().toLocaleLowerCase()
  let list = items.filter((game) => {
    if (filters.platform && filters.platform !== 'all' && game.platform !== filters.platform) return false
    if (filters.status === 'visible' && game.hidden) return false
    if (filters.status === 'hidden' && !game.hidden) return false
    if (filters.home === true && !game.homeRank) return false
    if (filters.home === false && game.homeRank) return false
    return !needle || gameSearchText(game).includes(needle)
  })

  const stamp = (g) => Date.parse(g.updatedAt || g.addedAt || '') || 0
  const name = (g) => String(g.titleZh || g.title || g.slug)
  const sorter = filters.sort === 'name'
    ? (a, b) => name(a).localeCompare(name(b), 'zh-CN')
    : filters.sort === 'popular'
      ? (a, b) => Number(b.plays || 0) - Number(a.plays || 0) || stamp(b) - stamp(a)
      : filters.sort === 'rating'
        ? (a, b) => Number(b.rating || 0) - Number(a.rating || 0) || stamp(b) - stamp(a)
        : filters.sort === 'home'
          ? (a, b) => Number(a.homeRank || 65536) - Number(b.homeRank || 65536) || stamp(b) - stamp(a)
          : (a, b) => stamp(b) - stamp(a)
  list = [...list].sort(sorter)

  const pageSize = Math.min(MAX_PAGE_SIZE, pageNumber(filters.pageSize, 24))
  const total = list.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pageNumber(filters.page, 1), totalPages)
  return { items: list.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, totalPages }
}

function rowPayload(row) {
  return row ? parsedPayload(row.payload) : null
}

/**
 * 志愿者列表必须在数据库分页：payload 可达 2MB，整库读进 Node 再筛选会让一个账号
 * 的历史内容放大成每次列表请求的内存、CPU 和网络开销。owner_id 永远由登录态传入，
 * 所有用户筛选值仍是绑定参数，排序只接受固定映射。
 */
export function buildVolunteerGameListQueries(ownerId, filters = {}) {
  const where = ['owner_id = ?']
  const params = [ownerId]
  if (filters.platform && filters.platform !== 'all') {
    where.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.platform')) = ?")
    params.push(String(filters.platform))
  }
  if (filters.status === 'visible') {
    where.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.hidden')), 'false') <> 'true'")
  } else if (filters.status === 'hidden') {
    where.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.hidden')) = 'true'")
  }
  if (filters.home === true) {
    where.push("CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.homeRank')), '0') AS DECIMAL(20, 4)) <> 0")
  } else if (filters.home === false) {
    where.push("CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.homeRank')), '0') AS DECIMAL(20, 4)) = 0")
  }
  const needle = String(filters.q ?? '').trim().slice(0, 160)
  if (needle) {
    where.push(`LOCATE(LOWER(?), LOWER(CONCAT_WS(CHAR(10), slug,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.title')),
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.titleZh')),
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.developer')),
      CAST(JSON_EXTRACT(payload, '$.tags') AS CHAR)))) > 0`)
    params.push(needle)
  }

  const stamp = 'updated_at DESC, slug ASC'
  const orderBy = filters.sort === 'name'
    ? `COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.titleZh')), ''), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.title')), ''), slug) COLLATE utf8mb4_unicode_ci ASC, ${stamp}`
    : filters.sort === 'popular'
      ? `CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.plays')), '0') AS DECIMAL(20, 4)) DESC, ${stamp}`
      : filters.sort === 'rating'
        ? `CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.rating')), '0') AS DECIMAL(20, 4)) DESC, ${stamp}`
        : filters.sort === 'home'
          ? `CASE WHEN CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.homeRank')), '0') AS DECIMAL(20, 4)) = 0 THEN 65536 ELSE CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.homeRank')) AS DECIMAL(20, 4)) END ASC, ${stamp}`
          : stamp
  const whereSql = where.join(' AND ')
  return {
    countSql: `SELECT COUNT(*) AS total FROM volunteer_games WHERE ${whereSql}`,
    countParams: params,
    pageSql: `SELECT ${filters.summary
      ? "JSON_REMOVE(payload, '$.description', '$.descriptionEn', '$.descriptionI18n', '$.descriptionLocalized', '$.romAssets', '$.romBundleEntries', '$.dosExecutables', '$.dosStartupCommands', '$.dosSockdrives', '$.dosExtras', '$.dosboxConfig', '$.arcadeRomData')"
      : 'payload'} AS payload FROM volunteer_games WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    pageParams: params,
  }
}

export async function listVolunteerGames(ownerId, filters = {}) {
  const { countSql, countParams, pageSql, pageParams } = buildVolunteerGameListQueries(ownerId, filters)
  const countRow = await queryOne(countSql, countParams)
  const total = Math.max(0, Number(countRow?.total) || 0)
  const pageSize = Math.min(MAX_PAGE_SIZE, pageNumber(filters.pageSize, 24))
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pageNumber(filters.page, 1), totalPages)
  const rows = await query(pageSql, [...pageParams, pageSize, (page - 1) * pageSize])
  return { items: rows.map(rowPayload).filter(Boolean), total, page, pageSize, totalPages }
}

export async function getVolunteerGame(ownerId, slug) {
  return rowPayload(await queryOne(
    'SELECT payload FROM volunteer_games WHERE owner_id = ? AND slug = ? LIMIT 1',
    [ownerId, slug],
  ))
}

export async function saveVolunteerGame(ownerId, slug, game) {
  const normalized = normalizeVolunteerGame(slug, game)
  const payload = payloadJson(normalized, GAME_PAYLOAD_MAX, '游戏')
  await query(
    `INSERT INTO volunteer_games (owner_id, slug, payload)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
    [ownerId, slug, payload],
  )
  return normalized
}

/**
 * 志愿者新增也必须是 INSERT-only。同一个账号在两个标签页同时新增同名游戏时，
 * 不能因为个人库用 JSON 存储就退回成“后保存者覆盖前保存者”。
 */
export async function createVolunteerGame(ownerId, slug, game) {
  const normalized = normalizeVolunteerGame(slug, game)
  const payload = payloadJson(normalized, GAME_PAYLOAD_MAX, '游戏')
  await query(
    'INSERT INTO volunteer_games (owner_id, slug, payload) VALUES (?, ?, ?)',
    [ownerId, slug, payload],
  )
  return normalized
}

export async function patchVolunteerGame(ownerId, slug, patch) {
  const current = await getVolunteerGame(ownerId, slug)
  if (!current) return null
  return saveVolunteerGame(ownerId, slug, { ...current, ...(patch && typeof patch === 'object' ? patch : {}) })
}

export async function deleteVolunteerGame(ownerId, slug) {
  const result = await query('DELETE FROM volunteer_games WHERE owner_id = ? AND slug = ?', [ownerId, slug])
  return result.affectedRows > 0
}

export async function listVolunteerPosts(ownerId, { summary = false } = {}) {
  const rows = await query(
    summary
      // 列表不需要正文和翻译缓存；JSON_REMOVE 只裁响应副本，不改库里的 payload。
      ? `SELECT JSON_REMOVE(payload, '$.content', '$.titleI18n', '$.excerptI18n', '$.contentI18n') AS payload
           FROM volunteer_posts WHERE owner_id = ? ORDER BY updated_at DESC, slug`
      : 'SELECT payload FROM volunteer_posts WHERE owner_id = ? ORDER BY updated_at DESC, slug',
    [ownerId],
  )
  return rows.map(rowPayload).filter(Boolean)
}

export async function getVolunteerPost(ownerId, slug) {
  return rowPayload(await queryOne(
    'SELECT payload FROM volunteer_posts WHERE owner_id = ? AND slug = ? LIMIT 1',
    [ownerId, slug],
  ))
}

export async function saveVolunteerPost(ownerId, slug, post) {
  const normalized = normalizeVolunteerPost(slug, post)
  const payload = payloadJson(normalized, POST_PAYLOAD_MAX, '文章')
  await query(
    `INSERT INTO volunteer_posts (owner_id, slug, payload)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
    [ownerId, slug, payload],
  )
  return normalized
}

/** INSERT-only，防止两个标签页同时新建同名文章时静默覆盖正文。 */
export async function createVolunteerPost(ownerId, slug, post) {
  const normalized = normalizeVolunteerPost(slug, post)
  const payload = payloadJson(normalized, POST_PAYLOAD_MAX, '文章')
  await query(
    'INSERT INTO volunteer_posts (owner_id, slug, payload) VALUES (?, ?, ?)',
    [ownerId, slug, payload],
  )
  return normalized
}

/** 只改发布标记，不把浏览器里可能过期的整篇正文回写覆盖。 */
export async function setVolunteerPostPublished(ownerId, slug, published) {
  const result = await query(
    `UPDATE volunteer_posts
        SET payload = JSON_SET(payload, '$.published', CAST(? AS JSON)), updated_at = CURRENT_TIMESTAMP
      WHERE owner_id = ? AND slug = ?`,
    [JSON.stringify(Boolean(published)), ownerId, slug],
  )
  if (!result.affectedRows) return null
  return getVolunteerPost(ownerId, slug)
}

export async function deleteVolunteerPost(ownerId, slug) {
  const result = await query('DELETE FROM volunteer_posts WHERE owner_id = ? AND slug = ?', [ownerId, slug])
  return result.affectedRows > 0
}
