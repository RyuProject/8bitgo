/** 验证缺少完整现场时会把安全摘要写进诊断表；使用内存假库，不连数据库或外部通知。 */
import { register } from 'node:module'
import assert from 'node:assert/strict'

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/db.js')) return { url: 'data:text/javascript,export async function query(sql,params){return globalThis.__startupDiagnosticFakeDb.query(sql,params)}', shortCircuit: true }
    if (specifier.endsWith('/diag-alert.js')) return { url: 'data:text/javascript,export async function maybeAlertSignature(){globalThis.__startupDiagnosticFakeDb.effects.push("alert")}', shortCircuit: true }
    if (specifier.endsWith('/diag-lark.js')) return { url: 'data:text/javascript,export async function notifyLarkFailure(){globalThis.__startupDiagnosticFakeDb.effects.push("lark")}', shortCircuit: true }
    return nextResolve(specifier, context)
  }
`))

const state = globalThis.__startupDiagnosticFakeDb = {
  inserts: [],
  effects: [],
  async query(sql, params) {
    if (/SELECT event, elapsed_ms FROM game_startup_events/.test(sql.replace(/\s+/g, ' '))) {
      const finalEvent = String(params?.[1] ?? '').includes('timeout') ? 'timeout' : 'failed'
      return [
        { event: 'start_click', elapsed_ms: 0 },
        { event: 'iframe_loaded', elapsed_ms: 350 },
        { event: finalEvent, elapsed_ms: 920 },
      ]
    }
    if (/INSERT IGNORE INTO game_startup_diagnostics/.test(sql)) {
      this.inserts.push({ sql, params })
      return { affectedRows: 1 }
    }
    if (/DELETE FROM game_startup_diagnostics/.test(sql)) return { affectedRows: 0 }
    throw new Error(`意外的 SQL：${sql}`)
  },
}

const { recordStartupDiagnostics } = await import('../src/startup-diagnostics.js')
const event = {
  event: 'failed', visitId: 'visit-summary-1234', attemptId: 'attempt-summary-1234',
  runtime: 'page', platform: 'html5', elapsedMs: 920,
  detail: 'Error: Minified React error #185',
}
const inserted = await recordStartupDiagnostics('super-mario-bros', event, null, {
  country: 'CN',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
  summaryNote: 'missing',
  suppressSideEffects: true,
})

assert.equal(inserted, true)
assert.equal(state.inserts.length, 1)
const payload = JSON.parse(state.inserts[0].params[12])
assert.deepEqual(payload.capture, { level: 'summary', note: 'missing' })
assert.equal(payload.diagnosis.code, 'react_update_loop', '摘要仍按明确错误文本归类')
assert.equal(payload.env, null)
assert.equal(payload.build, '')
assert.deepEqual(payload.attempt, { index: 0, sinceStartMs: 0 })
assert.deepEqual(payload.logs, [])
assert.deepEqual(payload.resources, [])
assert.deepEqual(payload.timeline, [
  { t: 0, e: 'start_click' },
  { t: 350, e: 'iframe_loaded' },
  { t: 920, e: 'failed' },
])
assert.equal(state.inserts[0].params[9], 'Edge 157')
assert.equal(state.inserts[0].params[10], 'Windows')
assert.doesNotMatch(JSON.stringify(payload), /Mozilla\/5\.0|Windows NT 10\.0|Chrome\/157/)
assert.deepEqual(state.effects, [], '历史摘要回填不得发报警、飞书或触发 AI 分诊')
await recordStartupDiagnostics('super-mario-bros', {
  ...event,
  event: 'timeout', attemptId: 'attempt-timeout-1234',
  detail: '连续 120 秒没有启动进度或可玩信号',
}, null, { country: 'CN', summaryNote: 'limited', suppressSideEffects: true })
const timeoutPayload = JSON.parse(state.inserts[1].params[12])
assert.equal(timeoutPayload.capture.note, 'limited')
assert.equal(timeoutPayload.diagnosis.code, 'timeout', '启动超时摘要仍按事件与错误摘要归类')
assert.equal(timeoutPayload.reason, '连续 120 秒没有启动进度或可玩信号')
await recordStartupDiagnostics('super-mario-bros', {
  ...event,
  visitId: 'visit-full-12345678', attemptId: 'attempt-full-12345678',
}, {
  build: 'index-current.js', reason: 'RuntimeError: test trap',
  env: { mem: 8, cores: 8, screen: '1920x1080@1', lang: 'zh-CN', online: true },
  attempt: { index: 2, sinceStartMs: 900 },
  timeline: [{ t: 0, e: 'start_click' }],
  logs: [{ t: 900, s: 'ejs', l: 'error', m: 'RuntimeError: test trap' }],
  resources: [{ n: '8bitgo.com/emulatorjs/…/core.data', i: 'fetch', st: 200 }],
}, { country: 'CN', suppressSideEffects: true })
const fullPayload = JSON.parse(state.inserts[2].params[12])
assert.deepEqual(fullPayload.capture, { level: 'full' })
assert.equal(fullPayload.env.mem, 8)
assert.equal(fullPayload.build, 'index-current.js')
assert.equal(fullPayload.logs[0].m, 'RuntimeError: test trap')
assert.equal(fullPayload.resources[0].st, 200)
console.log('✔ 缺包摘要与完整现场均可入库；摘要不伪造现场，原有完整现场字段保持不变')
