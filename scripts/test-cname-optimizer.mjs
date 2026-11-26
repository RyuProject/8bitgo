// 优选 CNAME 自动维护的纯函数回归（不联网）。
import assert from 'node:assert/strict'
import {
  DEFAULTS, inCloudflare, isValidHostname, dnsRecordMatches, buildCandidates, judgeCandidate, pickReplacement, nextFailureCount, nextTargetFailureCount,
  judgeUserReports, combineVerdicts, reportSince, findHealthy, targetUserVerdicts,
  loadConfig, resolveIsps, createRunContext, readLimitedText, MAX_CANDIDATE_LIST_BYTES,
  freshWarmCandidates, selectWarmBatch, updateWarmCandidates, canClearNoCandidateBackoff, canSwitchWithCandidate, freshRouteQuality,
} from '../deploy/cname-optimizer/cname-optimizer.mjs'

assert.equal(inCloudflare('104.18.35.15'), true)
assert.equal(inCloudflare('172.64.153.208'), true)
assert.equal(inCloudflare('162.159.36.5'), true)
assert.equal(inCloudflare('47.76.127.217'), false)
assert.equal(inCloudflare('34.41.139.193'), false)

// 候选源只允许有界流式读取；超限时拒绝整份列表并尽早取消正文。
{
  const encoder = new TextEncoder()
  const bytes = encoder.encode('候选.example')
  const split = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 2))
      controller.enqueue(bytes.subarray(2))
      controller.close()
    },
  })
  assert.equal(await readLimitedText(new Response(split), bytes.byteLength), '候选.example')
  assert.equal(MAX_CANDIDATE_LIST_BYTES, 256 * 1024)

  let cancelled = false
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5))
      controller.enqueue(new Uint8Array(5))
    },
    cancel() { cancelled = true },
  })
  await assert.rejects(readLimitedText(new Response(oversized), 8), RangeError)
  assert.equal(cancelled, true, '超限时应取消外部正文流')

  let headerCancelled = false
  const oversizedHeader = new Response(new ReadableStream({ cancel() { headerCancelled = true } }), {
    headers: { 'content-length': '9' },
  })
  await assert.rejects(readLimitedText(oversizedHeader, 8), RangeError)
  assert.equal(headerCancelled, true, 'Content-Length 已超限时不应读正文')
}
assert.equal(inCloudflare('not-an-ip'), false)

assert.equal(isValidHostname('youxuan.cf.090227.xyz'), true)
assert.equal(isValidHostname('ChinaTelecom.youxuan.zmxf.cc.cd'), true)
assert.equal(isValidHostname('localhost'), false)
assert.equal(isValidHostname('1.2.3.4'), false)
assert.equal(isValidHostname('bad_host.example.com'), false)
assert.equal(dnsRecordMatches({ id: 'id1', type: 'CNAME', name: 'download.8bitgo.com', content: 'old.example.net', proxied: false }, { id: 'id1', host: 'download.8bitgo.com', target: 'old.example.net' }), true)
assert.equal(dnsRecordMatches({ id: 'id1', type: 'CNAME', name: 'download.8bitgo.com', content: 'new.example.net', proxied: false }, { id: 'id1', host: 'download.8bitgo.com', target: 'old.example.net' }), false, '人工改目标后不得覆盖')
assert.equal(dnsRecordMatches({ id: 'id1', type: 'CNAME', name: 'download.8bitgo.com', content: 'old.example.net', proxied: true }, { id: 'id1', host: 'download.8bitgo.com', target: 'old.example.net' }), false, '切到橙云后不得覆盖')
assert.equal(dnsRecordMatches({ id: 'id1', type: 'CNAME', name: 'download.8bitgo.com', content: 'old.example.net' }, { id: 'id1', host: 'download.8bitgo.com', target: 'old.example.net' }), false, 'Cloudflare 未明确返回 DNS-only 状态时失败关闭')

// 候选池只用近期成功样本；轮换预热避免每轮重测同一组，最终切换仍由主流程复核。
{
  const now = 100_000
  const pool = [
    { name: 'fresh.example.net', checkedAt: now - 1_000, medianMs: 20 },
    { name: 'stale.example.net', checkedAt: now - DEFAULTS.candidateWarmTtlMs, medianMs: 5 },
    { name: 'future.example.net', checkedAt: now + 1, medianMs: 1 },
    { name: 'fresh.example.net', checkedAt: now - 2_000, medianMs: 30 },
  ]
  assert.deepEqual(freshWarmCandidates(pool, now, DEFAULTS.candidateWarmTtlMs, 3).map((entry) => entry.name), ['fresh.example.net'])
  assert.deepEqual(selectWarmBatch(['a.example.net', 'b.example.net', 'c.example.net'], 'a.example.net', [], [{ name: 'b.example.net' }], 1), {
    names: ['c.example.net'], cursor: 'c.example.net',
  }, '优先轮到未预热候选')
  assert.deepEqual(selectWarmBatch(['a.example.net', 'b.example.net'], 'b.example.net', [], [{ name: 'a.example.net' }, { name: 'b.example.net' }], 1).names, ['a.example.net'], '清单耗尽后刷新缓存项')
  assert.equal(selectWarmBatch(Array.from({ length: 20 }, (_, i) => `c${i}.example.net`), '', [], [], DEFAULTS.maxDueCandidatesPerHost).names.length, 8, '单轮全量扫描有明确上限')
  const updated = updateWarmCandidates(pool, [
    { name: 'fresh.example.net', verdict: { healthy: false, indeterminate: false } },
    { name: 'uncertain.example.net', verdict: { healthy: false, indeterminate: true } },
    { name: 'good.example.net', verdict: { healthy: true, medianMs: 40 } },
  ], now, DEFAULTS.candidateWarmTtlMs, 3)
  assert.deepEqual(updated.map((entry) => entry.name), ['good.example.net'])
  assert.equal(canClearNoCandidateBackoff(true, false), false, '仍在无候选冷却期且没有新健康目标时保留冷却')
  assert.equal(canClearNoCandidateBackoff(true, true), true, '新预热目标健康时解除冷却')
  assert.equal(canClearNoCandidateBackoff(false, false), true, '冷却已过期时清除状态')
  assert.equal(canSwitchWithCandidate(true, [{ verdict: { healthy: false } }]), false, '冷却期不允许未验证或失败的候选触发切换')
  assert.equal(canSwitchWithCandidate(true, [{ verdict: { healthy: true } }]), true, '冷却期允许本轮已复测健康的预热候选切换')
}

const names = buildCandidates({
  listText: 'a.example.com\nB.example.com # 注释\n\nlogin.rockwellautomation.com\nx.8bitgo.com\nbad_host.example\n',
  seeds: ['a.example.com', 'c.example.com'],
  current: ['cur.example.net.'],
  blocklist: ['login.rockwellautomation.com'],
})
assert.deepEqual(names, ['cur.example.net', 'a.example.com', 'b.example.com', 'c.example.com'])

const ok = (ms) => ({ ok: true, ms })
const bad = { ok: false, ms: 0, why: '超时' }
assert.equal(judgeCandidate({ isps: {} }).healthy, false)
assert.equal(judgeCandidate({ isps: { ct: { probes: [], nonCloudflare: ['1.2.3.4'] } } }).healthy, false)
assert.equal(judgeCandidate({ isps: { ct: { probes: [ok(10)] }, cu: { probes: [bad, bad] } } }).healthy, false, '一个运营商全挂就不健康')
assert.equal(judgeCandidate({ isps: { ct: { probes: [ok(10), bad, bad] }, cu: { probes: [bad, ok(20)] }, cm: { probes: [bad, ok(30)] } } }).healthy, false, '成功率不足一半')
const good = judgeCandidate({ isps: { ct: { probes: [ok(10), ok(30)] }, cu: { probes: [ok(20), bad] } } })
assert.equal(good.healthy, true)
assert.equal(good.medianMs, 20)
const incomplete = judgeCandidate({ isps: {
  ct: { probes: [ok(10)], resolutionStatus: 'ok' },
  cu: { probes: [], resolutionStatus: 'error' },
  cm: { probes: [ok(30)], resolutionStatus: 'ok' },
} }, ['ct', 'cu', 'cm'])
assert.equal(incomplete.healthy, false)
assert.equal(incomplete.indeterminate, true, 'DoH 故障是未知，不能把剩余单网当成三网健康')
assert.equal(judgeCandidate({ isps: {
  ct: { probes: [ok(10)], resolutionStatus: 'ok' },
  cu: { probes: [], resolutionStatus: 'empty' },
  cm: { probes: [ok(30)], resolutionStatus: 'ok' },
} }, ['ct', 'cu', 'cm']).hardFailure, true, '明确没有 IPv4 答案属于目标故障')

const c = (name, healthy, medianMs) => ({ name, verdict: { healthy, medianMs, reason: '' } })
const judged = [c('cur', true, 5), c('busy', true, 10), c('slow', true, 50), c('dead', false)]
assert.equal(pickReplacement(judged, { exclude: ['cur'], inUseElsewhere: ['busy'] }).name, 'slow', '优先不和别的域名共用同一个目标')
assert.equal(pickReplacement(judged, { exclude: ['cur'] }).name, 'busy')
assert.equal(pickReplacement([c('dead', false)], {}), null)

assert.equal(nextFailureCount(undefined, false), 1)
assert.equal(nextFailureCount(2, false), 3)
assert.equal(nextFailureCount(5, true), 0)
assert.equal(nextFailureCount(2, false, true), 2, '探测不完整不累加故障次数')
assert.equal(nextTargetFailureCount({ target: 'old', failures: 2 }, 'new', false), 1, '人工改目标后从新目标重新计数')
assert.equal(nextTargetFailureCount({ target: 'same', failures: 2 }, 'same', false, true), 2)

// 大陆玩家回报
assert.equal(judgeUserReports(undefined).verdict, 'unknown')
assert.equal(judgeUserReports({ visitors: 4, failOnlyVisitors: 4 }).verdict, 'unknown', '人数不够不下结论')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 3, failOnlyVisitors: 7 }).verdict, 'bad')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 9, failOnlyVisitors: 1 }).verdict, 'good')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 6, failOnlyVisitors: 4 }).verdict, 'unknown')
assert.deepEqual(judgeUserReports({ visitors: 10, okVisitors: 9, failOnlyVisitors: 1, rateVisitors: 8, medianBytesPerMs: 400 }).quality, {
  medianBytesPerMs: 400, visitors: 8,
}, '只有足够多独立玩家提供的正文样本进入质量排序')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 9, failOnlyVisitors: 1, rateVisitors: 4, medianBytesPerMs: 400 }).quality, undefined)

const qualityNow = Date.parse('2026-11-26T00:00:00Z')
const sourceFast = c('source-fast.example', true, 5)
const mainlandFast = c('mainland-fast.example', true, 50)
assert.equal(pickReplacement([sourceFast, mainlandFast], {
  nowMs: qualityNow,
  routeQuality: {
    'source-fast.example': { visitors: 8, medianBytesPerMs: 50, observedAt: new Date(qualityNow).toISOString() },
    'mainland-fast.example': { visitors: 7, medianBytesPerMs: 500, observedAt: new Date(qualityNow).toISOString() },
  },
}).name, 'mainland-fast.example', '足够样本的大陆实测速率优先于香港源站延迟')
assert.equal(pickReplacement([sourceFast, mainlandFast], {
  nowMs: qualityNow,
  routeQuality: { 'mainland-fast.example': { visitors: 7, medianBytesPerMs: 500, observedAt: new Date(qualityNow - 7 * 60 * 60 * 1000).toISOString() } },
}).name, 'source-fast.example', '过期的大陆表现不参与排序')
assert.equal(freshRouteQuality({ 'mainland-fast.example': { visitors: 4, medianBytesPerMs: 500, observedAt: new Date(qualityNow).toISOString() } }, 'mainland-fast.example', qualityNow, 3600000, 5), undefined, '独立访客样本不足不参与质量排序')

const healthyProbe = { healthy: true, reason: '4/4 个 IP 正常' }
const flakyProbe = { healthy: false, reason: 'cu 线路的 IP 全部不通' }
const hardProbe = { healthy: false, hardFailure: true, reason: '解析到非 Cloudflare IP：1.2.3.4' }
assert.equal(combineVerdicts(healthyProbe, { verdict: 'bad', reason: 'x' }).healthy, false, '香港通、大陆不通 → 不健康')
assert.equal(combineVerdicts(healthyProbe, { verdict: 'bad', reason: 'x' }).byUsers, true)
assert.equal(combineVerdicts(flakyProbe, { verdict: 'good', reason: 'x' }).healthy, true, '玩家都连得上就不因源站抖动换线')
assert.equal(combineVerdicts(hardProbe, { verdict: 'good', reason: 'x' }).healthy, false, '非 CF IP 是硬伤')
assert.equal(combineVerdicts(flakyProbe, { verdict: 'unknown', reason: 'x' }).healthy, false)
assert.equal(combineVerdicts(incomplete, { verdict: 'unknown', reason: 'x' }).indeterminate, true)
assert.equal(combineVerdicts({ ...incomplete, hardFailure: true }, { verdict: 'good', reason: 'x' }).healthy, false)
assert.equal(combineVerdicts(healthyProbe, null).healthy, true)

const t0 = Date.parse('2026-11-22T00:00:00Z')
const grace = 600_000
assert.equal(reportSince({ target: 'a', switchedAt: '2026-11-21T00:00:00Z' }, 'a', t0, grace), Date.parse('2026-11-21T00:10:00Z'))
assert.equal(reportSince({ target: 'old', switchedAt: '2026-11-21T00:00:00Z' }, 'a', t0, grace), t0 + grace, '目标被手动改过：从现在重新算')
assert.equal(reportSince({}, 'a', t0, grace), t0 + grace)

// 候选体检：限并发、凑够就停
{
  let inFlight = 0
  let peak = 0
  const examined = []
  const examine = async (name) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    examined.push(name)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    return { name, verdict: { healthy: !name.startsWith('dead') } }
  }
  const names = ['dead1', 'dead2', 'ok1', 'ok2', 'ok3', 'ok4', 'ok5', 'ok6', 'ok7', 'ok8']
  const judged = await findHealthy(names, examine, { concurrency: 3, want: 2 })
  assert.ok(peak <= 3, `并发不超过 3（实际 ${peak}）`)
  assert.ok(judged.filter((c) => c.verdict.healthy).length >= 2)
  assert.ok(examined.length < names.length, `凑够就停（只测了 ${examined.length} 个）`)
  assert.equal((await findHealthy(names, examine, { concurrency: 4, want: Infinity })).length, names.length, '全量体检时都测')
  let unknownExamined = 0
  const partial = await findHealthy(['a', 'b', 'c', 'd', 'e', 'f'], async (name) => {
    unknownExamined++
    await new Promise((r) => setTimeout(r, 1))
    return { name, verdict: { healthy: false, indeterminate: true } }
  }, { concurrency: 2, want: 3, stopOnIndeterminate: 3 })
  assert.ok(partial.length >= 3 && partial.length <= 4, `达到未知阈值后只等待在途探测完成（实际 ${partial.length}）`)
  assert.ok(unknownExamined <= 4, 'DoH 故障时只完成少量在途探测，不打满整份候选清单')
  assert.deepEqual(await findHealthy([], examine), [])
}

// DoH 报错、明确无记录必须分别保留；DNS 服务故障不能退回香港答案伪装成三网结果。
{
  const cfg = { ecsSubnets: { ct: 'ct-net', cu: 'cu-net', cm: 'cm-net' } }
  const answers = await resolveIsps(cfg, 'candidate.example', async (_cfg, _name, subnet) => {
    if (subnet === 'ct-net') return ['104.16.1.1']
    if (subnet === 'cu-net') return []
    throw new Error('resolver unavailable')
  })
  assert.deepEqual(answers.ct, { ips: ['104.16.1.1'], status: 'ok' })
  assert.deepEqual(answers.cu, { ips: [], status: 'empty' })
  assert.equal(answers.cm.status, 'error')
}

// 每个候选都要以将被配置的托管域名做 SNI / Host；DNS 查询可跨域名复用，TLS 结果不可复用。
{
  const cfg = { ...DEFAULTS, ecsSubnets: { ct: 'ct', cu: 'cu', cm: 'cm' }, ipsPerIsp: 2 }
  let dnsCalls = 0
  const probedHosts = []
  const run = createRunContext(cfg, 'etag', {
    resolve: async () => {
      dnsCalls++
      return Object.fromEntries(Object.keys(cfg.ecsSubnets).map((isp) => [isp, { ips: ['104.16.1.1'], status: 'ok' }]))
    },
    probe: async (_cfg, ip, host, etag) => {
      assert.equal(ip, '104.16.1.1')
      assert.equal(etag, 'etag')
      probedHosts.push(host)
      return { ip, ok: true, ms: 10, etag }
    },
  })
  const rom = await run.examine('candidate.example', 'rom.8bitgo.com')
  const download = await run.examine('candidate.example', 'download.8bitgo.com')
  assert.equal(rom.verdict.healthy, true)
  assert.equal(download.verdict.healthy, true)
  assert.deepEqual(probedHosts, ['rom.8bitgo.com', 'download.8bitgo.com'])
  assert.equal(dnsCalls, 1, '同一候选 DNS 只查一次')
  assert.equal(run.probeCount(), 2, '同一个 IP 的不同 SNI 必须分别实测')
}

// 守住运行配置边界，避免坏环境变量把探测参数变成无限值或空托管列表。
{
  assert.equal(loadConfig({}).probeConcurrency, DEFAULTS.probeConcurrency)
  assert.throws(() => loadConfig({ CNAME_OPT_HOSTS: '' }), /非空/)
  assert.throws(() => loadConfig({ CNAME_OPT_FAIL_THRESHOLD: '-1' }), /整数/)
  assert.throws(() => loadConfig({ CNAME_OPT_PROBE_CONCURRENCY: 'abc' }), /数字/)
  assert.throws(() => loadConfig({ CNAME_OPT_LIST_URL: 'http://example.com/list.txt' }), /HTTPS/)
}

// 同一目标：一个域名被判坏，另一个跟着坏；不同目标互不影响
{
  const bad = { verdict: 'bad', reason: '大陆回报 9 人' }
  const unk = { verdict: 'unknown', reason: '不足' }
  const out = targetUserVerdicts([
    { host: 'rom', target: 'x', user: bad },
    { host: 'download', target: 'x', user: unk },
    { host: 'other', target: 'y', user: unk },
  ])
  assert.equal(out.rom, bad)
  assert.equal(out.download.verdict, 'bad')
  assert.match(out.download.reason, /rom/)
  assert.equal(out.other, unk)
}

// 状态文件默认路径与 systemd 单元一致（手动 dry-run 和定时器看同一份）
{
  const { readFileSync } = await import('node:fs')
  const unit = readFileSync(new URL('../deploy/cname-optimizer/8bitgo-cname-optimizer.service', import.meta.url), 'utf8')
  const src = readFileSync(new URL('../deploy/cname-optimizer/cname-optimizer.mjs', import.meta.url), 'utf8')
  const unitPath = /CNAME_OPT_STATE_FILE=(\S+)/.exec(unit)[1]
  assert.ok(src.includes(`stateFile: '${unitPath}'`), '默认状态路径要和单元文件一致')
  assert.match(src, /if \(dryRun\) return\n/, 'dry-run 不落状态')
  assert.match(src, /const dryRun = .*argv\.includes\('--survey'\)/, '--survey 只能体检，不能改 DNS 或写状态')
  assert.match(src, /dnsRecordMatches\(latest,/, '写 DNS 前必须重新核对记录，避免覆盖并发人工修改')
  assert.match(src, /dnsRecordMatches\(updated,/, '写 DNS 后必须核对 Cloudflare 返回的新记录')
}

console.log('cname-optimizer：全部通过')
