#!/usr/bin/env node
// 8BitGo 优选 CNAME 自动维护：download.8bitgo.com / rom.8bitgo.com 是 DNS-only CNAME 到第三方
// Cloudflare 优选域名（BestCF 汇总的那批）。这些域名是别人的，随时可能失效、改指向或不再指向 Cloudflare。
// 这个脚本定时体检当前目标，连续失败才换成另一个健康的优选域名，然后改 Cloudflare DNS 记录。
//
// 为什么这样判：
// - 解析走 AliDNS DoH 并带大陆三网的 ECS 子网：优选域名是按运营商分线解析的，源站（香港）直接解析
//   拿到的是海外答案，体检就测错了对象。DoH 失败按「本轮未知」处理，不拿海外答案冒充三网结果。
// - 每个 IP 都要在 Cloudflare 段里，并且用「连这个 IP + SNI/Host=我们的域名」真取一次 64KB 探针，
//   ETag 与 assets.8bitgo.com 一致才算通。只看 DNS 解析得出来不够：有些 CF 客户的专属 IP 不服务别的区域。
// - 只看「能不能用」，不按源站测到的快慢换线路：源站在香港，测出的速度代表不了大陆玩家。
//   当前目标健康就一直不动；连续 FAIL_THRESHOLD 次不健康才换，避免抖动。
// - 本站自己的基线（assets.8bitgo.com 直取探针）先测；基线都失败说明是我们或源站网络的问题，本轮不动 DNS。
// - 换线时尽量让各个托管域名指向不同的优选域名，一个坏了不会两个一起坏。
// - 浏览器端本来就有 download → assets 的回退，DNS 换线只是让失效时间变短，不是唯一保障。
//
// 用法：node cname-optimizer.mjs [--dry-run] [--status] [--survey]
//   --status  只体检并打印，不写状态、不改 DNS
//   --survey  不管当前是否健康，都把全部候选体检一遍并打印排名（只读）
//   --dry-run 照常判断，但不调用 Cloudflare 改记录
// 配置走环境变量（systemd 用 EnvironmentFile=/etc/8bitgo/cname-optimizer.env），见 .env.example。

import https from 'node:https'
import dns from 'node:dns/promises'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULTS = {
  hosts: ['download.8bitgo.com', 'rom.8bitgo.com'],
  probePath: '/roms/_route-probe/v1.bin?v=1',
  probeBytes: 65536,
  baselineHost: 'assets.8bitgo.com',
  candidateListUrl: 'https://raw.githubusercontent.com/DustinWin/BestCF/bestcf/bestcf-domain.txt',
  // 列表拉不到时的保底候选（同样要过体检）。
  seedCandidates: [
    'youxuan.cf.090227.xyz',
    'cf.0sm.com',
    'cfip.cfcdn.vip',
    'bestcf.top',
    'cdn.2020111.xyz',
    'cf-cname.xingpingcn.top',
    'bestcf.030101.xyz',
    'bestcf.cloudflare.182682.xyz',
    'cf.blogluo.eu.org',
  ],
  // 明显是别家公司业务域名、只是恰好挂在 Cloudflare 上的：对方一改架构就失效，也不该拿别人的业务域名当线路。
  blocklist: ['53.fs1.hubspotusercontent-na1.net', 'login.rockwellautomation.com'],
  // 大陆三网的代表子网（广东电信 / 联通 / 移动的 DNS 所在段），用作 DoH 的 edns_client_subnet。
  ecsSubnets: { ct: '202.96.134.0/24', cu: '210.21.196.0/24', cm: '211.136.192.0/24' },
  dohUrl: 'https://dns.alidns.com/resolve',
  ipsPerIsp: 2,
  probeTimeoutMs: 12000,
  failThreshold: 3,
  // 和 systemd 单元里的 CNAME_OPT_STATE_FILE 一致：手动跑和定时器跑看的是同一份状态
  stateFile: '/var/lib/8bitgo-cname-optimizer/state.json',
  // 大陆玩家的真实回报（server/src/route-report.js，只允许本机读）。留空则只看源站体检。
  reportUrl: 'http://127.0.0.1:8788/api/internal/route-health',
  // 至少这么多不同访客有数据才下结论；全失败访客占比 ≥ badShare 判坏，有成功访客占比 ≥ goodShare 判好。
  reportMinVisitors: 5,
  reportBadShare: 0.6,
  reportGoodShare: 0.8,
  reportQualityMinVisitors: 5,
  reportQualityTtlMs: 6 * 60 * 60 * 1000,
  // 换线后这段时间内的回报不算新目标的：DNS TTL 300 秒 + 运营商缓存，玩家还在连旧目标。
  reportGraceMs: 10 * 60 * 1000,
  // 因玩家回报换掉的目标，这么久内不再选回来（源站体检看它多半还是「健康」）。
  userBadTtlMs: 6 * 60 * 60 * 1000,
  // 同时体检几个候选域名（每个域名内部最多 3 运营商 × 2 IP 并行）
  probeConcurrency: 4,
  // 除了要换的域名数，再多找几个健康候选，留给 pickReplacement 挑快的 / 不重复的
  spareCandidates: 2,
  // 找过一次一个健康候选都没有，这么久之内不再全量体检（期间当前目标照常每轮体检）
  noCandidateBackoffMs: 30 * 60 * 1000,
  // 每轮提前体检少量备用线路；故障时先复核最近通过的候选，避免临时扫描整份清单。
  candidateWarmTtlMs: 15 * 60 * 1000,
  candidateWarmPoolSize: 3,
  candidateWarmBatchSize: 1,
  // 避免候选源过长且大面积超时时顶满 systemd 的 5 分钟任务时限；轮换预热会继续覆盖后续候选。
  maxDueCandidatesPerHost: 8,
}
/** 外部候选列表只需几十 KB；不可先完整读入再截断，避免坏源响应耗尽定时任务内存。 */
export const MAX_CANDIDATE_LIST_BYTES = 256 * 1024

// https://www.cloudflare.com/ips-v4 （2026-11-16）
export const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]

const ipToInt = (ip) => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0

export function isIPv4(s) {
  const parts = String(s).split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export function inCloudflare(ip, ranges = CLOUDFLARE_V4) {
  if (!isIPv4(ip)) return false
  const n = ipToInt(ip)
  return ranges.some((cidr) => {
    const [base, bits] = cidr.split('/')
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0
    return (n & mask) === (ipToInt(base) & mask)
  })
}

export function isValidHostname(s) {
  const h = String(s).trim().replace(/\.$/, '')
  return h.length > 0 && h.length <= 253 && /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h) &&
    h.split('.').every((l) => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'))
}

/** 更新 DNS 前确认记录仍是本轮读到的那个 DNS-only CNAME。 */
export function dnsRecordMatches(record, { id, host, target }) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/\.$/, '')
  return Boolean(record && record.id === id && record.type === 'CNAME' &&
    normalize(record.name) === normalize(host) && record.proxied === false &&
    normalize(record.content) === normalize(target))
}

// 候选 = 列表 + 保底 + 额外 + 当前目标，去重（不区分大小写）、去掉屏蔽项和自己区域里的域名。
export function buildCandidates({ listText = '', seeds = [], extra = [], current = [], blocklist = [], ownZone = '8bitgo.com' }) {
  const blocked = new Set(blocklist.map((s) => s.toLowerCase()))
  const out = []
  const seen = new Set()
  const fromList = listText.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim())
  for (const raw of [...current, ...fromList, ...seeds, ...extra]) {
    const h = String(raw).trim().replace(/\.$/, '').toLowerCase()
    if (!h || seen.has(h) || blocked.has(h) || !isValidHostname(h)) continue
    if (h === ownZone || h.endsWith(`.${ownZone}`)) continue
    seen.add(h)
    out.push(h)
  }
  return out
}

/** 有界读取外部文本。超限时整份拒绝，避免把截断的域名误当完整候选；同时立即取消上游正文。 */
export async function readLimitedText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('文本读取上限无效')
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new RangeError(`文本响应超过 ${maxBytes} 字节上限`)
  }
  if (!response.body) throw new Error('文本响应没有可读正文')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (bytes + value.byteLength > maxBytes) throw new RangeError(`文本响应超过 ${maxBytes} 字节上限`)
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* 已释放时无需处理 */ }
  }
}

// 体检结果 → 是否健康：所有配置运营商都必须完成 ECS 解析，每个至少有一个 IP 可用。
export function judgeCandidate(result, expectedIsps = Object.keys(result.isps || {})) {
  const isps = expectedIsps.map((isp) => [isp, result.isps?.[isp] || { probes: [], nonCloudflare: [], resolutionStatus: 'error' }])
  if (isps.length === 0) return { healthy: false, hardFailure: true, reason: '没有配置运营商 DNS 探测' }
  const all = isps.flatMap(([, r]) => r.probes || [])
  const nonCf = isps.flatMap(([, r]) => r.nonCloudflare || [])
  if (nonCf.length) return { healthy: false, hardFailure: true, reason: `解析到非 Cloudflare IP：${nonCf.slice(0, 3).join(', ')}` }
  const emptyIsp = isps.find(([, r]) => r.resolutionStatus === 'empty')
  if (emptyIsp) return { healthy: false, hardFailure: true, reason: `${emptyIsp[0]} 没有 IPv4 答案` }
  const unknownIsps = isps.filter(([, r]) => r.resolutionStatus === 'error')
  if (unknownIsps.length) {
    return { healthy: false, indeterminate: true, reason: `运营商 DNS 探测不完整：${unknownIsps.map(([isp]) => isp).join(', ')}` }
  }
  if (all.length === 0) return { healthy: false, hardFailure: true, reason: '解析不到 IPv4' }
  const deadIsp = isps.find(([, r]) => (r.probes || []).length > 0 && !(r.probes || []).some((p) => p.ok))
  if (deadIsp) return { healthy: false, reason: `${deadIsp[0]} 线路的 IP 全部不通` }
  const ok = all.filter((p) => p.ok)
  if (ok.length * 2 < all.length) return { healthy: false, reason: `只有 ${ok.length}/${all.length} 个 IP 能用` }
  const times = ok.map((p) => p.ms).sort((a, b) => a - b)
  return { healthy: true, hardFailure: false, reason: `${ok.length}/${all.length} 个 IP 正常`, medianMs: times[Math.floor(times.length / 2)] }
}

// 换线选谁：健康的、不是要换掉的那个；优先没被别的托管域名占用的；再按源站测到的中位耗时（仅作平局裁决）。
export function freshRouteQuality(routeQuality, name, nowMs, qualityTtlMs, minQualityVisitors) {
  const quality = routeQuality?.[String(name).toLowerCase()]
  const at = Date.parse(quality?.observedAt || '')
  if (Number(quality?.visitors) < minQualityVisitors || !Number.isFinite(quality?.medianBytesPerMs) || quality.medianBytesPerMs <= 0 ||
    !Number.isFinite(at) || nowMs - at < 0 || nowMs - at >= qualityTtlMs) return undefined
  return quality
}

export function pickReplacement(judged, { exclude = [], inUseElsewhere = [], routeQuality = {}, nowMs = Date.now(), qualityTtlMs = 6 * 60 * 60 * 1000, minQualityVisitors = 5 } = {}) {
  const ex = new Set(exclude.map((s) => s.toLowerCase()))
  const busy = new Set(inUseElsewhere.map((s) => s.toLowerCase()))
  const pool = judged.filter((c) => c.verdict.healthy && !ex.has(c.name))
  pool.sort((a, b) => {
    const spare = busy.has(a.name) - busy.has(b.name)
    if (spare) return spare
    const ar = freshRouteQuality(routeQuality, a.name, nowMs, qualityTtlMs, minQualityVisitors)?.medianBytesPerMs
    const br = freshRouteQuality(routeQuality, b.name, nowMs, qualityTtlMs, minQualityVisitors)?.medianBytesPerMs
    if (ar && br && Math.abs(ar - br) / Math.max(ar, br) >= 0.15) return br - ar
    return a.verdict.medianMs - b.verdict.medianMs
  })
  return pool[0] || null
}

/** 跨轮候选池只保留近期验证成功的少量域名；真正切换前仍会重新体检。 */
export function freshWarmCandidates(entries, nowMs, ttlMs, limit) {
  if (!Array.isArray(entries)) return []
  const seen = new Set()
  return entries.filter((entry) => {
    const name = String(entry?.name || '').toLowerCase()
    const checkedAt = Number(entry?.checkedAt)
    if (!isValidHostname(name) || seen.has(name) || !Number.isFinite(checkedAt) ||
      checkedAt > nowMs || nowMs - checkedAt >= ttlMs) return false
    seen.add(name)
    return true
  }).sort((a, b) => Number(b.checkedAt) - Number(a.checkedAt))
    .slice(0, Math.max(0, limit))
}

/** 按清单游标轮换预热；先找未缓存项，清单耗尽后再刷新最旧项。 */
export function selectWarmBatch(names, cursor, excluded = [], cached = [], count = 1) {
  if (!names.length || count <= 0) return { names: [], cursor }
  const deny = new Set(excluded.map((name) => String(name).toLowerCase()))
  const cachedNames = new Set(cached.map((entry) => String(entry?.name || '').toLowerCase()))
  const start = (names.indexOf(cursor) + 1) % names.length
  const ordered = Array.from({ length: names.length }, (_, i) => names[(start + i) % names.length])
  const selected = []
  for (const preferNew of [true, false]) {
    for (const name of ordered) {
      if (selected.length >= count) break
      if (deny.has(name) || selected.includes(name) || cachedNames.has(name) !== !preferNew) continue
      selected.push(name)
    }
  }
  return { names: selected, cursor: selected.at(-1) || cursor }
}

/** 更新近期验证池；未知结果不抹掉旧证据，明确失败则移除。 */
export function updateWarmCandidates(entries, judged, nowMs, ttlMs, limit) {
  const pool = new Map(freshWarmCandidates(entries, nowMs, ttlMs, limit).map((entry) => [entry.name, entry]))
  for (const candidate of judged) {
    if (candidate.verdict.healthy) {
      pool.set(candidate.name, { name: candidate.name, checkedAt: nowMs, medianMs: candidate.verdict.medianMs })
    } else if (!candidate.verdict.indeterminate) {
      pool.delete(candidate.name)
    }
  }
  return [...pool.values()].sort((a, b) => Number(b.checkedAt) - Number(a.checkedAt)).slice(0, limit)
}

export function canClearNoCandidateBackoff(searchBlocked, warmedHealthy) {
  return !searchBlocked || warmedHealthy
}

export function canSwitchWithCandidate(searchBlocked, judged) {
  return !searchBlocked || judged.some((candidate) => candidate.verdict.healthy)
}

// 大陆玩家的真实回报 → good / bad / unknown。一人一票：只有失败、没有一次成功的访客才算「对他不通」。
export function judgeUserReports(stats, { minVisitors = 5, badShare = 0.6, goodShare = 0.8 } = {}) {
  const visitors = Number(stats?.visitors) || 0
  if (visitors < minVisitors) return { verdict: 'unknown', reason: `大陆回报 ${visitors} 人，不足 ${minVisitors} 人` }
  const failOnly = Number(stats.failOnlyVisitors) || 0
  const ok = Number(stats.okVisitors) || 0
  const desc = `大陆回报 ${visitors} 人：${ok} 人连上、${failOnly} 人全失败`
  const rateVisitors = Number(stats.rateVisitors) || 0
  const rate = Number(stats.medianBytesPerMs)
  const quality = rateVisitors >= minVisitors && Number.isFinite(rate) && rate > 0
    ? { medianBytesPerMs: rate, visitors: rateVisitors }
    : undefined
  if (failOnly >= visitors * badShare) return { verdict: 'bad', reason: desc, quality }
  if (ok >= visitors * goodShare) return { verdict: 'good', reason: desc, quality }
  return { verdict: 'unknown', reason: desc, quality }
}

// 源站体检 + 玩家回报 → 这一轮算不算健康。
// - 玩家说坏：不健康（这正是源站看不到的「香港通、大陆不通」）。
// - 源站说坏、玩家说好：解析到非 CF IP 这种硬伤照判不健康；其余（香港到这批 IP 的连通问题）听玩家的。
export function combineVerdicts(probeVerdict, user) {
  if (user?.verdict === 'bad') return { healthy: false, reason: `${user.reason}（源站体检：${probeVerdict.reason}）`, byUsers: true }
  if (!probeVerdict.healthy && user?.verdict === 'good' && !probeVerdict.hardFailure) {
    return { healthy: true, reason: `${user.reason}，忽略源站体检（${probeVerdict.reason}）`, byUsers: true }
  }
  return { healthy: probeVerdict.healthy, indeterminate: Boolean(probeVerdict.indeterminate), reason: probeVerdict.reason, byUsers: false }
}

// 回报从什么时候算起：目标换过（或第一次看到）就从那之后 + 宽限期，免得把旧目标的失败算到新目标头上。
export function reportSince(hostState, currentTarget, nowMs, graceMs) {
  const switchedAt = hostState?.target === currentTarget ? Date.parse(hostState?.switchedAt || '') : NaN
  return Number.isFinite(switchedAt) ? switchedAt + graceMs : nowMs + graceMs
}

// 按顺序体检候选，限并发，凑够 want 个健康的就不再开新的。以前一次把全部候选（几十个域名 × 3 运营商 × 2 IP，
// 每个 64KB）同时打出去：几百个并发 TLS 连接、二十多 MB 流量，香港小机器上整轮能占满几十秒。
export async function findHealthy(names, examine, { concurrency = 4, want = 3, stopOnIndeterminate = Infinity } = {}) {
  const judged = []
  let healthy = 0
  let indeterminate = 0
  let stopped = false
  let next = 0
  const worker = async () => {
    while (!stopped && next < names.length && healthy < want) {
      const c = await examine(names[next++])
      judged.push(c)
      if (c.verdict.healthy) healthy++
      if (c.verdict.indeterminate && ++indeterminate >= stopOnIndeterminate) stopped = true
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, names.length)) }, worker))
  return judged
}

// 同一个 CNAME 目标下只要有一个域名被玩家判坏，整个目标都算坏；否则各用各的结论。
export function targetUserVerdicts(entries) {
  const badByTarget = new Map()
  for (const e of entries) if (e.user?.verdict === 'bad' && !badByTarget.has(e.target)) badByTarget.set(e.target, e)
  const out = {}
  for (const e of entries) {
    const bad = badByTarget.get(e.target)
    out[e.host] = bad && bad.host !== e.host ? { verdict: 'bad', reason: `同一目标的 ${bad.host}：${bad.user.reason}` } : e.user
  }
  return out
}

// 失败计数：健康清零；不健康 +1；到阈值才该换。
export function nextFailureCount(prev, healthy, indeterminate = false) {
  return healthy ? 0 : indeterminate ? (Number(prev) || 0) : (Number(prev) || 0) + 1
}

// 人工改过 CNAME 时，旧目标的失败次数不能直接套到新目标上。
export function nextTargetFailureCount(hostState, target, healthy, indeterminate = false) {
  const prev = hostState?.target === target ? hostState.failures : 0
  return nextFailureCount(prev, healthy, indeterminate)
}

// ---------- 以下是有副作用的部分 ----------

export function loadConfig(env = process.env) {
  const list = (v, d) => (v === undefined ? d : v.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))
  const number = (key, raw, fallback) => {
    if (raw === undefined || String(raw).trim() === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`${key} 必须是数字`)
    return value
  }
  const cfg = {
    ...DEFAULTS,
    hosts: list(env.CNAME_OPT_HOSTS, DEFAULTS.hosts),
    probePath: env.CNAME_OPT_PROBE_PATH || DEFAULTS.probePath,
    probeBytes: number('CNAME_OPT_PROBE_BYTES', env.CNAME_OPT_PROBE_BYTES, DEFAULTS.probeBytes),
    baselineHost: env.CNAME_OPT_BASELINE_HOST || DEFAULTS.baselineHost,
    candidateListUrl: env.CNAME_OPT_LIST_URL ?? DEFAULTS.candidateListUrl,
    extraCandidates: list(env.CNAME_OPT_EXTRA, []),
    blocklist: [...DEFAULTS.blocklist, ...list(env.CNAME_OPT_BLOCKLIST, [])],
    failThreshold: number('CNAME_OPT_FAIL_THRESHOLD', env.CNAME_OPT_FAIL_THRESHOLD, DEFAULTS.failThreshold),
    reportUrl: env.CNAME_OPT_REPORT_URL ?? DEFAULTS.reportUrl,
    reportMinVisitors: number('CNAME_OPT_REPORT_MIN_VISITORS', env.CNAME_OPT_REPORT_MIN_VISITORS, DEFAULTS.reportMinVisitors),
    probeConcurrency: number('CNAME_OPT_PROBE_CONCURRENCY', env.CNAME_OPT_PROBE_CONCURRENCY, DEFAULTS.probeConcurrency),
    probeTimeoutMs: number('CNAME_OPT_PROBE_TIMEOUT_MS', env.CNAME_OPT_PROBE_TIMEOUT_MS, DEFAULTS.probeTimeoutMs),
    stateFile: env.CNAME_OPT_STATE_FILE || DEFAULTS.stateFile,
    zoneId: env.CF_ZONE_ID || '',
    token: env.CF_DNS_API_TOKEN || '',
  }
  const positiveInt = (key, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`)
  }
  if (!cfg.hosts.length || new Set(cfg.hosts).size !== cfg.hosts.length || cfg.hosts.some((h) => !isValidHostname(h))) {
    throw new Error('CNAME_OPT_HOSTS 必须是非空、无重复的有效域名列表')
  }
  if (!isValidHostname(cfg.baselineHost)) throw new Error('CNAME_OPT_BASELINE_HOST 不是有效域名')
  if (!cfg.probePath.startsWith('/') || cfg.probePath.startsWith('//')) throw new Error('CNAME_OPT_PROBE_PATH 必须是站内绝对路径')
  positiveInt('CNAME_OPT_PROBE_BYTES', cfg.probeBytes, { min: 1024, max: 1024 * 1024 })
  positiveInt('CNAME_OPT_FAIL_THRESHOLD', cfg.failThreshold, { max: 100 })
  positiveInt('CNAME_OPT_REPORT_MIN_VISITORS', cfg.reportMinVisitors, { max: 1_000_000 })
  positiveInt('CNAME_OPT_PROBE_CONCURRENCY', cfg.probeConcurrency, { max: 16 })
  positiveInt('CNAME_OPT_PROBE_TIMEOUT_MS', cfg.probeTimeoutMs, { min: 100, max: 120_000 })
  if (!Object.keys(cfg.ecsSubnets).length || Object.keys(cfg.ecsSubnets).some((isp) => !cfg.ecsSubnets[isp])) throw new Error('必须配置至少一个运营商 ECS 子网')
  if (cfg.candidateListUrl && new URL(cfg.candidateListUrl).protocol !== 'https:') throw new Error('CNAME_OPT_LIST_URL 必须使用 HTTPS')
  return cfg
}

const log = (...a) => console.log(new Date().toISOString(), ...a)

function getJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  })
}

async function resolveViaDoh(cfg, name, subnet) {
  const u = `${cfg.dohUrl}?name=${encodeURIComponent(name)}&type=1&edns_client_subnet=${encodeURIComponent(subnet)}`
  const j = await getJson(u, { headers: { accept: 'application/dns-json' } })
  if (j.Status === 3) return []
  if (j.Status !== 0) throw new Error(`DoH Status ${j.Status}`)
  return (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data)
}

export async function resolveIsps(cfg, name, resolve = resolveViaDoh) {
  const out = {}
  await Promise.all(Object.entries(cfg.ecsSubnets).map(async ([isp, subnet]) => {
    try {
      const ips = await resolve(cfg, name, subnet)
      out[isp] = { ips, status: ips.length ? 'ok' : 'empty' }
    } catch (error) {
      out[isp] = { ips: [], status: 'error', error: error.message }
    }
  }))
  return out
}

// 连指定 IP，SNI / Host 用我们的域名，取探针并核对长度与 ETag。
// 两道时限：socket 空闲（每来一个字节重置）+ 整体硬时限 —— 只有前者的话，一条每几秒吐一个字节的慢连接
// 能把整轮拖到 systemd 的 TimeoutStartSec 被杀，状态一次都存不下来。
// expectEtag === null 表示「只取 ETag」（基线用）。
function probeIp(cfg, ip, host, expectEtag) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let bytes = 0
    let settled = false
    let req = null
    const done = (ok, why, etag) => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      if (req) req.destroy()
      resolve({ ip, ok, ms: Math.round(performance.now() - t0), why, etag })
    }
    const hard = setTimeout(() => done(false, '超时'), cfg.probeTimeoutMs)
    req = https.request({
      host: ip, servername: host, port: 443, method: 'GET', path: cfg.probePath,
      headers: { host, 'user-agent': '8bitgo-cname-optimizer/2' },
      timeout: cfg.probeTimeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return done(false, `HTTP ${res.statusCode}`) }
      const etag = res.headers.etag || ''
      res.on('data', (c) => {
        bytes += c.length
        // 超长就别再读了（对方回的不是探针）
        if (bytes > cfg.probeBytes) done(false, `长度 >${cfg.probeBytes}`)
      })
      res.on('end', () => {
        if (bytes !== cfg.probeBytes) return done(false, `长度 ${bytes}`)
        if (expectEtag && etag !== expectEtag) return done(false, `ETag ${etag}`)
        done(true, undefined, etag)
      })
      res.on('error', (e) => done(false, e.code || e.message))
      res.on('aborted', () => done(false, '连接中断'))
    })
    req.on('timeout', () => done(false, '超时'))
    req.on('error', (e) => done(false, e.code || e.message))
    req.end()
  })
}

// 网络层失败（超时 / 重置）重试一次，单次抖动不算这个 IP 坏；HTTP 错误、长度 / ETag 不符不重试。
async function probeWithRetry(cfg, ip, host, expectEtag) {
  const first = await probeIp(cfg, ip, host, expectEtag)
  return first.ok || /^HTTP |^长度|^ETag/.test(first.why) ? first : probeIp(cfg, ip, host, expectEtag)
}

// 一轮里的共享缓存：同一个 IP 常被多个优选域名 / 多个运营商同时解析到（实测 172.64.79.252 出现在两个候选里），
// 每个 IP 一轮只测一次；同一个域名也只解析一次。
export function createRunContext(cfg, expectEtag, { resolve = resolveIsps, probe = probeWithRetry } = {}) {
  const probes = new Map()
  const names = new Map()
  const resolutions = new Map()
  const probeForHost = (ip, host) => {
    const key = `${host}\0${ip}`
    if (!probes.has(key)) probes.set(key, probe(cfg, ip, host, expectEtag))
    return probes.get(key)
  }
  const resolved = (name) => {
    if (!resolutions.has(name)) resolutions.set(name, resolve(cfg, name))
    return resolutions.get(name)
  }
  const examine = (name, host) => {
    if (!host) throw new Error('体检候选时必须指定实际托管域名（TLS SNI / Host）')
    const key = `${host}\0${name}`
    if (!names.has(key)) names.set(key, examineName(cfg, name, host, resolved, probeForHost))
    return names.get(key)
  }
  return { examine, probeCount: () => probes.size }
}

async function examineName(cfg, name, host, resolveName, probe) {
  const resolved = await resolveName(name)
  const isps = {}
  await Promise.all(Object.entries(cfg.ecsSubnets).map(async ([isp]) => {
    const answer = resolved[isp] || { ips: [], status: 'error' }
    const ips = answer.ips || []
    const uniq = [...new Set(ips)]
    const nonCloudflare = uniq.filter((ip) => !inCloudflare(ip))
    // 已经确定不健康（有非 CF IP）就不必再测连通性
    const sample = nonCloudflare.length ? [] : uniq.filter((ip) => inCloudflare(ip)).slice(0, cfg.ipsPerIsp)
    isps[isp] = { probes: await Promise.all(sample.map((ip) => probe(ip, host))), nonCloudflare, resolutionStatus: answer.status }
  }))
  const result = { name, isps }
  return { ...result, host, verdict: judgeCandidate(result, Object.keys(cfg.ecsSubnets)) }
}

// 基线：直连 assets 取探针，拿到 ETag 作为后面所有比对的标准。用同一个带硬时限的探测函数，
// 旧实现响应流出错时没有 error 监听，会直接把进程抛崩。
async function baseline(cfg) {
  const ips = (await dns.resolve4(cfg.baselineHost)).slice(0, 2)
  for (const ip of ips) {
    const r = await probeWithRetry(cfg, ip, cfg.baselineHost, null)
    if (r.ok && r.etag) return r.etag
  }
  throw new Error(`基线 ${cfg.baselineHost} 取不到探针`)
}

async function cfApi(cfg, method, p, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.success) throw new Error(`Cloudflare API ${method} ${p}: ${r.status} ${JSON.stringify(j.errors || j)}`)
  return j.result
}

async function readRecords(cfg) {
  const out = {}
  for (const host of cfg.hosts) {
    const recs = await cfApi(cfg, 'GET', `/zones/${cfg.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(host)}`)
    if (recs.length !== 1) throw new Error(`${host} 应恰好有一条 CNAME 记录，实际 ${recs.length} 条；为安全起见不改 DNS`)
    const [record] = recs
    const recordName = String(record.name || '').toLowerCase().replace(/\.$/, '')
    if (record.type !== 'CNAME' || recordName !== host) throw new Error(`${host} 返回了不匹配的 DNS 记录；为安全起见不改 DNS`)
    if (record.proxied !== false) throw new Error(`${host} 不是明确的 DNS-only 记录，不该由本脚本管理`)
    const target = String(record.content || '').toLowerCase().replace(/\.$/, '')
    if (!record.id || !isValidHostname(target) || target === '8bitgo.com' || target.endsWith('.8bitgo.com')) {
      throw new Error(`${host} 的 CNAME 目标无效或指回本站：${target}`)
    }
    out[host] = { id: record.id, target }
  }
  return out
}

async function readCurrentViaDns(cfg) {
  // 没配 API 令牌时（--status 场景）退回公网 DNS 读当前 CNAME。
  const out = {}
  for (const host of cfg.hosts) {
    const c = await dns.resolveCname(host).catch(() => [])
    out[host] = { id: null, target: (c[0] || '').toLowerCase() }
  }
  return out
}

async function loadState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return { hosts: {}, history: [] } }
}

async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, file)
}

// 读玩家回报：同一个 since 一轮只取一次；第一次就读不到（服务没起来）这一轮不再试，免得每个域名各等一次超时。
function createReportReader(cfg) {
  const cache = new Map()
  let down = !cfg.reportUrl
  return async (since) => {
    if (down) return null
    const key = Math.floor(since)
    if (!cache.has(key)) {
      cache.set(key, getJson(`${cfg.reportUrl}?since=${key}`, { timeoutMs: 5000 }).catch((e) => {
        down = true
        log(`[回报] 读不到玩家回报（${e.message}），本轮只看源站体检`)
        return null
      }))
    }
    return cache.get(key)
  }
}

function describe(c) {
  const parts = Object.entries(c.isps).map(([isp, r]) => `${isp}:${r.probes.map((p) => (p.ok ? `${p.ip}✓${p.ms}ms` : `${p.ip}✗${p.why}`)).join(' ') || '无'}`)
  return `${c.name} ${c.verdict.healthy ? '健康' : '不健康'}（${c.verdict.reason}） ${parts.join(' | ')}`
}

async function loadCandidateNames(cfg, records) {
  let listText = ''
  if (cfg.candidateListUrl) {
    try {
      const r = await fetch(cfg.candidateListUrl, { signal: AbortSignal.timeout(10000) })
      if (r.ok) listText = await readLimitedText(r, MAX_CANDIDATE_LIST_BYTES)
      else log(`[候选] 列表 HTTP ${r.status}，只用保底候选`)
    } catch (e) { log(`[候选] 列表拉取失败（${e.message}），只用保底候选`) }
  }
  return buildCandidates({
    listText, seeds: cfg.seedCandidates, extra: cfg.extraCandidates,
    current: cfg.hosts.map((h) => records[h].target), blocklist: cfg.blocklist,
  })
}

async function main(argv = process.argv.slice(2)) {
  const statusOnly = argv.includes('--status')
  // 全量 survey 的用途是观察候选排名；即使当前故障计数已到阈值，也不能顺手改生产 DNS。
  const dryRun = argv.includes('--dry-run') || statusOnly || argv.includes('--survey')
  const survey = argv.includes('--survey') || statusOnly
  const cfg = loadConfig()
  const canWrite = Boolean(cfg.zoneId && cfg.token)
  if (!statusOnly && !canWrite) throw new Error('缺 CF_ZONE_ID / CF_DNS_API_TOKEN（需要该区域 DNS:Edit 权限）')

  const expectEtag = await baseline(cfg)
  const records = canWrite ? await readRecords(cfg) : await readCurrentViaDns(cfg)
  const state = await loadState(cfg.stateFile)
  state.hosts ||= {}
  const run = createRunContext(cfg, expectEtag)
  const readReports = createReportReader(cfg)
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()

  // 1. 当前目标体检（同一个目标只测一次）+ 玩家回报
  const current = {}
  const users = {}
  for (const host of cfg.hosts) {
    current[host] = await run.examine(records[host].target, host)
    log(`[当前] ${host} → ${describe(current[host])}`)
    const hs = state.hosts[host] || {}
    const since = reportSince(hs, records[host].target, nowMs, cfg.reportGraceMs)
    const reports = since < nowMs ? await readReports(since) : null
    const user = reports
      ? judgeUserReports(reports.hosts?.[host], { minVisitors: cfg.reportMinVisitors, badShare: cfg.reportBadShare, goodShare: cfg.reportGoodShare })
      : { verdict: 'unknown', reason: since >= nowMs ? '目标刚生效，等宽限期过了再看大陆回报' : '没有大陆回报' }
    users[host] = user
  }
  const routeQuality = Object.fromEntries(Object.entries(state.routeQuality || {}).filter(([name, quality]) => {
    const at = Date.parse(quality?.observedAt || '')
    return isValidHostname(name) && Number(quality?.visitors) >= cfg.reportQualityMinVisitors &&
      Number.isFinite(quality?.medianBytesPerMs) && quality.medianBytesPerMs > 0 &&
      Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < cfg.reportQualityTtlMs
  }))
  for (const host of cfg.hosts) {
    const quality = users[host].quality
    if (!quality) continue
    const name = records[host].target
    const previous = routeQuality[name]
    if (!previous || quality.visitors >= previous.visitors) {
      routeQuality[name] = { ...quality, observedAt: now }
    }
  }
  state.routeQuality = Object.fromEntries(Object.entries(routeQuality)
    .sort((a, b) => Date.parse(b[1].observedAt) - Date.parse(a[1].observedAt)).slice(0, 100))
  // 玩家回报是按「我们的域名」收的，坏的却是「CNAME 目标」：两个域名指向同一个目标时，
  // 一个被大陆玩家判坏，另一个也一样坏（只是用的人少、凑不够票）。
  const userByTarget = targetUserVerdicts(cfg.hosts.map((h) => ({ host: h, target: records[h].target, user: users[h] })))
  const combined = {}
  for (const host of cfg.hosts) {
    const user = userByTarget[host]
    combined[host] = combineVerdicts(current[host].verdict, user)
    const quality = freshRouteQuality(routeQuality, records[host].target, nowMs, cfg.reportQualityTtlMs, cfg.reportQualityMinVisitors)
    const rateText = quality ? `；大陆实测中位吞吐约 ${(quality.medianBytesPerMs * 0.008).toFixed(2)} Mbps / ${quality.visitors} 人` : ''
    log(`[回报] ${host} → ${user.reason}${rateText}；本轮判定：${combined[host].healthy ? '健康' : '不健康'}`)
  }

  // 被玩家判坏过、还在冷却期的目标不再选回来
  const userBad = Object.fromEntries(Object.entries(state.userBad || {}).filter(([, until]) => Date.parse(until) > nowMs))
  state.userBad = userBad

  // 2. 要不要找替换候选：只有这一轮就会到阈值的域名才值得（以前第一次不健康就把全部候选测一遍，
  //    而换线要等第三次 —— 前两轮的几百个连接全白测）。找过一次一个健康的都没有，冷却一段时间再找。
  const failures = Object.fromEntries(cfg.hosts.map((h) => [h, nextTargetFailureCount(
    state.hosts[h], records[h].target, combined[h].healthy, combined[h].indeterminate,
  )]))
  const due = cfg.hosts.filter((h) => failures[h] >= cfg.failThreshold && !combined[h].indeterminate)
  const searchBlocked = !survey && Date.parse(state.noCandidateUntil || '') > nowMs
  const judgedByHost = {}
  const shouldWarm = !dryRun && !survey
  const shouldSearchDue = due.length > 0 && !searchBlocked
  const allNames = survey || shouldWarm || shouldSearchDue ? await loadCandidateNames(cfg, records) : []
  let warmedHealthy = false
  if (!survey) state.candidateWarm ||= {}

  // 每轮只轮换预热少量新候选，故障时优先复测这批已验证过的目标，避免临时扫描整份清单。
  // 预热结果会过期；真正写 DNS 前仍必须用当前三网答案重新验证。
  if (shouldWarm && allNames.length) {
    state.candidateWarm ||= {}
    state.candidateWarmCursor ||= {}
    for (const host of cfg.hosts) {
      const warm = freshWarmCandidates(state.candidateWarm[host], nowMs, cfg.candidateWarmTtlMs, cfg.candidateWarmPoolSize)
      const excluded = [records[host].target, ...Object.keys(userBad)]
      const batch = selectWarmBatch(allNames, state.candidateWarmCursor[host], excluded, warm, cfg.candidateWarmBatchSize)
      state.candidateWarmCursor[host] = batch.cursor
      if (!batch.names.length) continue
      const judged = await findHealthy(batch.names, (name) => run.examine(name, host), {
        concurrency: 1, want: Infinity,
      })
      state.candidateWarm[host] = updateWarmCandidates(warm, judged, nowMs, cfg.candidateWarmTtlMs, cfg.candidateWarmPoolSize)
      if (judged.some((candidate) => candidate.verdict.healthy)) warmedHealthy = true
      log(`[预热] ${host}：体检 ${judged.length} 个候选，${judged.filter((candidate) => candidate.verdict.healthy).length} 个健康`)
    }
  }

  if (survey || due.length) {
    for (const host of (survey ? cfg.hosts : due)) {
      const excluded = new Set([...(survey ? [] : [records[host].target]), ...Object.keys(userBad)])
      const names = allNames.filter((name) => survey || !excluded.has(name))
      if (!survey) {
        const elsewhere = cfg.hosts.filter((other) => other !== host).map((other) => records[other].target)
        const warm = freshWarmCandidates(state.candidateWarm?.[host], nowMs, cfg.candidateWarmTtlMs, cfg.candidateWarmPoolSize)
          .filter((entry) => !excluded.has(entry.name))
          .sort((a, b) => (elsewhere.includes(a.name) - elsewhere.includes(b.name)) || (Number(a.medianMs) - Number(b.medianMs)))
        const warmJudged = await findHealthy(warm.map((entry) => entry.name), (name) => run.examine(name, host), {
          concurrency: 1, want: 1, stopOnIndeterminate: 1,
        })
        judgedByHost[host] = warmJudged
        if (warmJudged.length) {
          state.candidateWarm[host] = updateWarmCandidates(warm, warmJudged, nowMs, cfg.candidateWarmTtlMs, cfg.candidateWarmPoolSize)
        }
        const warmPick = pickReplacement(warmJudged, { exclude: [records[host].target, ...Object.keys(userBad)], inUseElsewhere: elsewhere })
        if (warmPick) {
          judgedByHost[host] = warmJudged
          warmedHealthy = true
          log(`[候选] ${host}：最近预热目标复测通过，直接作为本轮替换候选`)
          continue
        }
        if (searchBlocked) {
          log(`[候选] ${host}：无近期预热目标可用，保留至 ${state.noCandidateUntil} 的全量扫描冷却`)
          continue
        }
      }
      const alreadyChecked = new Set((judgedByHost[host] || []).map((candidate) => candidate.name))
      let searchNames = survey ? names : names.filter((name) => !alreadyChecked.has(name))
      if (!survey && searchNames.length > cfg.maxDueCandidatesPerHost) {
        const batch = selectWarmBatch(
          searchNames, state.candidateWarmCursor?.[host], [],
          freshWarmCandidates(state.candidateWarm?.[host], nowMs, cfg.candidateWarmTtlMs, cfg.candidateWarmPoolSize),
          cfg.maxDueCandidatesPerHost,
        )
        searchNames = batch.names
        state.candidateWarmCursor ||= {}
        state.candidateWarmCursor[host] = batch.cursor
      }
      const judged = await findHealthy(searchNames, (name) => run.examine(name, host), {
        concurrency: cfg.probeConcurrency,
        want: survey ? Infinity : 1 + cfg.spareCandidates,
        stopOnIndeterminate: survey ? Infinity : 3,
      })
      judgedByHost[host] = [...(judgedByHost[host] || []), ...judged]
      if (!survey) {
        state.candidateWarm[host] = updateWarmCandidates(state.candidateWarm?.[host], judged, nowMs, cfg.candidateWarmTtlMs, cfg.candidateWarmPoolSize)
        if (judged.some((candidate) => candidate.verdict.healthy)) warmedHealthy = true
      }
      log(`[候选] ${host}：体检了 ${judged.length}/${searchNames.length} 个候选，${judged.filter((c) => c.verdict.healthy).length} 个健康`)
      if (survey) {
        for (const c of [...judged].sort((a, b) => (b.verdict.healthy - a.verdict.healthy) || ((a.verdict.medianMs ?? 1e9) - (b.verdict.medianMs ?? 1e9)))) log(`[候选] ${describe(c)}`)
      }
    }
    log(`[候选] 本轮共探测 ${run.probeCount()} 个「域名 + IP」线路组合`)
  } else if (due.length && searchBlocked) {
    log(`[候选] 上次没找到健康候选，${state.noCandidateUntil} 之前只尝试预热池`)
  }
  if (statusOnly) return

  // 3. 记账 + 换线。每个域名单独 try：一个改 DNS 失败不能让另一个的计数和整份状态都丢掉。
  let noCandidate = false
  for (const host of cfg.hosts) {
    const hs = state.hosts[host] || {}
    state.hosts[host] = hs
    if (hs.target !== records[host].target || !hs.switchedAt) hs.switchedAt = now
    hs.target = records[host].target
    hs.failures = failures[host]
    hs.lastCheck = now
    hs.lastVerdict = combined[host].reason
    if (combined[host].healthy || hs.failures < cfg.failThreshold) {
      if (!combined[host].healthy) log(`[判定] ${host} 第 ${hs.failures}/${cfg.failThreshold} 次不健康，暂不换线`)
      continue
    }
    if (!canSwitchWithCandidate(searchBlocked, judgedByHost[host] || [])) continue
    const inUseElsewhere = cfg.hosts.filter((h) => h !== host).map((h) => records[h].target)
    const pick = pickReplacement(judgedByHost[host] || [], {
      exclude: [records[host].target, ...Object.keys(userBad)], inUseElsewhere,
      routeQuality: state.routeQuality, nowMs,
      qualityTtlMs: cfg.reportQualityTtlMs, minQualityVisitors: cfg.reportQualityMinVisitors,
    })
    if (!pick) {
      if (!(judgedByHost[host] || []).some((c) => c.verdict.indeterminate)) noCandidate = true
      log(`[判定] ${host} 连续 ${hs.failures} 次不健康，但没有健康的候选，保持不动`)
      continue
    }
    const pickedQuality = freshRouteQuality(state.routeQuality, pick.name, nowMs, cfg.reportQualityTtlMs, cfg.reportQualityMinVisitors)
    const pickedRate = pickedQuality ? `，大陆实测 ${(pickedQuality.medianBytesPerMs * 0.008).toFixed(2)} Mbps / ${pickedQuality.visitors} 人` : ''
    log(`[换线] ${host}: ${records[host].target} → ${pick.name}（${pick.verdict.reason}，源站中位 ${pick.verdict.medianMs}ms${pickedRate}）${dryRun ? '［dry-run，未改 DNS］' : ''}`)
    if (dryRun) continue
    try {
      const recordPath = `/zones/${cfg.zoneId}/dns_records/${records[host].id}`
      const latest = await cfApi(cfg, 'GET', recordPath)
      if (!dnsRecordMatches(latest, { ...records[host], host })) {
        const latestTarget = String(latest?.content || '').toLowerCase().replace(/\.$/, '')
        log(`[跳过] ${host} 的 DNS 记录在体检期间已变化（当前 ${latestTarget || '记录无效'}），不覆盖人工或其他任务的修改`)
        if (isValidHostname(latestTarget) && latestTarget !== '8bitgo.com' && !latestTarget.endsWith('.8bitgo.com')) {
          records[host].target = latestTarget
          hs.target = latestTarget
          hs.switchedAt = now
          hs.failures = 0
        }
        hs.lastCheck = now
        hs.lastVerdict = 'DNS 记录在体检期间已变化，跳过自动换线'
        continue
      }
      const updated = await cfApi(cfg, 'PATCH', recordPath, {
        content: pick.name,
        // 免费套餐 DNS 记录备注上限 100 字符，超了整个 PATCH 会被拒
        comment: `优选CNAME 自动切换 ${now.slice(0, 16)} 原${records[host].target}`.slice(0, 100),
      })
      if (!dnsRecordMatches(updated, { ...records[host], host, target: pick.name })) {
        throw new Error('Cloudflare API 未确认目标已更新；下轮会重新读取记录，不信任本地旧状态')
      }
    } catch (e) {
      log(`[错误] ${host} 改 DNS 失败：${e.message}`)
      process.exitCode = 1
      continue
    }
    state.history = [...(state.history || []), { at: now, host, from: records[host].target, to: pick.name, reason: combined[host].reason }].slice(-50)
    if (combined[host].byUsers) userBad[records[host].target] = new Date(nowMs + cfg.userBadTtlMs).toISOString()
    records[host].target = pick.name
    hs.target = pick.name
    hs.switchedAt = now
    hs.failures = 0
  }
  // dry-run 不落状态：否则手动试跑一次就给定时器的失败计数 +1，可能让它提前换线
  if (dryRun) return
  if (noCandidate) state.noCandidateUntil = new Date(nowMs + cfg.noCandidateBackoffMs).toISOString()
  else if (canClearNoCandidateBackoff(searchBlocked, warmedHealthy)) delete state.noCandidateUntil
  await saveState(cfg.stateFile, state)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { log('[错误]', e.message); process.exitCode = 1 })
}
