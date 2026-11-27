import assert from 'node:assert/strict'
import { summarizeHealthAlerts, STARTUP_MIN_SAMPLES } from '../src/admin-health.js'

const healthy = {
  schema: { missingTables: [], missingColumns: [], invalidDos: [], nonStreamingWindows: 0, error: null },
  startup: { starts: STARTUP_MIN_SAMPLES, playable: STARTUP_MIN_SAMPLES, failures: 0, slow: 0, interrupted: 0 },
  diagnostics: { groups: [] },
  jobs: { queues: [], recentFailures: [], partialError: null },
  content: { pendingComments: 0, visibleWithoutRom: 0, hiddenGames: 0, draftPosts: 0 },
  edgePurge: { enabled: true, pending: false, last: { at: '2026-11-15T00:00:00.000Z', ok: true } },
}

assert.deepEqual(summarizeHealthAlerts(healthy), [], '健康数据不应产生告警')
assert.deepEqual(
  summarizeHealthAlerts({ ...healthy, startup: { ...healthy.startup, starts: STARTUP_MIN_SAMPLES - 1, failures: STARTUP_MIN_SAMPLES - 1 } }),
  [],
  '样本不足时不能因比例极端而误报启动失败率',
)

const alerts = summarizeHealthAlerts({
  ...healthy,
  schema: { ...healthy.schema, missingTables: [{ table: 'saves' }] },
  startup: { starts: 100, playable: 80, failures: 20, slow: 4, interrupted: 7 },
  jobs: { queues: [{ kind: 'psp', active: 2, queued: 1, completed24h: 0, failed24h: 1, stalled: 2 }], recentFailures: [], partialError: null },
  content: { ...healthy.content, visibleWithoutRom: 3, pendingComments: 2 },
  edgePurge: { enabled: true, pending: false, last: { at: '2026-11-15T00:00:00.000Z', ok: false, error: 'timeout' } },
})
assert.deepEqual(alerts.map(({ level }) => level), ['error', 'error', 'error', 'warn', 'warn', 'warn', 'info'])
assert.ok(alerts.some(({ key }) => key === 'schema-missing'))
assert.ok(alerts.some(({ key }) => key === 'startup-rate'))
assert.ok(alerts.some(({ key }) => key === 'jobs-stalled'))
assert.ok(alerts.some(({ key }) => key === 'games-no-rom'))

const partialSchema = summarizeHealthAlerts({
  ...healthy,
  schema: null,
  diagnostics: { error: "Table 'diagnostics' doesn't exist", missingTable: true },
  jobs: { error: "Table 'jobs' doesn't exist", missingTable: true },
})
assert.ok(!partialSchema.some(({ key }) => key === 'diag-error' || key === 'jobs-error'), '缺表诊断应由 schema 告警负责，避免重复报错')

console.log('✔ 站点健康告警阈值、严重度顺序与缺表降噪通过')
