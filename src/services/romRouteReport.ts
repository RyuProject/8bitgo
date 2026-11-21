/**
 * 把「优选线路连没连上」回报给服务端，让 deploy/cname-optimizer 换线时有大陆玩家的真实视角。
 *
 * 优选任务从源站（香港）体检 rom.8bitgo.com / download.8bitgo.com 的 CNAME 目标，看不出「香港通、大陆不通」。
 * 线路记分板（romRouteHealth.ts）本来就在记每次 HEAD / 分片的成败，这里只是旁听这两个域名的记录，
 * 攒一会儿再用 sendBeacon 发一个小包（每个域名两个计数），不带 ROM 地址、游戏、账号。
 *
 * 只在大陆访客（或边缘没给结论时）上报：海外访客的成败对「大陆连不连得上」没有意义，服务端也会丢掉。
 * 详见 server/src/route-report.js。
 */
import { apiBase, apiEnabled } from '@/services/api'
import { coverCdnHint } from '@/services/cnHost'
import { setRomRouteListener } from '@/services/romRouteHealth'

/** 被优选任务托管的域名（DNS-only CNAME 到第三方优选域名） */
export const REPORTED_ROUTE_HOSTS = ['rom.8bitgo.com', 'download.8bitgo.com']
/** 第一次有记录后多久发一次；离开页面 / 切后台时立即发 */
const FLUSH_DELAY_MS = 60_000
const MAX_EVENTS = 50

const pending = new Map<string, { ok: number; fail: number }>()
let timer: ReturnType<typeof setTimeout> | null = null
let installed = false

export function routeReportHost(origin: string): string {
  const match = /^https:\/\/([^/:]+)$/i.exec(origin)
  const host = match?.[1].toLowerCase() || ''
  return REPORTED_ROUTE_HOSTS.includes(host) ? host : ''
}

/** 记一次结果；返回是否计入（测试用） */
export function noteRouteResult(origin: string, ok: boolean): boolean {
  const host = routeReportHost(origin)
  if (!host) return false
  const entry = pending.get(host) || { ok: 0, fail: 0 }
  if (ok) entry.ok = Math.min(MAX_EVENTS, entry.ok + 1)
  else entry.fail = Math.min(MAX_EVENTS, entry.fail + 1)
  pending.set(host, entry)
  if (!timer && typeof setTimeout !== 'undefined') timer = setTimeout(() => flushRouteReport(), FLUSH_DELAY_MS)
  return true
}

/** 取出并清空待发的数据；没有就返回 null */
export function takeRouteReport(): string | null {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!pending.size) return null
  const rows = [...pending].map(([h, c]) => ({ h, ok: c.ok, fail: c.fail }))
  pending.clear()
  return JSON.stringify({ r: rows })
}

export function flushRouteReport(): void {
  const body = takeRouteReport()
  if (!body || !apiEnabled()) return
  const url = `${apiBase()}/api/route-health`
  try {
    // text/plain：CORS 安全类型，sendBeacon 在各浏览器都不会拒发、也不触发预检
    const blob = new Blob([body], { type: 'text/plain' })
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, blob)) return
  } catch {
    /* 退回 fetch */
  }
  try {
    void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, credentials: 'omit' }).catch(() => {})
  } catch {
    /* 上报失败无所谓 */
  }
}

/** 入口调用一次。非浏览器环境、海外访客什么都不做 */
export function installRouteReport(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  setRomRouteListener((origin, ok, kind) => {
    if (coverCdnHint() === 'main') return
    // 5xx / 429 说明连上了 Cloudflare，是我们自己 Worker / R2 的问题，换 CNAME 目标救不了，不算线路失败
    if (!ok && kind === 'server') return
    noteRouteResult(origin, ok)
  })
  const onHide = () => {
    if (document.visibilityState === 'hidden') flushRouteReport()
  }
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', () => flushRouteReport())
}
