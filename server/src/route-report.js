/**
 * 优选线路的真实用户回报：大陆玩家浏览器连 rom.8bitgo.com / download.8bitgo.com 成功了几次、失败了几次。
 *
 * 为什么要它：deploy/cname-optimizer 每 5 分钟从源站（香港）体检优选 CNAME 的目标。它能发现「解析到非 CF IP、
 * 对我们的 Host 回 403、整个域名死了」，却看不到「从香港连得上、大陆连不上」—— 后者才是这条线路存在的理由。
 * 浏览器的线路记分板（src/services/romRouteHealth.ts）本来就在记每次下载的成败，这里把大陆访客的那份汇总起来，
 * 给优选任务一个真实的大陆视角（GET /api/internal/route-health，只允许本机、不经反代读取）。
 *
 * 防伪造：
 * - 上报不用登录，所以只按「不同访客」算，不按次数：每个访客在窗口里只算一票（全失败 / 有成功）；
 *   访客身份是 IP 的 HMAC（进程启动时随机密钥，不落盘、不进日志），重启后自然作废。
 * - 只收大陆访客（IP 查库，查不到再看网关国家头）；按 IP 与全站两道限流。
 * - 优选任务那边还要求够数的不同访客、过半全失败才判坏，并且新目标仍要先过源站体检 ——
 *   伪造最坏的后果是把线路换成另一条同样健康的候选，不会换到坏线路上。
 */
import { createHmac, randomBytes } from 'node:crypto'
import express, { Router } from 'express'
import { CACHE } from './cache.js'
import { clientIp } from './playcount.js'
import { resolveCountry } from './presence.js'
import { takeAnonymous } from './rateLimit.js'

export const DEFAULT_REPORT_HOSTS = ['rom.8bitgo.com', 'download.8bitgo.com']
/** 汇总窗口：优选任务每 5 分钟读一次，看最近半小时足够分辨「一直坏」和「偶尔抖一下」 */
export const REPORT_WINDOW_MS = 30 * 60 * 1000
/** 单次上报里每个域名最多算这么多次，超出按上限截断（只影响次数统计，访客票数本来就是一人一票） */
const MAX_EVENTS_PER_REPORT = 50
/** 每个访客每个域名保留的上报条数；更早的丢掉 */
const MAX_REPORTS_PER_VISITOR = 20
/** 每个域名最多记这么多访客，防内存被刷爆（满了先清过期，再不行丢最旧的） */
const MAX_VISITORS_PER_HOST = 5000

const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'eo-connecting-ip', 'true-client-ip', 'x-8bitgo-edge', 'x-8bitgo-site']
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const clampCount = (value) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_EVENTS_PER_REPORT) : 0
}

/** 解析浏览器上报：{ r: [{ h: 'rom.8bitgo.com', ok: 3, fail: 1 }] }，只留白名单里的域名 */
export function parseRouteReport(body, hosts = DEFAULT_REPORT_HOSTS) {
  let data = body
  if (typeof data === 'string') {
    if (data.length > 4096) return null
    try { data = JSON.parse(data) } catch { return null }
  }
  const rows = Array.isArray(data?.r) ? data.r.slice(0, 8) : []
  const allowed = new Set(hosts.map((h) => h.toLowerCase()))
  const out = new Map()
  for (const row of rows) {
    const host = typeof row?.h === 'string' ? row.h.toLowerCase() : ''
    if (!allowed.has(host)) continue
    const ok = clampCount(row.ok)
    const fail = clampCount(row.fail)
    if (!ok && !fail) continue
    const prev = out.get(host) || { ok: 0, fail: 0 }
    out.set(host, { ok: Math.min(prev.ok + ok, MAX_EVENTS_PER_REPORT), fail: Math.min(prev.fail + fail, MAX_EVENTS_PER_REPORT) })
  }
  return out.size ? out : null
}

export function createRouteReportStore({ windowMs = REPORT_WINDOW_MS, maxVisitors = MAX_VISITORS_PER_HOST } = {}) {
  /** host → visitor → [{ at, ok, fail }] */
  const byHost = new Map()

  function prune(visitors, now) {
    for (const [visitor, reports] of visitors) {
      const kept = reports.filter((r) => now - r.at < windowMs)
      if (kept.length) visitors.set(visitor, kept)
      else visitors.delete(visitor)
    }
  }

  function record(host, visitor, { ok, fail }, now = Date.now()) {
    let visitors = byHost.get(host)
    if (!visitors) byHost.set(host, (visitors = new Map()))
    if (!visitors.has(visitor) && visitors.size >= maxVisitors) {
      prune(visitors, now)
      while (visitors.size >= maxVisitors) visitors.delete(visitors.keys().next().value)
    }
    const reports = visitors.get(visitor) || []
    reports.push({ at: now, ok, fail })
    // 删掉再插回，Map 的顺序就是「最近活跃」的顺序，满了丢的是最久没动静的访客
    visitors.delete(visitor)
    visitors.set(visitor, reports.slice(-MAX_REPORTS_PER_VISITOR))
  }

  /**
   * since 之后（且在窗口内）的汇总：每个访客一票——
   * okVisitors 有过成功；failOnlyVisitors 只有失败（这类访客才说明「这条线路对他不通」）。
   */
  function summary(since = 0, now = Date.now()) {
    const from = Math.max(Number(since) || 0, now - windowMs)
    const hosts = {}
    for (const [host, visitors] of byHost) {
      prune(visitors, now)
      const s = { visitors: 0, okVisitors: 0, failOnlyVisitors: 0, okEvents: 0, failEvents: 0 }
      for (const reports of visitors.values()) {
        let ok = 0
        let fail = 0
        for (const r of reports) if (r.at >= from) { ok += r.ok; fail += r.fail }
        if (!ok && !fail) continue
        s.visitors++
        s.okEvents += ok
        s.failEvents += fail
        if (ok) s.okVisitors++
        else s.failOnlyVisitors++
      }
      hosts[host] = s
    }
    return { since: from, now, windowMs, hosts }
  }

  return { record, summary, reset: () => byHost.clear() }
}

/** 只认本机直连、不带任何反代头的请求（nginx 在同一台机器上，经它进来的请求一定带 X-Forwarded-For） */
export function trustedLocalRequest(req) {
  const headers = req?.headers || {}
  for (const name of PROXY_HEADERS) if (headers[name]) return false
  const address = req?.socket?.remoteAddress || ''
  return LOOPBACK.has(address)
}

export function createRouteReportRouter({
  store = createRouteReportStore(),
  hosts = (process.env.ROUTE_REPORT_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
  countryOf = (req) => resolveCountry(clientIp(req), req.headers),
  now = () => Date.now(),
} = {}) {
  const allowedHosts = hosts.length ? hosts : DEFAULT_REPORT_HOSTS
  const secret = randomBytes(32)
  const visitorOf = (req) => createHmac('sha256', secret).update(clientIp(req) || 'unknown').digest('base64url').slice(0, 22)
  const router = Router()

  // sendBeacon 发的是 text/plain（跨浏览器最稳，不触发预检）；也接受 application/json
  router.post('/route-health', express.text({ type: 'text/plain', limit: '4kb' }), (req, res) => {
    res.set('Cache-Control', CACHE.none)
    const gate = takeAnonymous(req, 'route-report', { perIp: 20, global: 3000, windowMs: 10 * 60 * 1000 })
    if (!gate.ok) return res.status(429).end()
    const parsed = parseRouteReport(req.body, allowedHosts)
    if (!parsed) return res.status(400).end()
    // 非大陆访客的数据对「大陆连不连得上」没有意义，直接丢
    if (countryOf(req) !== 'CN') return res.status(204).end()
    const visitor = visitorOf(req)
    const t = now()
    for (const [host, counts] of parsed) store.record(host, visitor, counts, t)
    res.status(204).end()
  })

  router.get('/internal/route-health', (req, res) => {
    res.set('Cache-Control', CACHE.none)
    if (!trustedLocalRequest(req)) return res.status(404).end()
    res.json(store.summary(Number(req.query.since) || 0, now()))
  })

  return router
}
