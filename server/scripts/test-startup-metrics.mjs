/** 启动漏斗的输入边界与 60 秒告警阈值；不连数据库。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { isSlowStartup, normalizeStartupEvent, normalizeStartupEventBatch, sanitizeStartupDetail, shapeFallbackRoute, shapePhaseTiming, STARTUP_SLOW_MS } from '../src/startup-metrics.js'
import { playShell } from '../src/routes/play.js'

const base = {
  visitId: '12345678-abcd-4321-abcd-123456789012',
  attemptId: 'abcdef12-abcd-4321-abcd-123456789012',
  runtime: 'emulatorjs',
  platform: 'nds',
}

const slow = normalizeStartupEvent({ ...base, event: 'slow_start', elapsedMs: 60_001 })
assert.equal(slow.elapsedMs, 60_001)
assert.equal(isSlowStartup(slow), true)
assert.equal(isSlowStartup({ ...slow, elapsedMs: STARTUP_SLOW_MS - 1 }), false, '未满 60 秒不应误报慢启动')
assert.equal(normalizeStartupEvent({ ...base, event: 'fallback_started', detail: 'core:melondsds>melonds-compat:wasm-crash' }).event,
  'fallback_started', '运行时与核心兜底阶段必须进入漏斗白名单')
assert.equal(normalizeStartupEvent({ ...base, event: 'fallback_first_frame' }).event, 'fallback_first_frame', '兜底首帧要和真正可玩分开统计')
assert.equal(normalizeStartupEvent({ ...base, event: 'fallback_playable' }).event, 'fallback_playable')
assert.equal(normalizeStartupEvent({ ...base, event: 'fallback_succeeded' }).event, 'fallback_succeeded')
assert.equal(normalizeStartupEvent({ ...base, event: 'fallback_failed' }).event, 'fallback_failed')
const fallbackBatch = normalizeStartupEventBatch([
  { ...base, event: 'fallback_first_frame' },
  { ...base, event: 'fallback_playable' },
])
assert.deepEqual(fallbackBatch.map((event) => event.event), ['fallback_first_frame', 'fallback_playable'], '兜底结果阶段应能和首帧一起合批')
const unobservable = normalizeStartupEvent({ ...base, event: 'readiness_unobservable', elapsedMs: 120_000 })
assert.equal(unobservable.event, 'readiness_unobservable', '跨域页面的不可观测状态必须可记录，但不能当成失败')
const interrupted = normalizeStartupEvent({ ...base, event: 'startup_interrupted', elapsedMs: 60_000, detail: '仍在下载 ROM：20MB/30MB' })
assert.equal(interrupted.event, 'startup_interrupted', '离开时尚未可玩的启动要与失败、超时分开记录')
const interruptedBatch = normalizeStartupEventBatch([
  { ...base, event: 'rom_load_start', elapsedMs: 30 },
  { ...base, event: 'startup_interrupted', elapsedMs: 60_000, detail: '仍在下载 ROM：20MB/30MB' },
])
assert.deepEqual(interruptedBatch.map((event) => event.event), ['rom_load_start', 'startup_interrupted'],
  '离页时应允许把中断事件与尚未发送的阶段合批写入')

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

const startupBatch = normalizeStartupEventBatch([
  { ...base, event: 'rom_load_start', elapsedMs: 30 },
  { ...base, event: 'core_warm_complete', elapsedMs: 420 },
  { ...base, event: 'download_complete', elapsedMs: 600 },
  { ...base, event: 'first_frame', elapsedMs: 800 },
])
assert.equal(startupBatch.length, 4, '同一次开局的资源、下载和画面阶段可以合批上报')
assert.throws(() => normalizeStartupEventBatch([
  { ...base, event: 'rom_load_start' },
  { ...base, attemptId: 'another-attempt', event: 'first_frame' },
]), /同一次启动/, '不能把不同 attempt 的耗时拼在一个批次')
assert.throws(() => normalizeStartupEventBatch([
  { ...base, event: 'rom_load_start' },
  { ...base, event: 'failed', detail: '失败' },
]), /不能批量/, '诊断事件保留原有单独保存和限流路径')
assert.throws(() => normalizeStartupEventBatch([
  { ...base, event: 'rom_load_start' },
  { ...base, event: 'rom_load_start' },
]), /不能重复/, '批次内重复阶段必须拒绝')

assert.deepEqual(shapePhaseTiming({
  avg_resource_ms: '1250.4',
  resource_samples: '4',
  avg_resource_to_first_frame_ms: 350,
  resource_to_first_frame_samples: 3,
  avg_first_frame_to_playable_ms: null,
  first_frame_to_playable_samples: 0,
}), {
  avgResourceMs: 1250,
  resourceSamples: 4,
  avgResourceToFirstFrameMs: 350,
  resourceToFirstFrameSamples: 3,
  avgFirstFrameToPlayableMs: null,
  firstFrameToPlayableSamples: 0,
  avgRomLoadMs: null,
  romLoadSamples: 0,
  avgCoreWarmMs: null,
  coreWarmSamples: 0,
  coreCacheHits: 0,
  avgResourceToRuntimeReadyMs: null,
  resourceToRuntimeReadySamples: 0,
}, '阶段汇总应取整，并保留每段有效样本量')
assert.deepEqual(shapePhaseTiming(), {
  avgResourceMs: null,
  resourceSamples: 0,
  avgResourceToFirstFrameMs: null,
  resourceToFirstFrameSamples: 0,
  avgFirstFrameToPlayableMs: null,
  firstFrameToPlayableSamples: 0,
  avgRomLoadMs: null,
  romLoadSamples: 0,
  avgCoreWarmMs: null,
  coreWarmSamples: 0,
  coreCacheHits: 0,
  avgResourceToRuntimeReadyMs: null,
  resourceToRuntimeReadySamples: 0,
}, '没有阶段数据时应返回空值而不是伪造 0ms')
assert.deepEqual(shapeFallbackRoute({
  route: 'core:melondsds>melonds-compat:wasm-crash https://private.example/rom',
  runtime: 'emulatorjs', attempts: '5', first_frames: '4', playable: '3', failures: '1',
}), {
  route: 'core:melondsds>melonds-compat:wasm-crash [URL]',
  runtime: 'emulatorjs', attempts: 5, firstFrames: 4, playable: 3, failures: 1, unresolved: 1,
}, '兜底路线展示前必须脱敏，并以尝试总数减去终态计算未确认数')
assert.equal(shapeFallbackRoute({ runtime: '../bad', attempts: 2, playable: 4 }).runtime, 'unknown', '非法目标运行时不能回显进后台')

assert.throws(() => normalizeStartupEvent({ ...base, event: 'almost_ready' }), /未知/)
assert.throws(() => normalizeStartupEvent({ ...base, event: 'first_frame', attemptId: '' }), /attemptId/)
assert.throws(() => normalizeStartupEvent({ ...base, event: 'first_frame', runtime: 'x/'.repeat(30) }), /运行时/)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const metricsSource = readFileSync(new URL('../src/startup-metrics.js', import.meta.url), 'utf8')
const startupFunnelSource = readFileSync(new URL('../../src/services/startupFunnel.ts', import.meta.url), 'utf8')
const adminRoute = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS game_startup_events/)
assert.match(schema, /UNIQUE KEY uniq_startup_event \(visit_id, attempt_id, event\)/)
assert.match(migration, /game_startup_events（第一方启动漏斗与 20 秒性能告警）/)
assert.match(metricsSource, /const accepted = recorded \|\|/, '唯一键拦住的重放必须按幂等成功处理，不能误回 404')
assert.match(metricsSource, /recentFailures/, '统计接口应提供最近启动失败明细')
assert.match(metricsSource, /readiness_unobservable/, '汇总必须单独统计无法观测的页面，不混进失败数')
assert.match(metricsSource, /SUM\(e\.event = 'startup_interrupted'\) AS interruptions/, '离页时尚未可玩的启动必须单独计数，不伪装成失败')
assert.match(metricsSource, /fallback_attempts/, '启动汇总必须分别统计兜底尝试、成功和失败')
assert.match(metricsSource, /fallback_successes/)
assert.match(metricsSource, /fallback_failures/)
assert.match(metricsSource, /e\.event = 'fallback_failed' AND NOT EXISTS \([\s\S]*recovered\.event = 'fallback_playable'/,
  '同一次开局后续恢复成功时，汇总不能再把早先的重试失败算作最终兜底失败')
assert.match(metricsSource, /MAX\(e\.event = 'fallback_failed'\) = 1 AND MAX\(e\.event = 'fallback_playable'\) = 0/,
  '兜底路线的成功与失败必须互斥，防止单次尝试同时计入两种结局')
assert.match(metricsSource, /event\.event === 'fallback_started'[\s\S]*ON DUPLICATE KEY UPDATE/, '同一启动的后续兜底跳转必须更新原路线记录')
assert.match(metricsSource, /elapsed_ms = GREATEST\(COALESCE\(elapsed_ms, 0\), COALESCE\(incoming\.elapsed_ms, 0\)\)/, '迟到的较旧兜底请求不能回滚到较短路线')
assert.match(metricsSource, /CHAR_LENGTH\(COALESCE\(incoming\.detail, ''\)\) > CHAR_LENGTH\(COALESCE\(detail, ''\)\)/, '相同毫秒内的路线更新只接受更完整的详情')
const fallbackUpsert = metricsSource.match(/const fallbackRouteUpdate = event\.event === 'fallback_started'[\s\S]*?ON DUPLICATE KEY UPDATE([\s\S]*?)`\s*:\s*''/)?.[1] ?? ''
const fallbackAssignmentOrder = ['runtime = IF(', 'platform = IF(', 'detail = IF(', 'elapsed_ms = GREATEST('].map((assignment) => fallbackUpsert.indexOf(assignment))
assert.ok(fallbackAssignmentOrder.every((index) => index >= 0), '兜底路线更新必须同步处理 runtime、platform、detail 和 elapsed_ms')
assert.ok(fallbackAssignmentOrder.every((index, position) => position === 0 || fallbackAssignmentOrder[position - 1] < index), '更新较长路线前要先用旧路线长度判定并更新 runtime/platform，最后更新 detail 和 elapsed_ms')
assert.match(metricsSource, /FROM \(\s+SELECT id AS game_id[\s\S]*\) AS incoming/, '兜底更新通过派生表访问新值，不新增 VALUES() 弃用调用')
assert.match(metricsSource, /const FALLBACK_ROUTE_QUERY = `/, '后台应按启动 attempt 合并兜底路线和结果')
assert.match(metricsSource, /HAVING MAX\(e\.event = 'fallback_started'\) = 1/, '没有实际兜底开始事件的孤立阶段不能生成路线尝试')
assert.match(metricsSource, /fallbackRoutes: fallbackRoutes\.map\(shapeFallbackRoute\)/, '兜底路线结果应经脱敏整形后返回')
assert.match(metricsSource, /sanitizeStartupDetail\(row\.detail\)/, '历史错误摘要返回后台前也必须脱敏')
assert.match(metricsSource, /WITH attempt_events AS/, '阶段统计必须先按一次启动配对事件')
assert.match(metricsSource, /UNION ALL\s+SELECT game_id, country, first_frame_runtime/, '不同运行时的回退事件不能拼成一个阶段')
assert.match(metricsSource, /resource_ms >= started_ms/, '资源耗时只接受晚于开始事件的配对')
assert.match(metricsSource, /first_frame_ms >= resource_ms/, '首帧阶段不能接受逆序事件')
assert.match(metricsSource, /playable_ms >= first_frame_ms/, '可玩阶段不能接受逆序事件')
assert.match(metricsSource, /start_runtime = resource_runtime/, '跨运行时切换的阶段不能错误归到某个运行时')
assert.match(metricsSource, /query\(PHASE_TIMING_QUERY, \[cutoff\]\)/, '四个维度应共用一条阶段聚合查询')
assert.match(metricsSource, /INSERT IGNORE INTO game_startup_events[\s\S]{0,550}CROSS JOIN/, '批量阶段用单条 INSERT 省掉逐事件 SQL 往返')
assert.match(metricsSource, /recordStartupEvents/, '服务端保留批量写入入口')
assert.match(metricsSource, /BATCHABLE_EVENTS/, '批量上报只允许普通启动阶段')
const batchableEvents = (source, name) => {
  const body = source.match(new RegExp(`const ${name} = new Set(?:<StartupEventName>)?\\(\\[([\\s\\S]*?)\\]\\)`))?.[1]
  assert.ok(body, `${name} 必须能从源码中解析`)
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()
}
assert.deepEqual(batchableEvents(startupFunnelSource, 'BATCHABLE_EVENTS'), batchableEvents(metricsSource, 'BATCHABLE_EVENTS'),
  '前端与后端的批量事件白名单必须一致，避免离页合批请求被服务端拒绝')
assert.match(readFileSync(new URL('../src/routes/games.js', import.meta.url), 'utf8'), /normalizeStartupEventBatch\(req\.body\.events\)/, '启动路由识别并校验阶段批次')
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
assert.match(isolated, /"slowMs":60000/, '隔离游玩页也必须用 60 秒慢启动阈值')
assert.match(isolated, /readiness_unobservable/)
assert.match(isolated, /readinessObservable/)
assert.match(isolated, /keepalive:true/)
assert.doesNotMatch(renderShell({}), /8bitgo-runtime-bridge/, '直接打开隔离页时没有详情页漏斗，不应伪造一条')

/* ---------- HTML5 慢启动与超时只累计前台时间 ---------- */
{
  const script = [...isolated.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1]
  assert.ok(script, '隔离页必须包含启动漏斗脚本')
  let now = 0
  let timerId = 0
  const timers = new Map()
  const canceledCallbacks = []
  const listeners = new Map()
  const reports = []
  const frameListeners = new Map()
  const frame = {
    contentDocument: { querySelector: () => null },
    contentWindow: {},
    addEventListener: (type, callback) => frameListeners.set(type, callback),
  }
  const document = {
    visibilityState: 'visible',
    querySelector: () => frame,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
  }
  const advance = (ms) => {
    const end = now + ms
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    now = end
  }
  const setVisibility = (visible) => {
    document.visibilityState = visible ? 'visible' : 'hidden'
    for (const callback of listeners.get('visibilitychange') ?? []) callback()
  }
  const window = { addEventListener() {} }
  vm.runInNewContext(script, {
    document,
    window,
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++timerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout(id) {
      const timer = timers.get(id)
      if (timer) canceledCallbacks.push(timer.callback)
      timers.delete(id)
    },
    encodeURIComponent,
    fetch: (_url, init) => {
      reports.push(JSON.parse(init.body))
      return Promise.resolve({ ok: true })
    },
  })
  advance(30_000)
  setVisibility(false)
  for (const callback of canceledCallbacks.splice(0)) callback()
  advance(10 * 60_000)
  assert.deepEqual(reports, [], '后台停留不能触发慢启动或超时')
  setVisibility(true)
  advance(29_999)
  assert.deepEqual(reports, [], '恢复前台后须累计完剩余前台时间')
  advance(1)
  assert.equal(reports[0]?.event, 'slow_start')
  assert.match(reports[0]?.detail, /前台累计等待/)
  advance(59_999)
  assert.equal(reports.some((item) => item.event === 'timeout'), false, '120 秒预算未满时不超时')
  advance(1)
  assert.equal(reports.at(-1)?.event, 'timeout')
  assert.match(reports.at(-1)?.detail, /前台累计等待/)
}

console.log('✅ 启动漏斗输入与慢启动阈值测试通过')
