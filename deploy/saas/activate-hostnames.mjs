#!/usr/bin/env node
/**
 * NS 迁出 Cloudflare 后，自动激活 SaaS 区域 8bitgo.top 上的 8bitgo.com 自定义主机名。
 *
 * 为什么必须自动盯着（README「迁移当天的顺序」）：
 *   改完 NS，Cloudflare 要过一段时间才发现，把 8bitgo.com 区域从 active 改成 moved。在那之前旧区域照常服务，不断站；
 *   一旦变成 moved，访问就交给 8bitgo.top 的自定义主机名 —— 而它们一直是 pending。Cloudflare 对 pending 主机名的
 *   复查按退避节奏在 7 天里分散重试，越往后间隔越长，迁移时可能要等几个小时才轮到下一次，这段时间海外访客打不开。
 *   对主机名发一次 PATCH（带与原请求一致的 ssl 对象）会立刻重新验证、并重置退避计时。所以这个脚本做三件事：
 *     1. 每分钟查一次 8bitgo.com 区域状态，还是 active 就继续等（旧区域在服务，没事）；
 *     2. 一旦不是 active（moved / 被删 / 查不到），立刻对每个还没 active 的主机名发 PATCH，之后每 2 分钟补一次，直到全部 active；
 *     3. 全部 active 后逐个请求 https://<主机名>/，确认响应带 X-8bitgo-Via: saas（8bitgo.top 上的标记规则）。
 *
 * 用法（建议迁 NS 前就在生产机或本机终端里开着，迁完它自己接手）：
 *   CLOUDFLARE_API_TOKEN=<令牌> node deploy/saas/activate-hostnames.mjs
 *   … --dry-run        只打印要发的 PATCH，不发
 *   … --now            不等区域变 moved，立刻开始激活（例如你已经手动删掉了 8bitgo.com 区域）
 *   … --once           只检查 / 激活一轮就退出（排查用）
 *   … --no-probe       跳过最后的 HTTPS 核对（本机到 Cloudflare 很慢时）
 *   … --notify         关键节点发飞书（复用 server/scripts/notify-lark.mjs，没配 webhook 就静默）
 *   … --hosts a,b      只处理这些主机名（默认 9 个正式主机名）
 * 令牌需要：8bitgo.com 区域 Zone Read；8bitgo.top 区域 Zone Read + SSL and Certificates Edit。
 * 退出码：0 = 全部 active（且核对通过或跳过）；1 = 超时 / 出错；2 = 参数或令牌问题。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ZONE_COM = '8b681704ebdc7249aec1b9d18669a78f' // 8bitgo.com（NS 迁走前）
export const ZONE_TOP = '513afef951fc4989dfcff6f741d96fc9' // 8bitgo.top（SaaS 区域）
export const DEFAULT_HOSTS = [
  '8bitgo.com',
  'www.8bitgo.com',
  'tv.8bitgo.com',
  'assets.8bitgo.com',
  'image.8bitgo.com',
  'rom.8bitgo.com',
  'download.8bitgo.com',
  'roms.8bitgo.com',
  'html5.8bitgo.com',
]
const API = 'https://api.cloudflare.com/client/v4'

/**
 * 8bitgo.com 区域现在还在服务吗。
 * 只有明确拿到 status=active 才算还在；moved / deleted / 404（区域已删）都算交出去了。
 * 网络错误、5xx、令牌错误返回 null（不知道），调用方继续等，不能凭一次失败就开始动主机名。
 */
export async function zoneStillServing(api) {
  const res = await api('GET', `/zones/${ZONE_COM}`)
  if (res.httpStatus === 404) return false
  if (!res.success) return null
  return res.result?.status === 'active'
}

/**
 * PATCH 的请求体：文档要求带「与原请求一致」的 ssl 对象，否则可能改掉验证方式或证书设置。
 * 从当前主机名读出来原样回填，只带会影响签发的几项。
 */
export function revalidateBody(hostname) {
  const ssl = hostname?.ssl || {}
  const out = { ssl: {} }
  for (const key of ['method', 'type', 'settings', 'bundle_method', 'wildcard', 'certificate_authority']) {
    if (ssl[key] !== undefined && ssl[key] !== null) out.ssl[key] = ssl[key]
  }
  return out
}

/** 一轮：列出主机名，对没 active 的发 PATCH（同一个主机名至少隔 minGapMs 才再发）。返回各主机名状态 */
export async function activateRound(api, { hosts, lastPatched, minGapMs, now, dryRun, log }) {
  const res = await api('GET', `/zones/${ZONE_TOP}/custom_hostnames?per_page=100`)
  if (!res.success) throw new Error(`列主机名失败：${JSON.stringify(res.errors)}`)
  const byName = new Map((res.result || []).map((h) => [h.hostname, h]))
  const states = []
  for (const name of hosts) {
    const h = byName.get(name)
    if (!h) {
      states.push({ name, status: 'missing' })
      continue
    }
    const status = h.status
    states.push({ name, status, ssl: h.ssl?.status, errors: h.verification_errors || [] })
    if (status === 'active') continue
    const last = lastPatched.get(name) || 0
    if (now - last < minGapMs) continue
    lastPatched.set(name, now)
    if (dryRun) {
      log(`  [dry-run] PATCH ${name} ${JSON.stringify(revalidateBody(h))}`)
      continue
    }
    const patched = await api('PATCH', `/zones/${ZONE_TOP}/custom_hostnames/${h.id}`, revalidateBody(h))
    log(`  PATCH ${name} → ${patched.success ? 'ok' : JSON.stringify(patched.errors)}`)
  }
  return states
}

/** 核对：请求首页，看响应是不是经 SaaS 区域（X-8bitgo-Via: saas）。404 也算通过 —— 只看走没走对区域 */
export async function probeVia(fetchImpl, host, timeoutMs = 20_000) {
  try {
    const res = await fetchImpl(`https://${host}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    res.body?.cancel?.()
    return { host, status: res.status, via: res.headers.get('x-8bitgo-via') || '' }
  } catch (e) {
    return { host, status: 0, via: '', error: String(e?.message || e) }
  }
}

export function makeApi(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    try {
      const res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      })
      const data = await res.json().catch(() => ({}))
      return { ...data, success: res.ok && data.success !== false, httpStatus: res.status }
    } catch (e) {
      return { success: false, httpStatus: 0, errors: [{ message: String(e?.message || e) }] }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const args = process.argv.slice(2)
  const has = (f) => args.includes(f)
  const opt = (f) => {
    const i = args.indexOf(f)
    return i >= 0 ? args[i + 1] : undefined
  }
  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim()
  if (!token) {
    console.error('需要环境变量 CLOUDFLARE_API_TOKEN')
    process.exit(2)
  }
  const hosts = opt('--hosts') ? opt('--hosts').split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_HOSTS
  const dryRun = has('--dry-run')
  const once = has('--once')
  const pollMs = Number(process.env.ACTIVATE_POLL_MS || 60_000)
  const patchGapMs = Number(process.env.ACTIVATE_PATCH_GAP_MS || 120_000)
  const timeoutMs = Number(process.env.ACTIVATE_TIMEOUT_MS || 6 * 3600_000)
  const api = makeApi(token)
  const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`)
  const notifyScript = join(dirname(fileURLToPath(import.meta.url)), '../../server/scripts/notify-lark.mjs')
  const notify = (title, text) => {
    if (!has('--notify') || !existsSync(notifyScript)) return
    spawnSync(process.execPath, [notifyScript, '--title', title, '--text', text], { stdio: 'ignore', timeout: 20_000 })
  }

  // 令牌自检：两个区域都要读得到、还要能读自定义主机名，否则一开始就说清楚，不要等到切换当天才发现
  for (const [name, zone] of [['8bitgo.com', ZONE_COM], ['8bitgo.top', ZONE_TOP]]) {
    const r = await api('GET', `/zones/${zone}`)
    if (!r.success && !(name === '8bitgo.com' && r.httpStatus === 404)) {
      console.error(`令牌读不到 ${name} 区域：${JSON.stringify(r.errors)}`)
      process.exit(2)
    }
  }
  const probeList = await api('GET', `/zones/${ZONE_TOP}/custom_hostnames?per_page=1`)
  if (!probeList.success) {
    console.error(`令牌读不到 8bitgo.top 的自定义主机名（需要 SSL and Certificates 权限，激活还要 Edit）：${JSON.stringify(probeList.errors)}`)
    process.exit(2)
  }

  // 第一阶段：等旧区域交出去
  if (!has('--now')) {
    log('等待 8bitgo.com 区域变成 moved（旧区域 active 期间照常服务，不会断站）…')
    let lastBeat = 0
    for (;;) {
      const serving = await zoneStillServing(api)
      if (serving === false) break
      if (once) {
        log(serving === null ? '查不到区域状态（网络或令牌），这一轮不动主机名' : '区域仍 active，这一轮不动主机名')
        process.exit(0)
      }
      if (Date.now() - lastBeat > 10 * 60_000) {
        lastBeat = Date.now()
        log(serving === null ? '暂时查不到区域状态，继续等' : '区域仍 active，继续等')
      }
      await sleep(pollMs)
    }
    log('8bitgo.com 区域已不再 active：开始激活自定义主机名')
    notify('SaaS 切换开始', '8bitgo.com 区域已变成 moved，正在激活 8bitgo.top 上的自定义主机名')
  }

  // 第二阶段：反复 PATCH 直到全部 active
  const started = Date.now()
  const lastPatched = new Map()
  let states = []
  for (;;) {
    let failed = false
    try {
      states = await activateRound(api, { hosts, lastPatched, minGapMs: patchGapMs, now: Date.now(), dryRun, log })
    } catch (e) {
      failed = true
      log(`本轮出错：${e?.message || e}`)
    }
    const pending = states.filter((s) => s.status !== 'active')
    if (!failed) log(`active ${states.length - pending.length}/${hosts.length}` + (pending.length ? `；未就绪：${pending.map((s) => `${s.name}(${s.status}${s.errors?.length ? `: ${s.errors[0]}` : ''})`).join('，')}` : ''))
    if (!failed && !pending.length && states.length) break
    // 这一轮出错（例如令牌没有 SSL and Certificates 权限）不能当成功：--once / --dry-run 以 1 退出
    if (once || dryRun) process.exit(failed || pending.length ? 1 : 0)
    if (Date.now() - started > timeoutMs) {
      notify('SaaS 切换超时', `仍未激活：${pending.map((s) => s.name).join(', ')}`)
      log('超时：仍有主机名没激活，请到 8bitgo.top 的自定义主机名页面看验证错误')
      process.exit(1)
    }
    await sleep(Math.min(pollMs, patchGapMs))
  }

  // 第三阶段：确认真的走了 SaaS 区域
  if (has('--no-probe')) {
    log('全部 active（跳过 HTTPS 核对）')
    notify('SaaS 切换完成', '9 个自定义主机名全部 active（未核对 HTTPS）')
    process.exit(0)
  }
  const results = await Promise.all(hosts.map((h) => probeVia(fetch, h)))
  const bad = results.filter((r) => r.via !== 'saas')
  for (const r of results) log(`  ${r.host.padEnd(22)} HTTP ${r.status} via=${r.via || '-'}${r.error ? ` ${r.error}` : ''}`)
  if (bad.length) {
    log('有主机名的响应没有 X-8bitgo-Via: saas：可能是本机 DNS 还缓存着旧记录、走了 EdgeOne 线路（大陆网络会这样），或真的没切过去')
    notify('SaaS 切换：核对未全部通过', bad.map((r) => `${r.host} HTTP ${r.status} via=${r.via || '-'}`).join('\n'))
    process.exit(1)
  }
  log('全部 active，且响应都经 SaaS 区域')
  notify('SaaS 切换完成', '9 个自定义主机名全部 active，HTTPS 核对通过')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
