/** 启动漏斗的输入边界与 20 秒告警阈值；不连数据库。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isSlowStartup, normalizeStartupEvent, STARTUP_SLOW_MS } from '../src/startup-metrics.js'
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

const view = normalizeStartupEvent({ visitId: base.visitId, event: 'detail_view', platform: 'nds' })
assert.equal(view.attemptId, '', '详情页加载发生在点击前，不应伪造 attempt id')
assert.equal(view.elapsedMs, null)

const dirty = normalizeStartupEvent({ ...base, event: 'failed', detail: `  下载\n失败\u0000  ${'x'.repeat(300)}` })
assert.ok(!dirty.detail.includes('\n'))
assert.equal(dirty.detail.length, 160, '错误摘要必须截断，不能把堆栈或响应体塞进库')

assert.throws(() => normalizeStartupEvent({ ...base, event: 'almost_ready' }), /未知/)
assert.throws(() => normalizeStartupEvent({ ...base, event: 'first_frame', attemptId: '' }), /attemptId/)
assert.throws(() => normalizeStartupEvent({ ...base, event: 'first_frame', runtime: 'x/'.repeat(30) }), /运行时/)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const metricsSource = readFileSync(new URL('../src/startup-metrics.js', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS game_startup_events/)
assert.match(schema, /UNIQUE KEY uniq_startup_event \(visit_id, attempt_id, event\)/)
assert.match(migration, /game_startup_events（第一方启动漏斗与 20 秒性能告警）/)
assert.match(metricsSource, /const accepted = recorded \|\|/, '唯一键拦住的重放必须按幂等成功处理，不能误回 404')

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
assert.match(isolated, /keepalive:true/)
assert.doesNotMatch(renderShell({}), /8bitgo-runtime-bridge/, '直接打开隔离页时没有详情页漏斗，不应伪造一条')

console.log('✅ 启动漏斗输入与慢启动阈值测试通过')
