/**
 * 后台 ROM 上传性能样本。只接收低基数分桶值，不保存账号、IP、UA、文件名或对象 key。
 */
import { query as defaultQuery } from './db.js'

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIZE_BANDS = new Set(['lt8m', '8to24m', '24to128m', '128to512m', 'gte512m'])
const MODES = new Set(['single', 'multipart'])
const OUTCOMES = new Set(['success', 'failure', 'cancelled'])
const DEVICES = new Set(['mobile', 'tablet', 'desktop', 'unknown'])
const NETWORKS = new Set(['slow-2g', '2g', '3g', '4g', 'unknown'])
const ERRORS = new Set(['none', 'network', 'storage', 'integrity', 'cancelled', 'configuration', 'other'])
const MAX_DURATION_MS = 28_800_000
const RETENTION_DAYS = 30
let nextCleanupAt = 0

class RomUploadMetricError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RomUploadMetricError'
  }
}

function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

function boundedNumber(value, max, decimals = 0) {
  if (typeof value !== 'number') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  const factor = 10 ** decimals
  return Math.round(Math.min(max, number) * factor) / factor
}

/** 丢弃精确文件大小，只保留用于调优的大小档。 */
export function romUploadSizeBand(bytes) {
  const size = Number(bytes)
  if (!Number.isSafeInteger(size) || size <= 0) return null
  if (size < 8 * 1024 ** 2) return 'lt8m'
  if (size < 24 * 1024 ** 2) return '8to24m'
  if (size < 128 * 1024 ** 2) return '24to128m'
  if (size < 512 * 1024 ** 2) return '128to512m'
  return 'gte512m'
}

/** API 入库前固定字段、范围与低基数分类，绝不把任意客户端文本落进指标表。 */
export function normalizeRomUploadMetric(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : ''
  if (!UPLOAD_ID_RE.test(uploadId)) throw new RomUploadMetricError('上传指标缺少有效的去重 ID')
  if (!SIZE_BANDS.has(body.sizeBand)) throw new RomUploadMetricError('上传指标文件大小档无效')
  if (!MODES.has(body.mode)) throw new RomUploadMetricError('上传指标传输方式无效')
  if (!OUTCOMES.has(body.outcome)) throw new RomUploadMetricError('上传指标结果无效')
  const durationMs = boundedNumber(body.durationMs, MAX_DURATION_MS)
  if (durationMs === null) throw new RomUploadMetricError('上传指标总耗时无效')
  return {
    uploadId,
    sizeBand: body.sizeBand,
    mode: body.mode,
    outcome: body.outcome,
    error: body.outcome === 'success' ? 'none' : enumValue(body.error, ERRORS, 'other'),
    device: enumValue(body.device, DEVICES, 'unknown'),
    network: enumValue(body.network, NETWORKS, 'unknown'),
    durationMs,
    prepareMs: boundedNumber(body.prepareMs, MAX_DURATION_MS),
    firstPartMs: boundedNumber(body.firstPartMs, MAX_DURATION_MS),
    transferMs: boundedNumber(body.transferMs, MAX_DURATION_MS),
    finalizeMs: boundedNumber(body.finalizeMs, MAX_DURATION_MS),
    measuredMbps: boundedNumber(body.measuredMbps, 100_000, 2),
    concurrency: boundedNumber(body.concurrency, 16),
    serverWaitMs: boundedNumber(body.serverWaitMs, 60_000, 1),
    hashWaitMs: boundedNumber(body.hashWaitMs, 60_000, 1),
    resumed: body.resumed === true,
  }
}

function regionFromRequest(req) {
  const country = String(req?.headers?.['cf-ipcountry'] ?? '').toUpperCase()
  if (country === 'CN') return 'CN'
  if (/^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1') return 'OTHER'
  return 'UNKNOWN'
}

function scheduleCleanup() {
  const now = Date.now()
  if (now < nextCleanupAt) return
  nextCleanupAt = now + 24 * 60 * 60_000
  void defaultQuery(
    `DELETE FROM rom_upload_metrics
      WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${RETENTION_DAYS} DAY`,
  ).catch((error) => {
    nextCleanupAt = Date.now() + 5 * 60_000
    console.warn('[rom-upload-metrics] 清理过期样本失败：', error?.message || error)
  })
}

export async function recordRomUploadMetric(body, req, query = defaultQuery) {
  const metric = normalizeRomUploadMetric(body)
  const region = regionFromRequest(req)
  await query(
    `INSERT IGNORE INTO rom_upload_metrics
       (upload_id, size_band, upload_mode, outcome, error_class, device_class, network_type,
        region, duration_ms, prepare_ms, first_part_ms, transfer_ms, finalize_ms,
        measured_mbps, concurrency, server_wait_ms, hash_wait_ms, resumed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      metric.uploadId, metric.sizeBand, metric.mode, metric.outcome, metric.error,
      metric.device, metric.network, region, metric.durationMs, metric.prepareMs,
      metric.firstPartMs, metric.transferMs, metric.finalizeMs, metric.measuredMbps,
      metric.concurrency, metric.serverWaitMs, metric.hashWaitMs, metric.resumed ? 1 : 0,
    ],
  )
  if (query === defaultQuery) scheduleCleanup()
  return { ok: true }
}

const numeric = (row, key) => row?.[key] === null || row?.[key] === undefined ? null : Number(row[key])

function shapeGroup(row) {
  const attempts = Number(row.attempts ?? 0)
  const successful = Number(row.successful ?? 0)
  return {
    sizeBand: String(row.size_band),
    mode: String(row.upload_mode),
    region: String(row.region),
    device: String(row.device_class),
    network: String(row.network_type),
    attempts,
    successful,
    failed: Number(row.failed ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    successRate: attempts ? successful / attempts : 0,
    avgDurationMs: numeric(row, 'avg_duration_ms'),
    avgPrepareMs: numeric(row, 'avg_prepare_ms'),
    avgFirstPartMs: numeric(row, 'avg_first_part_ms'),
    avgTransferMs: numeric(row, 'avg_transfer_ms'),
    avgFinalizeMs: numeric(row, 'avg_finalize_ms'),
    avgMeasuredMbps: numeric(row, 'avg_measured_mbps'),
    avgPeakConcurrency: numeric(row, 'avg_concurrency'),
    avgServerWaitMs: numeric(row, 'avg_server_wait_ms'),
    avgHashWaitMs: numeric(row, 'avg_hash_wait_ms'),
    resumeRate: Number(row.avg_resumed ?? 0),
  }
}

export async function romUploadStats(days = 7, query = defaultQuery) {
  const parsedDays = Number(days)
  const safeDays = Number.isFinite(parsedDays) ? Math.max(1, Math.min(30, Math.round(parsedDays))) : 7
  const rows = await query(
    `SELECT size_band, upload_mode, region, device_class, network_type,
            COUNT(*) AS attempts,
            SUM(outcome = 'success') AS successful,
            SUM(outcome = 'failure') AS failed,
            SUM(outcome = 'cancelled') AS cancelled,
            AVG(duration_ms) AS avg_duration_ms,
            AVG(prepare_ms) AS avg_prepare_ms,
            AVG(first_part_ms) AS avg_first_part_ms,
            AVG(transfer_ms) AS avg_transfer_ms,
            AVG(finalize_ms) AS avg_finalize_ms,
            AVG(measured_mbps) AS avg_measured_mbps,
            AVG(concurrency) AS avg_concurrency,
            AVG(server_wait_ms) AS avg_server_wait_ms,
            AVG(hash_wait_ms) AS avg_hash_wait_ms,
            AVG(resumed) AS avg_resumed
       FROM rom_upload_metrics
      WHERE created_at >= UTC_TIMESTAMP() - INTERVAL ${safeDays} DAY
      GROUP BY size_band, upload_mode, region, device_class, network_type
      ORDER BY attempts DESC, size_band, upload_mode
      LIMIT 100`,
  )
  return { days: safeDays, groups: rows.map(shapeGroup) }
}
