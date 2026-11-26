/**
 * 第一方启动漏斗。
 *
 * 这里只保存一次启动各阶段的时间点，不保存 IP、UA、ROM 地址或错误堆栈。地区由服务端
 * 按请求来源归到国家级；错误原因也只收一段经过截断的分类文本。这样能回答“哪款游戏、
 * 哪个运行时、哪个地区启动慢”，又不会把一套新的访客追踪系统偷偷塞进站点。
 */
import { query } from './db.js'

export const STARTUP_SLOW_MS = 60_000
const RETENTION_DAYS = 90
const EVENTS = new Set([
  'detail_view',
  'start_click',
  'download_complete',
  'rom_load_start',
  'rom_load_complete',
  'core_warm_start',
  'core_warm_complete',
  'core_cache_hit',
  'fallback_started',
  'fallback_succeeded',
  'fallback_failed',
  'runtime_ready',
  'iframe_loaded',
  'first_frame',
  'game_playable',
  'first_interaction',
  'slow_start',
  'readiness_unobservable',
  'failed',
  'timeout',
  // 详情页崩溃后自动刷新、刷新后好了（src/services/pageRecovery.ts）：单独一种事件，不算进 failures
  'recovered',
])
/** 页面阶段可合批，异常现场事件仍走单独接口以保留原有限流与诊断处理。 */
const BATCHABLE_EVENTS = new Set([
  'download_complete', 'rom_load_start', 'rom_load_complete', 'core_warm_start', 'core_warm_complete',
  'core_cache_hit', 'runtime_ready', 'first_frame', 'game_playable',
])
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const NAME_RE = /^[A-Za-z0-9_-]{0,32}$/
const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g
const IPV6_RE = /(?<![\da-f:])(?:[\da-f]{0,4}:){2,7}[\da-f]{0,4}(?![\da-f:])/gi

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
 * 错误摘要要能帮助定位启动阶段，但不能把网络诊断里带出的 ROM 地址、凭据或玩家 IP 存进库。
 * 老记录在返回后台时也经过同一层清洗，避免历史数据绕过新规则。
 */
export function sanitizeStartupDetail(value) {
  const normalized = Array.from(String(value ?? ''), (char) => {
    const code = char.codePointAt(0) ?? 0
    return code <= 31 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : char
  }).join('')
  const detail = normalized
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\b(bearer)\s+[^\s,;]+/gi, '$1 [已隐藏]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token)\b(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[已隐藏]')
    .replace(/\beyJ[\da-z_-]{8,}\.[\da-z_-]{8,}\.[\da-z_-]{8,}\b/gi, '[令牌]')
    .replace(IPV4_RE, '[IP]')
    .replace(IPV6_RE, '[IP]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return detail || null
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
    detail: sanitizeStartupDetail(body.detail),
  }
}

/** 一次请求最多写 16 个同一启动 attempt 的普通阶段，拒绝跨局混批和诊断事件。 */
export function normalizeStartupEventBatch(rawEvents) {
  if (!Array.isArray(rawEvents) || rawEvents.length < 2 || rawEvents.length > 16) {
    throw new Error('启动事件批次必须包含 2..16 个事件')
  }
  const events = rawEvents.map(normalizeStartupEvent)
  const first = events[0]
  const seen = new Set()
  for (const event of events) {
    if (!BATCHABLE_EVENTS.has(event.event)) throw new Error('此启动事件不能批量上报')
    if (event.visitId !== first.visitId || event.attemptId !== first.attemptId) {
      throw new Error('批量启动事件必须属于同一次启动')
    }
    if (seen.has(event.event)) throw new Error('批量启动事件不能重复')
    seen.add(event.event)
  }
  return events
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

/** 批量阶段使用一条 INSERT 完成整次请求，避免观测数据按阶段逐条占用连接和 SQL 往返。 */
export async function recordStartupEvents(slug, rawEvents, country = 'XX') {
  const events = normalizeStartupEventBatch(rawEvents)
  const safeCountry = /^[A-Z]{2}$/.test(country) ? country : 'XX'
  const rows = events.map(() => `SELECT ? AS visit_id, ? AS attempt_id, ? AS event,
      ? AS runtime, ? AS platform, ? AS country, ? AS elapsed_ms, ? AS detail`).join('\n    UNION ALL\n    ')
  const values = events.flatMap((event) => [
    event.visitId,
    event.attemptId,
    event.event,
    event.runtime,
    event.platform,
    safeCountry,
    event.elapsedMs,
    event.detail,
  ])
  const result = await query(
    `INSERT IGNORE INTO game_startup_events
       (game_id, visit_id, attempt_id, event, runtime, platform, country, elapsed_ms, detail)
     SELECT g.id, e.visit_id, e.attempt_id, e.event, e.runtime, e.platform, e.country, e.elapsed_ms, e.detail
       FROM games g
       CROSS JOIN (${rows}) AS e
      WHERE g.slug = ? AND g.hidden = 0`,
    [...values, slug],
  )
  const recordedCount = Number(result?.affectedRows ?? 0)
  const accepted = recordedCount > 0 || (await query(
    'SELECT 1 FROM games WHERE slug = ? AND hidden = 0 LIMIT 1',
    [slug],
  )).length > 0
  scheduleCleanup()
  return { accepted, recordedCount, events, country: safeCountry }
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
    readinessUnobservable: numeric(row, 'readiness_unobservable'),
    fallbackAttempts: numeric(row, 'fallback_attempts'),
    fallbackSuccesses: numeric(row, 'fallback_successes'),
    fallbackFailures: numeric(row, 'fallback_failures'),
    avgPlayableMs: row.avg_playable_ms == null ? null : Math.round(Number(row.avg_playable_ms)),
    maxPlayableMs: row.max_playable_ms == null ? null : Math.round(Number(row.max_playable_ms)),
    playableRate: starts ? Math.round((playable / starts) * 10_000) / 100 : 0,
  }
}

/** 启动阶段均值；样本数和均值一起返回，避免小样本被误读为稳定表现。 */
export function shapePhaseTiming(row = {}) {
  const average = (key) => row[key] == null ? null : Math.round(Number(row[key]))
  return {
    avgResourceMs: average('avg_resource_ms'),
    resourceSamples: numeric(row, 'resource_samples'),
    avgResourceToFirstFrameMs: average('avg_resource_to_first_frame_ms'),
    resourceToFirstFrameSamples: numeric(row, 'resource_to_first_frame_samples'),
    avgFirstFrameToPlayableMs: average('avg_first_frame_to_playable_ms'),
    firstFrameToPlayableSamples: numeric(row, 'first_frame_to_playable_samples'),
    avgRomLoadMs: average('avg_rom_load_ms'),
    romLoadSamples: numeric(row, 'rom_load_samples'),
    avgCoreWarmMs: average('avg_core_warm_ms'),
    coreWarmSamples: numeric(row, 'core_warm_samples'),
    coreCacheHits: numeric(row, 'core_cache_hits'),
    avgResourceToRuntimeReadyMs: average('avg_resource_to_runtime_ready_ms'),
    resourceToRuntimeReadySamples: numeric(row, 'resource_to_runtime_ready_samples'),
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
  SUM(e.event = 'readiness_unobservable') AS readiness_unobservable,
  SUM(e.event = 'fallback_started') AS fallback_attempts,
  SUM(e.event = 'fallback_succeeded') AS fallback_successes,
  SUM(e.event = 'fallback_failed') AS fallback_failures,
  AVG(CASE WHEN e.event = 'game_playable' THEN e.elapsed_ms END) AS avg_playable_ms,
  MAX(CASE WHEN e.event = 'game_playable' THEN e.elapsed_ms END) AS max_playable_ms`

/**
 * 每次启动先按 visit/attempt 配对，再算事件间隔。不能直接平均所有 event.elapsed_ms：
 * 那会把所有阶段都当成“从点击开始”的累计时间。一个查询同时回全局、游戏、运行时、地区，
 * 避免为了新增阶段统计再开多条全表扫描。
 */
const PHASE_TIMING_QUERY = `
  WITH attempt_events AS (
    SELECT e.game_id, e.visit_id, e.attempt_id,
           MAX(e.country) AS country,
           MIN(CASE WHEN e.event = 'start_click' THEN e.elapsed_ms END) AS started_ms,
           MIN(CASE WHEN e.event = 'download_complete' THEN e.elapsed_ms END) AS resource_ms,
           MIN(CASE WHEN e.event = 'first_frame' THEN e.elapsed_ms END) AS first_frame_ms,
           MIN(CASE WHEN e.event = 'game_playable' THEN e.elapsed_ms END) AS playable_ms,
           MIN(CASE WHEN e.event = 'rom_load_start' THEN e.elapsed_ms END) AS rom_start_ms,
           MIN(CASE WHEN e.event = 'rom_load_complete' THEN e.elapsed_ms END) AS rom_complete_ms,
           MIN(CASE WHEN e.event = 'core_warm_start' THEN e.elapsed_ms END) AS core_warm_start_ms,
           MIN(CASE WHEN e.event = 'core_warm_complete' THEN e.elapsed_ms END) AS core_warm_complete_ms,
           MIN(CASE WHEN e.event = 'runtime_ready' THEN e.elapsed_ms END) AS runtime_ready_ms,
           MAX(CASE WHEN e.event = 'core_cache_hit' THEN 1 ELSE 0 END) AS core_cache_hit,
           MAX(CASE WHEN e.event = 'core_cache_hit' THEN e.runtime END) AS core_cache_runtime,
           MAX(CASE WHEN e.event = 'start_click' THEN e.runtime END) AS start_runtime,
           MAX(CASE WHEN e.event = 'download_complete' THEN e.runtime END) AS resource_runtime,
           MAX(CASE WHEN e.event = 'first_frame' THEN e.runtime END) AS first_frame_runtime,
           MAX(CASE WHEN e.event = 'game_playable' THEN e.runtime END) AS playable_runtime,
           MAX(CASE WHEN e.event = 'rom_load_start' THEN e.runtime END) AS rom_start_runtime,
           MAX(CASE WHEN e.event = 'rom_load_complete' THEN e.runtime END) AS rom_complete_runtime,
           MAX(CASE WHEN e.event = 'core_warm_start' THEN e.runtime END) AS core_warm_start_runtime,
           MAX(CASE WHEN e.event = 'core_warm_complete' THEN e.runtime END) AS core_warm_complete_runtime,
           MAX(CASE WHEN e.event = 'runtime_ready' THEN e.runtime END) AS runtime_ready_runtime
      FROM game_startup_events e
     WHERE e.created_at >= ? AND e.attempt_id <> ''
       AND e.event IN ('start_click', 'download_complete', 'first_frame', 'game_playable',
                       'rom_load_start', 'rom_load_complete', 'core_warm_start',
                       'core_warm_complete', 'core_cache_hit', 'runtime_ready')
     GROUP BY e.game_id, e.visit_id, e.attempt_id
  ), phase_samples AS (
    SELECT game_id, country, resource_runtime AS runtime, 'resource' AS stage,
           resource_ms - started_ms AS duration_ms
      FROM attempt_events
     WHERE started_ms IS NOT NULL AND resource_ms >= started_ms AND start_runtime = resource_runtime
    UNION ALL
    SELECT game_id, country, first_frame_runtime AS runtime, 'resource_to_first_frame' AS stage,
           first_frame_ms - resource_ms AS duration_ms
      FROM attempt_events
     WHERE started_ms IS NOT NULL AND resource_ms IS NOT NULL AND first_frame_ms >= resource_ms
       AND resource_runtime = first_frame_runtime
    UNION ALL
    SELECT game_id, country, playable_runtime AS runtime, 'first_frame_to_playable' AS stage,
           playable_ms - first_frame_ms AS duration_ms
      FROM attempt_events
     WHERE started_ms IS NOT NULL AND first_frame_ms IS NOT NULL AND playable_ms >= first_frame_ms
       AND first_frame_runtime = playable_runtime
    UNION ALL
    SELECT game_id, country, rom_complete_runtime AS runtime, 'rom_load' AS stage,
           rom_complete_ms - rom_start_ms AS duration_ms
     FROM attempt_events
     WHERE started_ms IS NOT NULL AND rom_start_ms IS NOT NULL AND rom_complete_ms >= rom_start_ms
       AND rom_start_runtime = rom_complete_runtime
    UNION ALL
    SELECT game_id, country, core_warm_complete_runtime AS runtime, 'core_warm' AS stage,
           core_warm_complete_ms - core_warm_start_ms AS duration_ms
     FROM attempt_events
     WHERE started_ms IS NOT NULL AND core_warm_start_ms IS NOT NULL AND core_warm_complete_ms >= core_warm_start_ms
       AND core_warm_start_runtime = core_warm_complete_runtime
    UNION ALL
    SELECT game_id, country, runtime_ready_runtime AS runtime, 'resource_to_runtime_ready' AS stage,
           runtime_ready_ms - resource_ms AS duration_ms
     FROM attempt_events
     WHERE started_ms IS NOT NULL AND resource_ms IS NOT NULL AND runtime_ready_ms >= resource_ms
       AND resource_runtime = runtime_ready_runtime
    UNION ALL
    SELECT game_id, country, core_cache_runtime AS runtime, 'core_cache_hit' AS stage, NULL AS duration_ms
     FROM attempt_events
     WHERE started_ms IS NOT NULL AND core_cache_hit = 1
  )
  SELECT 'summary' AS dimension, '' AS id, '' AS label,
         AVG(CASE WHEN p.stage = 'resource' THEN p.duration_ms END) AS avg_resource_ms,
         SUM(p.stage = 'resource') AS resource_samples,
         AVG(CASE WHEN p.stage = 'resource_to_first_frame' THEN p.duration_ms END) AS avg_resource_to_first_frame_ms,
         SUM(p.stage = 'resource_to_first_frame') AS resource_to_first_frame_samples,
         AVG(CASE WHEN p.stage = 'first_frame_to_playable' THEN p.duration_ms END) AS avg_first_frame_to_playable_ms,
         SUM(p.stage = 'first_frame_to_playable') AS first_frame_to_playable_samples,
         AVG(CASE WHEN p.stage = 'rom_load' THEN p.duration_ms END) AS avg_rom_load_ms,
         SUM(p.stage = 'rom_load') AS rom_load_samples,
         AVG(CASE WHEN p.stage = 'core_warm' THEN p.duration_ms END) AS avg_core_warm_ms,
         SUM(p.stage = 'core_warm') AS core_warm_samples,
         SUM(p.stage = 'core_cache_hit') AS core_cache_hits,
         AVG(CASE WHEN p.stage = 'resource_to_runtime_ready' THEN p.duration_ms END) AS avg_resource_to_runtime_ready_ms,
         SUM(p.stage = 'resource_to_runtime_ready') AS resource_to_runtime_ready_samples
    FROM phase_samples p
  UNION ALL
  SELECT 'game', g.slug, COALESCE(NULLIF(g.title_zh, ''), g.title),
         AVG(CASE WHEN p.stage = 'resource' THEN p.duration_ms END), SUM(p.stage = 'resource'),
         AVG(CASE WHEN p.stage = 'resource_to_first_frame' THEN p.duration_ms END), SUM(p.stage = 'resource_to_first_frame'),
         AVG(CASE WHEN p.stage = 'first_frame_to_playable' THEN p.duration_ms END), SUM(p.stage = 'first_frame_to_playable'),
         AVG(CASE WHEN p.stage = 'rom_load' THEN p.duration_ms END), SUM(p.stage = 'rom_load'),
         AVG(CASE WHEN p.stage = 'core_warm' THEN p.duration_ms END), SUM(p.stage = 'core_warm'),
         SUM(p.stage = 'core_cache_hit'),
         AVG(CASE WHEN p.stage = 'resource_to_runtime_ready' THEN p.duration_ms END), SUM(p.stage = 'resource_to_runtime_ready')
    FROM phase_samples p JOIN games g ON g.id = p.game_id
   GROUP BY p.game_id, g.slug, g.title_zh, g.title
  UNION ALL
  SELECT 'runtime', COALESCE(NULLIF(p.runtime, ''), 'unknown'), COALESCE(NULLIF(p.runtime, ''), 'unknown'),
         AVG(CASE WHEN p.stage = 'resource' THEN p.duration_ms END), SUM(p.stage = 'resource'),
         AVG(CASE WHEN p.stage = 'resource_to_first_frame' THEN p.duration_ms END), SUM(p.stage = 'resource_to_first_frame'),
         AVG(CASE WHEN p.stage = 'first_frame_to_playable' THEN p.duration_ms END), SUM(p.stage = 'first_frame_to_playable'),
         AVG(CASE WHEN p.stage = 'rom_load' THEN p.duration_ms END), SUM(p.stage = 'rom_load'),
         AVG(CASE WHEN p.stage = 'core_warm' THEN p.duration_ms END), SUM(p.stage = 'core_warm'),
         SUM(p.stage = 'core_cache_hit'),
         AVG(CASE WHEN p.stage = 'resource_to_runtime_ready' THEN p.duration_ms END), SUM(p.stage = 'resource_to_runtime_ready')
    FROM phase_samples p
   GROUP BY p.runtime
  UNION ALL
  SELECT 'country', p.country, p.country,
         AVG(CASE WHEN p.stage = 'resource' THEN p.duration_ms END), SUM(p.stage = 'resource'),
         AVG(CASE WHEN p.stage = 'resource_to_first_frame' THEN p.duration_ms END), SUM(p.stage = 'resource_to_first_frame'),
         AVG(CASE WHEN p.stage = 'first_frame_to_playable' THEN p.duration_ms END), SUM(p.stage = 'first_frame_to_playable'),
         AVG(CASE WHEN p.stage = 'rom_load' THEN p.duration_ms END), SUM(p.stage = 'rom_load'),
         AVG(CASE WHEN p.stage = 'core_warm' THEN p.duration_ms END), SUM(p.stage = 'core_warm'),
         SUM(p.stage = 'core_cache_hit'),
         AVG(CASE WHEN p.stage = 'resource_to_runtime_ready' THEN p.duration_ms END), SUM(p.stage = 'resource_to_runtime_ready')
    FROM phase_samples p
   GROUP BY p.country`

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
export async function startupStats(rawDays = 7, rawQuery = '') {
  const days = Math.max(1, Math.min(90, Math.round(Number(rawDays) || 7)))
  const cutoff = cutoffFor(days)
  const search = text(rawQuery, 80)
  const [summaryRows, byGame, byRuntime, byCountry, phaseRows, recentSlow, recentFailures] = await Promise.all([
    query(`SELECT ${AGGREGATES} FROM game_startup_events e WHERE e.created_at >= ?`, [cutoff]),
    grouped(cutoff, 'game'),
    grouped(cutoff, 'runtime'),
    grouped(cutoff, 'country'),
    query(PHASE_TIMING_QUERY, [cutoff]),
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
    query(
      `SELECT e.id, g.slug, COALESCE(NULLIF(g.title_zh, ''), g.title) AS title,
              e.platform, e.runtime, e.country, e.event, e.elapsed_ms AS elapsedMs,
              e.detail, e.created_at AS createdAt
         FROM game_startup_events e
         JOIN games g ON g.id = e.game_id
        WHERE e.event IN ('failed', 'timeout') AND e.created_at >= ?
          AND (? = '' OR LOWER(CONCAT_WS(' ', g.slug, g.title, g.title_zh)) LIKE LOWER(?))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 50`,
      [cutoff, search, `%${search}%`],
    ),
  ])
  const phaseByDimension = { game: new Map(), runtime: new Map(), country: new Map() }
  let summaryPhase = shapePhaseTiming()
  for (const row of phaseRows) {
    const phase = shapePhaseTiming(row)
    if (row.dimension === 'summary') summaryPhase = phase
    else phaseByDimension[row.dimension]?.set(String(row.id), phase)
  }
  const withPhaseTiming = (rows, dimension) => rows.map((row) => ({
    ...row,
    ...(phaseByDimension[dimension].get(row.id) ?? shapePhaseTiming()),
  }))
  return {
    days,
    slowThresholdMs: STARTUP_SLOW_MS,
    summary: { ...shapeAggregate(summaryRows[0]), ...summaryPhase },
    byGame: withPhaseTiming(byGame, 'game'),
    byRuntime: withPhaseTiming(byRuntime, 'runtime'),
    byCountry: withPhaseTiming(byCountry, 'country'),
    recentSlow,
    recentFailures: recentFailures.map((row) => ({
      ...row,
      id: String(row.id),
      detail: sanitizeStartupDetail(row.detail),
    })),
  }
}
