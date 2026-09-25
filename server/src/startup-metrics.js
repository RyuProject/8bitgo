/**
 * 第一方启动漏斗。
 *
 * 这里只保存一次启动各阶段的时间点，不保存 IP、UA、ROM 地址或错误堆栈。地区由服务端
 * 按请求来源归到国家级；错误原因也只收一段经过截断的分类文本。这样能回答“哪款游戏、
 * 哪个运行时、哪个地区启动慢”，又不会把一套新的访客追踪系统偷偷塞进站点。
 */
import { query } from './db.js'

export const STARTUP_SLOW_MS = 20_000
const RETENTION_DAYS = 90
const EVENTS = new Set([
  'detail_view',
  'start_click',
  'download_complete',
  'iframe_loaded',
  'first_frame',
  'game_playable',
  'first_interaction',
  'slow_start',
  'failed',
  'timeout',
])
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const NAME_RE = /^[A-Za-z0-9_-]{0,32}$/

const text = (value, max) => Array.from(String(value ?? ''), (char) => {
  const code = char.charCodeAt(0)
  return code <= 31 || code === 127 ? ' ' : char
}).join('').replace(/\s+/g, ' ').trim().slice(0, max)
const finiteMs = (value) => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(3_600_000, Math.round(n))) : null
}

/**
 * 路由和离线测试共用的入口校验。事件名走白名单，防止拼错一个字符串后数据库里静默长出
 * 一条永远不会出现在报表里的“新阶段”。
 */
export function normalizeStartupEvent(body = {}) {
  const event = text(body.event, 24)
  const visitId = text(body.visitId, 64)
  const attemptId = text(body.attemptId, 64)
  const runtime = text(body.runtime, 32)
  const platform = text(body.platform, 20)
  if (!EVENTS.has(event)) throw new Error('未知的启动漏斗事件')
  if (!ID_RE.test(visitId)) throw new Error('visitId 格式不正确')
  if (event !== 'detail_view' && !ID_RE.test(attemptId)) throw new Error('attemptId 格式不正确')
  if (!NAME_RE.test(runtime) || !NAME_RE.test(platform)) throw new Error('运行时或平台格式不正确')
  return {
    event,
    visitId,
    // 详情页曝光还没有“某一次启动”，空串让唯一键仍可可靠去重。
    attemptId: event === 'detail_view' ? '' : attemptId,
    runtime,
    platform,
    elapsedMs: finiteMs(body.elapsedMs),
    detail: text(body.detail, 160) || null,
  }
}

export function isSlowStartup(event) {
  return event?.event === 'slow_start' && Number(event.elapsedMs) >= STARTUP_SLOW_MS
}

let nextCleanupAt = 0
function scheduleCleanup() {
  const now = Date.now()
  if (now < nextCleanupAt) return
  nextCleanupAt = now + 6 * 60 * 60_000
  // 漏斗用于发现近期故障，不需要无限长大。清理失败只记日志，不能反过来影响玩家开局。
  void query(`DELETE FROM game_startup_events WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${RETENTION_DAYS} DAY`)
    .catch((error) => console.warn('[startup] 清理过期启动事件失败：', error?.message || error))
}

export async function recordStartupEvent(slug, raw, country = 'XX') {
  const event = normalizeStartupEvent(raw)
  const safeCountry = /^[A-Z]{2}$/.test(country) ? country : 'XX'
  const result = await query(
    `INSERT IGNORE INTO game_startup_events
       (game_id, visit_id, attempt_id, event, runtime, platform, country, elapsed_ms, detail)
     SELECT id, ?, ?, ?, ?, ?, ?, ?, ?
       FROM games
      WHERE slug = ? AND hidden = 0
      LIMIT 1`,
    [
      event.visitId,
      event.attemptId,
      event.event,
      event.runtime,
      event.platform,
      safeCountry,
      event.elapsedMs,
      event.detail,
      slug,
    ],
  )
  const recorded = Number(result?.affectedRows ?? 0) > 0
  /*
   * INSERT IGNORE 的 affectedRows=0 有两种含义：游戏不存在，或同一阶段被浏览器 / 代理重放。
   * 后一种必须算幂等成功，否则客户端会把唯一键正常挡住的重复包误当 404，再不断重试。
   * 只在零行时补一次存在性查询，正常写入不多付一次数据库往返。
   */
  const accepted = recorded || (await query(
    'SELECT 1 FROM games WHERE slug = ? AND hidden = 0 LIMIT 1',
    [slug],
  )).length > 0
  scheduleCleanup()
  return { accepted, recorded, event, country: safeCountry }
}

const cutoffFor = (days) => new Date(Date.now() - days * 24 * 60 * 60_000)
const numeric = (row, key) => Number(row?.[key] ?? 0)

function shapeAggregate(row = {}) {
  const starts = numeric(row, 'starts')
  const playable = numeric(row, 'playable')
  return {
    detailViews: numeric(row, 'detail_views'),
    starts,
    downloads: numeric(row, 'downloads'),
    iframeLoads: numeric(row, 'iframe_loads'),
    firstFrames: numeric(row, 'first_frames'),
    playable,
    interactions: numeric(row, 'interactions'),
    failures: numeric(row, 'failures'),
    timeouts: numeric(row, 'timeouts'),
    slowStarts: numeric(row, 'slow_starts'),
    avgPlayableMs: row.avg_playable_ms == null ? null : Math.round(Number(row.avg_playable_ms)),
    maxPlayableMs: row.max_playable_ms == null ? null : Math.round(Number(row.max_playable_ms)),
    playableRate: starts ? Math.round((playable / starts) * 10_000) / 100 : 0,
  }
}

const AGGREGATES = `
  COUNT(DISTINCT CASE WHEN e.event = 'detail_view' THEN e.visit_id END) AS detail_views,
  COUNT(DISTINCT CASE WHEN e.event = 'start_click' THEN CONCAT(e.visit_id, ':', e.attempt_id) END) AS starts,
  SUM(e.event = 'download_complete') AS downloads,
  SUM(e.event = 'iframe_loaded') AS iframe_loads,
  SUM(e.event = 'first_frame') AS first_frames,
  SUM(e.event = 'game_playable') AS playable,
  SUM(e.event = 'first_interaction') AS interactions,
  SUM(e.event = 'failed') AS failures,
  SUM(e.event = 'timeout') AS timeouts,
  SUM(e.event = 'slow_start') AS slow_starts,
  AVG(CASE WHEN e.event = 'game_playable' THEN e.elapsed_ms END) AS avg_playable_ms,
  MAX(CASE WHEN e.event = 'game_playable' THEN e.elapsed_ms END) AS max_playable_ms`

async function grouped(cutoff, dimension) {
  const definitions = {
    game: {
      select: 'g.slug AS id, COALESCE(NULLIF(g.title_zh, \'\'), g.title) AS label',
      join: 'JOIN games g ON g.id = e.game_id',
      group: 'e.game_id, g.slug, g.title_zh, g.title',
    },
    runtime: { select: "COALESCE(NULLIF(e.runtime, ''), 'unknown') AS id, COALESCE(NULLIF(e.runtime, ''), 'unknown') AS label", join: '', group: 'e.runtime' },
    country: { select: 'e.country AS id, e.country AS label', join: '', group: 'e.country' },
  }
  const def = definitions[dimension]
  if (!def) throw new Error('未知的启动统计维度')
  const rows = await query(
    `SELECT ${def.select}, ${AGGREGATES}
       FROM game_startup_events e
       ${def.join}
      WHERE e.created_at >= ?
      GROUP BY ${def.group}
      ORDER BY starts DESC, slow_starts DESC
      LIMIT 50`,
    [cutoff],
  )
  return rows.map((row) => ({ id: String(row.id), label: String(row.label), ...shapeAggregate(row) }))
}

/** 后台概览只拉最近 1～90 天；长周期原始事件仍受上面的 90 天保留期约束。 */
export async function startupStats(rawDays = 7) {
  const days = Math.max(1, Math.min(90, Math.round(Number(rawDays) || 7)))
  const cutoff = cutoffFor(days)
  const [summaryRows, byGame, byRuntime, byCountry, recentSlow] = await Promise.all([
    query(`SELECT ${AGGREGATES} FROM game_startup_events e WHERE e.created_at >= ?`, [cutoff]),
    grouped(cutoff, 'game'),
    grouped(cutoff, 'runtime'),
    grouped(cutoff, 'country'),
    query(
      `SELECT g.slug, COALESCE(NULLIF(g.title_zh, ''), g.title) AS title,
              e.runtime, e.country, e.elapsed_ms AS elapsedMs, e.created_at AS createdAt
         FROM game_startup_events e
         JOIN games g ON g.id = e.game_id
        WHERE e.event = 'slow_start' AND e.elapsed_ms >= ? AND e.created_at >= ?
        ORDER BY e.created_at DESC
        LIMIT 20`,
      [STARTUP_SLOW_MS, cutoff],
    ),
  ])
  return { days, slowThresholdMs: STARTUP_SLOW_MS, summary: shapeAggregate(summaryRows[0]), byGame, byRuntime, byCountry, recentSlow }
}
