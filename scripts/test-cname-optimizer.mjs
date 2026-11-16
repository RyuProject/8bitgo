// 优选 CNAME 自动维护的纯函数回归（不联网）。
import assert from 'node:assert/strict'
import {
  inCloudflare, isValidHostname, buildCandidates, judgeCandidate, pickReplacement, nextFailureCount,
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

console.log('cname-optimizer：全部通过')
