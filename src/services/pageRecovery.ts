/**
 * 页面崩溃自动刷新之后「到底好没好」的回报。
 *
 * 为什么要它（2026-11-19 后台「failed · page · 页面懒加载模块导入失败」4 份现场）：
 * 兜底页（AppErrorBoundary）在资源核对「修好了」之后是**先上报、再刷新**的 —— 刷新后页面正常打开，
 * 后台也照样记一份「加载失败」，分不清哪些玩家其实只多等了一次刷新、哪些停在了兜底页。
 * 这一批里还有自动化客户端（90 核、页面在后台、3G），噪音把真故障淹了。
 *
 * 现在要刷新的那一刻只把现场（诊断包、修复结论）存进 sessionStorage，刷新后的新页面再决定怎么报：
 *   - 同一个懒加载 chunk 这次加载上了（或者没点名 chunk、20 秒内没再崩）→ 补报一份 `recovered`
 *     （漏斗不算失败，后台单独一组，不发飞书、不触发 AI 分诊）；
 *   - 又崩了 → 兜底页那份报告带上「刷新前：…」，按真实失败报（一次故障只记一行）；
 *   - 点名的 chunk 没等到就离开了 / 过了 20 秒还没加载 → 按 `failed` 补报，标「刷新后未确认」。
 * 自动化客户端不跟刷新、或者刷新前就关了标签页的，这份现场就不报了 —— 少报一份噪音，代价可以接受。
 *
 * 只在 sessionStorage 里放两分钟、只认同一个路径：同一标签页里刷新才算同一次故障。
 */
import { onLazyChunkLoaded } from './moduleLinkRecovery'
import { recordStartupEvent } from './startupFunnel'
import type { StartupDiagnostics, StartupRecovery } from './startupDiagnostics'

const KEY = '8bitgo.page-recovery'
const MAX_AGE_MS = 120_000
/** 刷新后等多久仍没加载上点名 chunk，就按「未确认」补报 */
const CONFIRM_TIMEOUT_MS = 20_000

export type RecoveryOutcome = StartupRecovery['outcome']

/** outcome：recovered / unconfirmed / failed_again；via：同一资源域刷新 / 改用主站资源；afterMs：从刷新到有结论 */
export type RecoveryInfo = StartupRecovery

export interface PendingReport {
  slug: string
  visitId: string
  attemptId: string
  detail: string
  diagnostics: StartupDiagnostics | null
}

interface PendingRecovery {
  v: 1
  path: string
  at: number
  /** 失败的懒加载 chunk（带哈希的文件名）；不知道就是 null */
  file: string | null
  via: 'reload' | 'origin'
  /** 刷新前那一次的一句话（错误 + 修复结论），再次失败时写进报告 */
  summary: string
  /** 刷新后要补报的现场；静默刷新（以前就不上报的那几种）为 null，好了就什么都不发 */
  report: PendingReport | null
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * 刷新前调用。存不进去（无痕模式、配额满）返回 false，调用方就按原来的做法先上报再刷新，现场不能丢。
 */
export function deferRecoveryReport(entry: {
  file: string | null
  via: 'reload' | 'origin'
  summary: string
  report: PendingReport | null
}, path = typeof location === 'undefined' ? '' : location.pathname): boolean {
  const store = session()
  if (!store) return false
  const record: PendingRecovery = { v: 1, path, at: Date.now(), ...entry, summary: entry.summary.slice(0, 300) }
  try {
    store.setItem(KEY, JSON.stringify(record))
    return true
  } catch {
    // 诊断包放不下时至少把前情留着：好了不报，再坏能写进报告
    if (!entry.report) return false
    try {
      store.setItem(KEY, JSON.stringify({ ...record, report: { ...entry.report, diagnostics: null } }))
      return true
    } catch {
      return false
    }
  }
}

function takePending(path: string, now: number): PendingRecovery | null {
  const store = session()
  if (!store) return null
  let raw: string | null = null
  try {
    raw = store.getItem(KEY)
    if (raw) store.removeItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as PendingRecovery
    if (record?.v !== 1 || typeof record.at !== 'number' || now - record.at > MAX_AGE_MS || now < record.at) return null
    // 刷新回来地址一定还是这一页；换了页就是玩家自己走开了，补报成「未确认」
    return { ...record, path: record.path === path ? path : '' }
  } catch {
    return null
  }
}

/** chunk 名去掉内容哈希再比：两次加载之间刚好换了部署，文件名会变（GameDetailPage-AbC.js → GameDetailPage） */
export function chunkStem(file: string | null | undefined): string {
  const name = String(file ?? '').split(/[?#]/)[0].split('/').pop() ?? ''
  return name.replace(/\.js$/, '').replace(/-legacy(?=-)/, '').replace(/-[\w-]{6,12}$/, '')
}

let watching: PendingRecovery | null = null
let settleTimer: ReturnType<typeof setTimeout> | undefined
let onPageHide: (() => void) | null = null

export interface RecoverySender {
  (slug: string, report: PendingReport, event: 'recovered' | 'failed', recovery: RecoveryInfo): void
}

const defaultSender: RecoverySender = (slug, report, event, recovery) => {
  recordStartupEvent(slug, {
    visitId: report.visitId,
    attemptId: report.attemptId,
    event,
    runtime: 'page',
    platform: '',
    detail: report.detail,
    // 诊断包是刷新前采的（那一刻的环境、请求、日志）；结论单独写一栏，服务端据此归组
    diagnostics: report.diagnostics ? { ...report.diagnostics, recovery } : undefined,
  })
}

let sender: RecoverySender = defaultSender

function stopWatching(): void {
  onLazyChunkLoaded(null)
  clearTimeout(settleTimer)
  settleTimer = undefined
  if (onPageHide && typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
  onPageHide = null
}

function settle(outcome: 'recovered' | 'unconfirmed'): void {
  const record = watching
  if (!record) return
  watching = null
  stopWatching()
  if (!record.report) return
  sender(record.report.slug, record.report, outcome === 'recovered' ? 'recovered' : 'failed', {
    outcome,
    via: record.via,
    afterMs: Math.max(0, Date.now() - record.at),
  })
}

/**
 * 客户端入口在渲染前调用一次。上一份文档留下了「刷新中」的现场，就开始等结论。
 */
export function startPageRecoveryWatch(options: { now?: number; path?: string; send?: RecoverySender } = {}): boolean {
  if (options.send) sender = options.send
  const path = options.path ?? (typeof location === 'undefined' ? '' : location.pathname)
  const record = takePending(path, options.now ?? Date.now())
  if (!record) return false
  watching = record
  onLazyChunkLoaded(notePageChunkLoaded)
  if (!record.path) {
    settle('unconfirmed')
    return true
  }
  // 没点名 chunk：20 秒内没再崩就算好了；点名了却一直没加载上，说明玩家没等到 / 页面没走到那一步，记「未确认」
  settleTimer = setTimeout(() => settle(record.file ? 'unconfirmed' : 'recovered'), CONFIRM_TIMEOUT_MS)
  if (typeof window !== 'undefined') {
    onPageHide = () => settle(record.file ? 'unconfirmed' : 'recovered')
    window.addEventListener('pagehide', onPageHide)
  }
  return true
}

/** 懒加载成功时调用（importWithRetry 经 onLazyChunkLoaded 通知）：是刷新前失败的那个 chunk 就补报「已恢复」 */
export function notePageChunkLoaded(file: string | null): void {
  if (!watching?.file || !file) return
  if (chunkStem(file) === chunkStem(watching.file)) settle('recovered')
}

/**
 * 兜底页又接到错误时调用：把刷新前那一次接过来（不再单独补报），写进这一次的报告。
 * 没有在等的现场返回 null。
 */
export function takeRecoveryForFailure(): { summary: string; via: 'reload' | 'origin'; afterMs: number } | null {
  const record = watching
  if (!record) return null
  watching = null
  stopWatching()
  return { summary: record.summary, via: record.via, afterMs: Math.max(0, Date.now() - record.at) }
}

/** 只给测试用 */
export function resetPageRecoveryForTest(): void {
  watching = null
  stopWatching()
  sender = defaultSender
}
