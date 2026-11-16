#!/usr/bin/env node
// 8BitGo 优选 CNAME 自动维护：download.8bitgo.com / rom.8bitgo.com 是 DNS-only CNAME 到第三方
// Cloudflare 优选域名（BestCF 汇总的那批）。这些域名是别人的，随时可能失效、改指向或不再指向 Cloudflare。
// 这个脚本定时体检当前目标，连续失败才换成另一个健康的优选域名，然后改 Cloudflare DNS 记录。
//
// 为什么这样判：
// - 解析走 AliDNS DoH 并带大陆三网的 ECS 子网：优选域名是按运营商分线解析的，源站（香港）直接解析
//   拿到的是海外答案，体检就测错了对象。DoH 失败才退回本机解析。
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
//   --survey  不管当前是否健康，都把全部候选体检一遍并打印排名
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
  stateFile: '/var/lib/8bitgo/cname-optimizer.json',
}

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

// 体检结果 → 是否健康：每个解析出 IP 的运营商都至少有一个 IP 能用、整体成功率不低于一半、且没有非 CF IP。
export function judgeCandidate(result) {
  const isps = Object.entries(result.isps || {})
  if (isps.length === 0) return { healthy: false, reason: '解析不到 IPv4' }
  const all = isps.flatMap(([, r]) => r.probes || [])
  const nonCf = isps.flatMap(([, r]) => r.nonCloudflare || [])
  if (nonCf.length) return { healthy: false, reason: `解析到非 Cloudflare IP：${nonCf.slice(0, 3).join(', ')}` }
  if (all.length === 0) return { healthy: false, reason: '没有可测的 IP' }
  const deadIsp = isps.find(([, r]) => (r.probes || []).length > 0 && !(r.probes || []).some((p) => p.ok))
  if (deadIsp) return { healthy: false, reason: `${deadIsp[0]} 线路的 IP 全部不通` }
  const ok = all.filter((p) => p.ok)
  if (ok.length * 2 < all.length) return { healthy: false, reason: `只有 ${ok.length}/${all.length} 个 IP 能用` }
  const times = ok.map((p) => p.ms).sort((a, b) => a - b)
  return { healthy: true, reason: `${ok.length}/${all.length} 个 IP 正常`, medianMs: times[Math.floor(times.length / 2)] }
}

// 换线选谁：健康的、不是要换掉的那个；优先没被别的托管域名占用的；再按源站测到的中位耗时（仅作平局裁决）。
export function pickReplacement(judged, { exclude = [], inUseElsewhere = [] } = {}) {
  const ex = new Set(exclude.map((s) => s.toLowerCase()))
  const busy = new Set(inUseElsewhere.map((s) => s.toLowerCase()))
  const pool = judged.filter((c) => c.verdict.healthy && !ex.has(c.name))
  pool.sort((a, b) => (busy.has(a.name) - busy.has(b.name)) || (a.verdict.medianMs - b.verdict.medianMs))
  return pool[0] || null
}

// 失败计数：健康清零；不健康 +1；到阈值才该换。
export function nextFailureCount(prev, healthy) {
  return healthy ? 0 : (Number(prev) || 0) + 1
}

// ---------- 以下是有副作用的部分 ----------

function loadConfig(env = process.env) {
  const list = (v, d) => (v ? v.split(/[\s,]+/).filter(Boolean) : d)
  return {
    ...DEFAULTS,
    hosts: list(env.CNAME_OPT_HOSTS, DEFAULTS.hosts),
    probePath: env.CNAME_OPT_PROBE_PATH || DEFAULTS.probePath,
    probeBytes: Number(env.CNAME_OPT_PROBE_BYTES) || DEFAULTS.probeBytes,
    baselineHost: env.CNAME_OPT_BASELINE_HOST || DEFAULTS.baselineHost,
    candidateListUrl: env.CNAME_OPT_LIST_URL ?? DEFAULTS.candidateListUrl,
    extraCandidates: list(env.CNAME_OPT_EXTRA, []),
    blocklist: [...DEFAULTS.blocklist, ...list(env.CNAME_OPT_BLOCKLIST, [])],
    failThreshold: Number(env.CNAME_OPT_FAIL_THRESHOLD) || DEFAULTS.failThreshold,
    stateFile: env.CNAME_OPT_STATE_FILE || DEFAULTS.stateFile,
    zoneId: env.CF_ZONE_ID || '',
    token: env.CF_DNS_API_TOKEN || '',
  }
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
  if (j.Status !== 0) throw new Error(`DoH Status ${j.Status}`)
  return (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data)
}

async function resolveIsps(cfg, name) {
  const out = {}
  await Promise.all(Object.entries(cfg.ecsSubnets).map(async ([isp, subnet]) => {
    try { out[isp] = await resolveViaDoh(cfg, name, subnet) } catch { out[isp] = null }
  }))
  if (Object.values(out).every((v) => v === null)) {
    const ips = await dns.resolve4(name).catch(() => [])
    return ips.length ? { local: ips } : {}
  }
  for (const k of Object.keys(out)) if (!out[k] || out[k].length === 0) delete out[k]
  return out
}

// 连指定 IP，SNI / Host 用我们的域名，取探针并核对长度与 ETag。
function probeIp(cfg, ip, host, expectEtag) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let bytes = 0
    const done = (ok, why) => resolve({ ip, ok, ms: Math.round(performance.now() - t0), why })
    const req = https.request({
      host: ip, servername: host, port: 443, method: 'GET', path: cfg.probePath,
      headers: { host, 'user-agent': '8bitgo-cname-optimizer/1', 'cache-control': 'no-cache' },
      timeout: cfg.probeTimeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return done(false, `HTTP ${res.statusCode}`) }
      const etag = res.headers.etag
      res.on('data', (c) => { bytes += c.length })
      res.on('end', () => {
        if (bytes !== cfg.probeBytes) return done(false, `长度 ${bytes}`)
        if (expectEtag && etag !== expectEtag) return done(false, `ETag ${etag}`)
        done(true)
      })
      res.on('error', (e) => done(false, e.code || e.message))
    })
    req.on('timeout', () => req.destroy(new Error('超时')))
    req.on('error', (e) => done(false, e.code || e.message))
    req.end()
  })
}

async function examine(cfg, name, host, expectEtag) {
  const resolved = await resolveIsps(cfg, name)
  const isps = {}
  await Promise.all(Object.entries(resolved).map(async ([isp, ips]) => {
    const uniq = [...new Set(ips)]
    const nonCloudflare = uniq.filter((ip) => !inCloudflare(ip))
    const sample = uniq.filter((ip) => inCloudflare(ip)).slice(0, cfg.ipsPerIsp)
    // 网络层失败（超时 / 重置）重试一次，单次抖动不算这个 IP 坏；HTTP 错误、长度 / ETag 不符不重试。
    const probes = await Promise.all(sample.map(async (ip) => {
      const first = await probeIp(cfg, ip, host, expectEtag)
      return first.ok || /^HTTP |^长度|^ETag/.test(first.why) ? first : probeIp(cfg, ip, host, expectEtag)
    }))
    isps[isp] = { probes, nonCloudflare }
  }))
  const result = { name, isps }
  return { ...result, verdict: judgeCandidate(result) }
}

async function baseline(cfg) {
  const ips = await dns.resolve4(cfg.baselineHost)
  for (const ip of ips.slice(0, 2)) {
    const etag = await new Promise((resolve) => {
      const req = https.request({ host: ip, servername: cfg.baselineHost, path: cfg.probePath, headers: { host: cfg.baselineHost }, timeout: cfg.probeTimeoutMs }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode === 200 ? res.headers.etag || '' : null))
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => resolve(null))
      req.end()
    })
    if (etag !== null) return etag
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
    if (!recs.length) throw new Error(`${host} 没有 CNAME 记录`)
    if (recs[0].proxied) throw new Error(`${host} 是代理（橙云）记录，不该由本脚本管理`)
    out[host] = { id: recs[0].id, target: recs[0].content.toLowerCase().replace(/\.$/, '') }
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

function describe(c) {
  const parts = Object.entries(c.isps).map(([isp, r]) => `${isp}:${r.probes.map((p) => (p.ok ? `${p.ip}✓${p.ms}ms` : `${p.ip}✗${p.why}`)).join(' ') || '无'}`)
  return `${c.name} ${c.verdict.healthy ? '健康' : '不健康'}（${c.verdict.reason}） ${parts.join(' | ')}`
}

async function main(argv = process.argv.slice(2)) {
  const statusOnly = argv.includes('--status')
  const dryRun = argv.includes('--dry-run') || statusOnly
  const survey = argv.includes('--survey') || statusOnly
  const cfg = loadConfig()
  const canWrite = Boolean(cfg.zoneId && cfg.token)
  if (!statusOnly && !canWrite) throw new Error('缺 CF_ZONE_ID / CF_DNS_API_TOKEN（需要该区域 DNS:Edit 权限）')

  const expectEtag = await baseline(cfg)
  const records = canWrite ? await readRecords(cfg) : await readCurrentViaDns(cfg)
  const state = await loadState(cfg.stateFile)
  const probeHost = cfg.hosts[0]

  // 各域名的当前目标先体检（同一个目标只测一次）。
  const cache = new Map()
  const check = async (name) => {
    if (!cache.has(name)) cache.set(name, examine(cfg, name, probeHost, expectEtag))
    return cache.get(name)
  }
  const current = {}
  for (const host of cfg.hosts) current[host] = await check(records[host].target)
  for (const host of cfg.hosts) log(`[当前] ${host} → ${describe(current[host])}`)

  const failing = cfg.hosts.filter((h) => !current[h].verdict.healthy)
  let judged = []
  if (survey || failing.length) {
    let listText = ''
    if (cfg.candidateListUrl) {
      try {
        const r = await fetch(cfg.candidateListUrl, { signal: AbortSignal.timeout(10000) })
        if (r.ok) listText = await r.text()
        else log(`[候选] 列表 HTTP ${r.status}，只用保底候选`)
      } catch (e) { log(`[候选] 列表拉取失败（${e.message}），只用保底候选`) }
    }
    const names = buildCandidates({
      listText, seeds: cfg.seedCandidates, extra: cfg.extraCandidates,
      current: cfg.hosts.map((h) => records[h].target), blocklist: cfg.blocklist,
    })
    judged = await Promise.all(names.map(check))
    if (survey) {
      for (const c of [...judged].sort((a, b) => (b.verdict.healthy - a.verdict.healthy) || ((a.verdict.medianMs ?? 1e9) - (b.verdict.medianMs ?? 1e9)))) log(`[候选] ${describe(c)}`)
    }
  }
  if (statusOnly) return

  const now = new Date().toISOString()
  for (const host of cfg.hosts) {
    const hs = state.hosts[host] || {}
    const healthy = current[host].verdict.healthy
    hs.target = records[host].target
    hs.failures = nextFailureCount(hs.failures, healthy)
    hs.lastCheck = now
    hs.lastVerdict = current[host].verdict.reason
    state.hosts[host] = hs
    if (healthy || hs.failures < cfg.failThreshold) {
      if (!healthy) log(`[判定] ${host} 第 ${hs.failures}/${cfg.failThreshold} 次不健康，暂不换线`)
      continue
    }
    const inUseElsewhere = cfg.hosts.filter((h) => h !== host).map((h) => records[h].target)
    const pick = pickReplacement(judged, { exclude: [records[host].target], inUseElsewhere })
    if (!pick) { log(`[判定] ${host} 连续 ${hs.failures} 次不健康，但没有健康的候选，保持不动`); continue }
    log(`[换线] ${host}: ${records[host].target} → ${pick.name}（${pick.verdict.reason}，源站中位 ${pick.verdict.medianMs}ms）${dryRun ? '［dry-run，未改 DNS］' : ''}`)
    if (!dryRun) {
      await cfApi(cfg, 'PATCH', `/zones/${cfg.zoneId}/dns_records/${records[host].id}`, {
        content: pick.name,
        comment: `优选 CNAME，由 8bitgo-cname-optimizer 于 ${now} 自动切换（原 ${records[host].target}：${current[host].verdict.reason}）`,
      })
      state.history = [...(state.history || []), { at: now, host, from: records[host].target, to: pick.name, reason: current[host].verdict.reason }].slice(-50)
      records[host].target = pick.name
      hs.target = pick.name
      hs.failures = 0
    }
  }
  await saveState(cfg.stateFile, state)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { log('[错误]', e.message); process.exitCode = 1 })
}
