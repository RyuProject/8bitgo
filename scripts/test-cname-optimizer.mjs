// 优选 CNAME 自动维护的纯函数回归（不联网）。
import assert from 'node:assert/strict'
import {
  inCloudflare, isValidHostname, buildCandidates, judgeCandidate, pickReplacement, nextFailureCount,
  judgeUserReports, combineVerdicts, reportSince, findHealthy, targetUserVerdicts,
} from '../deploy/cname-optimizer/cname-optimizer.mjs'

assert.equal(inCloudflare('104.18.35.15'), true)
assert.equal(inCloudflare('172.64.153.208'), true)
assert.equal(inCloudflare('162.159.36.5'), true)
assert.equal(inCloudflare('47.76.127.217'), false)
assert.equal(inCloudflare('34.41.139.193'), false)
assert.equal(inCloudflare('not-an-ip'), false)

assert.equal(isValidHostname('youxuan.cf.090227.xyz'), true)
assert.equal(isValidHostname('ChinaTelecom.youxuan.zmxf.cc.cd'), true)
assert.equal(isValidHostname('localhost'), false)
assert.equal(isValidHostname('1.2.3.4'), false)
assert.equal(isValidHostname('bad_host.example.com'), false)

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

const c = (name, healthy, medianMs) => ({ name, verdict: { healthy, medianMs, reason: '' } })
const judged = [c('cur', true, 5), c('busy', true, 10), c('slow', true, 50), c('dead', false)]
assert.equal(pickReplacement(judged, { exclude: ['cur'], inUseElsewhere: ['busy'] }).name, 'slow', '优先不和别的域名共用同一个目标')
assert.equal(pickReplacement(judged, { exclude: ['cur'] }).name, 'busy')
assert.equal(pickReplacement([c('dead', false)], {}), null)

assert.equal(nextFailureCount(undefined, false), 1)
assert.equal(nextFailureCount(2, false), 3)
assert.equal(nextFailureCount(5, true), 0)

// 大陆玩家回报
assert.equal(judgeUserReports(undefined).verdict, 'unknown')
assert.equal(judgeUserReports({ visitors: 4, failOnlyVisitors: 4 }).verdict, 'unknown', '人数不够不下结论')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 3, failOnlyVisitors: 7 }).verdict, 'bad')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 9, failOnlyVisitors: 1 }).verdict, 'good')
assert.equal(judgeUserReports({ visitors: 10, okVisitors: 6, failOnlyVisitors: 4 }).verdict, 'unknown')

const healthyProbe = { healthy: true, reason: '4/4 个 IP 正常' }
const flakyProbe = { healthy: false, reason: 'cu 线路的 IP 全部不通' }
const hardProbe = { healthy: false, reason: '解析到非 Cloudflare IP：1.2.3.4' }
assert.equal(combineVerdicts(healthyProbe, { verdict: 'bad', reason: 'x' }).healthy, false, '香港通、大陆不通 → 不健康')
assert.equal(combineVerdicts(healthyProbe, { verdict: 'bad', reason: 'x' }).byUsers, true)
assert.equal(combineVerdicts(flakyProbe, { verdict: 'good', reason: 'x' }).healthy, true, '玩家都连得上就不因源站抖动换线')
assert.equal(combineVerdicts(hardProbe, { verdict: 'good', reason: 'x' }).healthy, false, '非 CF IP 是硬伤')
assert.equal(combineVerdicts(flakyProbe, { verdict: 'unknown', reason: 'x' }).healthy, false)
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
  assert.deepEqual(await findHealthy([], examine), [])
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
}

console.log('cname-optimizer：全部通过')
