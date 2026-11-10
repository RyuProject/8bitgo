/** 启动漏斗的输入边界与 20 秒告警阈值；不连数据库。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isSlowStartup, normalizeStartupEvent, sanitizeStartupDetail, STARTUP_SLOW_MS } from '../src/startup-metrics.js'
import { playShell } from '../src/routes/play.js'

const base = {
  visitId: '12345678-abcd-4321-abcd-123456789012',
  attemptId: 'abcdef12-abcd-4321-abcd-123456789012',
  runtime: 'emulatorjs',
  platform: 'nds',
}

const slow = normalizeStartupEvent({ ...base, event: 'slow_start', elapsedMs: 20_001 })
assert.equal(slow.elapsedMs, 20_001)
assert.equal(isSlowStartup(slow), true)
assert.equal(isSlowStartup({ ...slow, elapsedMs: STARTUP_SLOW_MS - 1 }), false, '未满 20 秒不应误报慢启动')
const unobservable = normalizeStartupEvent({ ...base, event: 'readiness_unobservable', elapsedMs: 120_000 })
assert.equal(unobservable.event, 'readiness_unobservable', '跨域页面的不可观测状态必须可记录，但不能当成失败')

const view = normalizeStartupEvent({ visitId: base.visitId, event: 'detail_view', platform: 'nds' })
assert.equal(view.attemptId, '', '详情页加载发生在点击前，不应伪造 attempt id')
assert.equal(view.elapsedMs, null)

const dirty = normalizeStartupEvent({ ...base, event: 'failed', detail: `  下载\n失败\u0000  ${'x'.repeat(300)}` })
assert.ok(!dirty.detail.includes('\n'))
assert.equal(dirty.detail.length, 160, '错误摘要必须截断，不能把堆栈或响应体塞进库')

const privateDetail = sanitizeStartupDetail('Fetch https://assets.8bitgo.com/roms/game.8bg?token=private failed for 192.168.1.23; Authorization: Bearer eyJhbGci.eyJzdWIi.signature')
assert.ok(!privateDetail.includes('https://'), '错误摘要不保存 ROM / 请求 URL')
assert.ok(!privateDetail.includes('private'), '错误摘要不保存 URL 查询凭据')
assert.ok(!privateDetail.includes('192.168.1.23'), '错误摘要不保存 IP 地址')
assert.ok(!privateDetail.includes('eyJhbGci'), '错误摘要不保存 Bearer / JWT 凭据')
assert.match(privateDetail, /Fetch \[URL\].*\[IP\].*Authorization/i, '脱敏后仍保留可诊断的错误上下文')
assert.equal(sanitizeStartupDetail('   '), null)

assert.throws(() => normalizeStartupEvent({ ...base, event: 'almost_ready' }), /未知/)
assert.throws(() => normalizeStartupEvent({ ...base, event: 'first_frame', attemptId: '' }), /attemptId/)
assert.throws(() => normalizeStartupEvent({ ...base, event: 'first_frame', runtime: 'x/'.repeat(30) }), /运行时/)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const metricsSource = readFileSync(new URL('../src/startup-metrics.js', import.meta.url), 'utf8')
const adminRoute = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS game_startup_events/)
assert.match(schema, /UNIQUE KEY uniq_startup_event \(visit_id, attempt_id, event\)/)
assert.match(migration, /game_startup_events（第一方启动漏斗与 20 秒性能告警）/)
assert.match(metricsSource, /const accepted = recorded \|\|/, '唯一键拦住的重放必须按幂等成功处理，不能误回 404')
assert.match(metricsSource, /recentFailures/, '统计接口应提供最近启动失败明细')
assert.match(metricsSource, /readiness_unobservable/, '汇总必须单独统计无法观测的页面，不混进失败数')
assert.match(metricsSource, /sanitizeStartupDetail\(row\.detail\)/, '历史错误摘要返回后台前也必须脱敏')
assert.match(adminRoute, /startupStats\(req\.query\.days, req\.query\.q\)/, '后台故障列表支持按游戏搜索')

const renderShell = (query) => {
  let html = ''
  const res = {
    status() { return this },
    set() { return this },
    end(value) { html = value },
  }
  playShell({ params: { slug: 'terraria' }, query }, res, () => { throw new Error('terraria 应命中隔离外壳') })
  return html
}
const isolated = renderShell({ fv: base.visitId, fa: base.attemptId, fs: Date.now() })
assert.match(isolated, /iframe_loaded/)
assert.match(isolated, /game_playable/)
assert.match(isolated, /slow_start/)
assert.match(isolated, /readiness_unobservable/)
assert.match(isolated, /readinessObservable/)
assert.match(isolated, /keepalive:true/)
assert.doesNotMatch(renderShell({}), /8bitgo-runtime-bridge/, '直接打开隔离页时没有详情页漏斗，不应伪造一条')

console.log('✅ 启动漏斗输入与慢启动阈值测试通过')
