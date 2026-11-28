import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  normalizeRomUploadMetric,
  recordRomUploadMetric,
  romUploadSizeBand,
  romUploadStats,
} from '../src/rom-upload-metrics.js'

const mib = 1024 ** 2
assert.equal(romUploadSizeBand(1), 'lt8m')
assert.equal(romUploadSizeBand(8 * mib), '8to24m')
assert.equal(romUploadSizeBand(24 * mib), '24to128m')
assert.equal(romUploadSizeBand(128 * mib), '128to512m')
assert.equal(romUploadSizeBand(512 * mib), 'gte512m')
assert.equal(romUploadSizeBand(Number.MAX_SAFE_INTEGER + 1), null)

const uploadId = '12345678-1234-4234-9234-123456789abc'
const input = {
  uploadId,
  sizeBand: '128to512m',
  mode: 'multipart',
  outcome: 'success',
  durationMs: 60_000,
  prepareMs: 2_000,
  firstPartMs: 11_000,
  transferMs: 54_000,
  finalizeMs: 4_000,
  measuredMbps: 38.447,
  concurrency: 4,
  serverWaitMs: 42.5,
  hashWaitMs: 1.25,
  parts: 32,
  resumedParts: 3,
  resumed: true,
  device: 'desktop',
  network: '4g',
  fileName: 'private-rom-name.zip',
  key: 'roms/arcade/private-game.en.zip',
  exactSizeBytes: 271_828_182,
  accountId: 991,
  ip: '192.0.2.5',
}
const normalized = normalizeRomUploadMetric(input)
assert.equal(normalized.error, 'none')
assert.equal(normalized.measuredMbps, 38.45)
assert.equal(normalized.serverWaitMs, 42.5)
for (const privateField of ['fileName', 'key', 'exactSizeBytes', 'accountId', 'ip']) {
  assert.equal(Object.hasOwn(normalized, privateField), false, `${privateField} must not be persisted`)
}
assert.equal(Object.hasOwn(normalized, 'parts'), false, '精确分片数不能反推出 ROM 文件大小')
assert.equal(normalized.resumed, true)
assert.equal(normalizeRomUploadMetric({ ...input, measuredMbps: 1e12 }).measuredMbps, 100_000)
assert.equal(normalizeRomUploadMetric({ ...input, device: 'made-up-device' }).device, 'unknown')
assert.throws(() => normalizeRomUploadMetric({ ...input, uploadId: 'not-an-id' }), /去重 ID/)
assert.throws(() => normalizeRomUploadMetric({ ...input, sizeBand: '271828182' }), /大小档/)
assert.throws(() => normalizeRomUploadMetric({ ...input, durationMs: -1 }), /总耗时/)

let insertCall
await recordRomUploadMetric(input, { headers: { 'cf-ipcountry': 'cn' } }, async (sql, params) => {
  insertCall = { sql, params }
  return { affectedRows: 1 }
})
assert.match(insertCall.sql, /INSERT IGNORE INTO rom_upload_metrics/)
assert.ok(insertCall.params.includes('CN'))
for (const privateValue of ['private-rom-name.zip', 'roms/arcade/private-game.en.zip', 271_828_182, 991, '192.0.2.5']) {
  assert.equal(insertCall.params.includes(privateValue), false, `database parameters must omit ${privateValue}`)
}
assert.ok(!insertCall.sql.includes('fileName') && !insertCall.sql.includes('accountId'))

let statsSql = ''
const stats = await romUploadStats(99, async (sql) => {
  statsSql = sql
  return [{
    size_band: '128to512m', upload_mode: 'multipart', region: 'CN', device_class: 'desktop', network_type: '4g',
    attempts: '5', successful: '4', failed: '1', cancelled: '0', avg_duration_ms: '60000.8',
    avg_prepare_ms: '2000', avg_first_part_ms: '11000', avg_transfer_ms: '54000', avg_finalize_ms: '4000',
    avg_measured_mbps: '38.447', avg_concurrency: '3.5', avg_server_wait_ms: '42.5', avg_hash_wait_ms: '1.25', avg_resumed: '0.4',
  }]
})
assert.equal(stats.days, 30, '统计查询最多回看 30 天')
assert.match(statsSql, /GROUP BY size_band, upload_mode, region, device_class, network_type/)
assert.equal(stats.groups[0].attempts, 5)
assert.equal(stats.groups[0].successRate, 0.8)
assert.equal(stats.groups[0].avgDurationMs, 60_000.8)
assert.equal(stats.groups[0].avgPeakConcurrency, 3.5)
assert.equal(stats.groups[0].resumeRate, 0.4)

const adminRoutes = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8')
assert.match(adminRoutes, /post\('\/rom-upload-metrics', requireAbility\('games:edit'\)/, '写指标必须经过游戏编辑权限')
assert.match(adminRoutes, /get\('\/rom-upload-stats', requireAbility\('games:edit'\)/, '性能汇总与 ROM 上传使用相同权限')
const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS rom_upload_metrics/)
assert.match(schema, /不记录账号、IP、UA、文件名、ROM key 或精确文件大小/)

console.log('✔ ROM 上传指标只保存匿名分桶值，尺寸/设备边界、入库去敏和聚合统计通过')
