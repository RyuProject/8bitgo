/**
 * 大陆访客的模拟器运行时线路（paths.ts 的 runtimeBase）：EdgeOne 加速入口坏了 / 极慢时退回同源，并记住一阵子。
 *
 * 2026-11-21 诊断包 #2756 / #2758（《暴力摩托》，QQ 浏览器 22 / Windows / CN，Windows 客体 DOS）：
 * cn.8bitgo.com 这条线对这位访客整体只有约 6KB/s ——
 *   - js-dos.js（320KB）41 秒、emulators.js 32 秒、js-dos.css 28 秒；
 *   - wdosbox-x.js / .wasm 30 秒一个字节都没收到，被预热的 30 秒失速掐掉；
 *   - 第二次开局（#2758）照样走同一条线，同样失败。
 * 以前只有「开局前报错」才在**这一页**里换同源，下一次访问又回到 EdgeOne；而且慢到这个地步时，
 * 运行时文件还没拿到就先被别的时限判死了，换线的那一步根本走不到。
 *
 * 现在：
 *   - 预热（httpWarm.ts）在加速入口上看到「30 秒没有字节」或「持续 20 秒总吞吐低于 24KB/s」就判这条线坏，
 *     本页剩下的运行时文件立刻改走同源（见 createEdgeRouteMonitor）；
 *   - 判坏的结论写进 localStorage，**按运行时分开**记 2 小时：自动重试、刷新、下一次访问都直接走同源；
 *   - 只有硬证据才持久化（失速 / 吞吐极低 / 入口脚本在加速入口上加载失败或超时）。
 *     「开局前报错」可能是 ROM、内存、核心的问题，仍然只影响这一页（markJsdosEdgeFailed 那条）。
 *
 * 为什么只记 2 小时、而且按运行时分开：同源（Cloudflare）对多数大陆访客远比 EdgeOne 慢
 * （AGENTS §2.36：8MB 核心 1.5～43KB/s 对 0.8～1MB/s），误判的代价是把一个正常访客送上慢线。
 * 2 小时足够覆盖「重试 / 刷新 / 隔一会再来」，过期后重新给 EdgeOne 一次机会。
 *
 * 线路仍是「每页每种运行时定一次」：持久化的结论只在本页第一次问到这种运行时时读一次（paths.ts），
 * 中途过期也不会把已经改走同源的这一页再切回 EdgeOne（预热与正式加载必须是同一个 URL）。
 */

export type RuntimeEdgeKind = 'ejs' | 'ruffle' | 'jsdos' | 'ppsspp' | 'j2me'

export const RUNTIME_EDGE_BAD_KEY = '8bitgo.runtime-edge-bad.v1'
export const RUNTIME_EDGE_BAD_TTL_MS = 2 * 60 * 60 * 1000

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readMap(storage: StorageLike | null): Record<string, number> {
  if (!storage) return {}
  try {
    const value = JSON.parse(storage.getItem(RUNTIME_EDGE_BAD_KEY) || '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, number> : {}
  } catch {
    return {}
  }
}

/** 这个运行时的加速入口在本浏览器里是否还处于「判坏」期 */
export function persistedEdgeBad(kind: RuntimeEdgeKind, now = Date.now(), storage = defaultStorage()): boolean {
  const until = readMap(storage)[kind]
  return typeof until === 'number' && Number.isFinite(until) && until > now && until - now <= RUNTIME_EDGE_BAD_TTL_MS
}

/** 记下「这条线坏了」，顺手清掉过期的项；存不进去（无痕、配额满）就只影响这一页 */
export function persistEdgeBad(kind: RuntimeEdgeKind, now = Date.now(), storage = defaultStorage()): void {
  if (!storage) return
  try {
    const map = readMap(storage)
    const next: Record<string, number> = {}
    for (const [key, until] of Object.entries(map)) {
      if (typeof until === 'number' && until > now) next[key] = until
    }
    next[kind] = now + RUNTIME_EDGE_BAD_TTL_MS
    storage.setItem(RUNTIME_EDGE_BAD_KEY, JSON.stringify(next))
  } catch {
    /* 写不进去：本页内的切换照常生效 */
  }
}

/* ---------- 判坏通知：本页里已经发出去的加速入口请求要立刻改道 ---------- */

const badListeners = new Map<RuntimeEdgeKind, Set<() => void>>()

export function onRuntimeEdgeBad(kind: RuntimeEdgeKind, listener: () => void): () => void {
  let set = badListeners.get(kind)
  if (!set) badListeners.set(kind, (set = new Set()))
  set.add(listener)
  return () => { set?.delete(listener) }
}

export function notifyRuntimeEdgeBad(kind: RuntimeEdgeKind): void {
  for (const listener of [...(badListeners.get(kind) ?? [])]) {
    try { listener() } catch { /* 订阅者出错不能打断改道 */ }
  }
}

/* ---------- 吞吐判定 ---------- */

/** 一段连续有请求在途的时间里，至少观察这么久才判「慢」 */
export const EDGE_SLOW_MIN_ELAPSED_MS = 20_000
/**
 * 低于这个总吞吐（解码后字节）就判慢。按「这一段里所有在途请求加起来」算，并发下载不会被误判：
 * 正常的 EdgeOne 线路是几百 KB/s 到 MB/s；24KB/s 下 7.7MB 的 DOSBox-X 要五分多钟。
 */
export const EDGE_SLOW_MAX_BYTES_PER_SEC = 24 * 1024

export type EdgeRouteVerdict = 'ok' | 'slow' | 'stalled'

export interface EdgeRouteMonitor {
  start(url: string): void
  bytes(url: string, n: number): void
  /** stalled：预热自己的失速时限掐掉的（30 秒没有字节） */
  end(url: string, outcome: 'done' | 'failed' | 'stalled'): void
  /** 定时调用；页面在后台时不判（后台节流会把吞吐算低） */
  check(visible?: boolean): EdgeRouteVerdict
  /** 这一段里还在途的 URL（判坏后改道用） */
  openUrls(): string[]
  verdict(): EdgeRouteVerdict
}

/**
 * 纯逻辑的线路监视器：只看喂进来的事件和时间，不碰网络。
 * 「一段」从第一个请求开始，到在途请求清零为止；清零后计数归零，避免把悬停预热和几十秒后的点击开局算成一段。
 */
export function createEdgeRouteMonitor(
  onBad: (verdict: Exclude<EdgeRouteVerdict, 'ok'>, detail: string) => void,
  now: () => number = () => Date.now(),
): EdgeRouteMonitor {
  const open = new Set<string>()
  let burstStart = 0
  let burstBytes = 0
  let verdict: EdgeRouteVerdict = 'ok'

  const fire = (next: Exclude<EdgeRouteVerdict, 'ok'>, detail: string) => {
    if (verdict !== 'ok') return
    verdict = next
    onBad(next, detail)
  }
  const monitor: EdgeRouteMonitor = {
    start(url) {
      if (!open.size) {
        burstStart = now()
        burstBytes = 0
      }
      open.add(url)
    },
    bytes(url, n) {
      if (open.has(url) && n > 0) burstBytes += n
    },
    end(url, outcome) {
      if (!open.has(url)) return
      // 先判再移出：判坏回调要拿到包括这一份在内的「没下完的」清单，改从同源重新预热
      if (outcome === 'stalled') fire('stalled', `${url} 30 秒没有收到数据`)
      open.delete(url)
    },
    check(visible = true) {
      if (verdict !== 'ok' || !open.size) return verdict
      if (!visible) {
        // 后台的这一段不算：回到前台从头计
        burstStart = now()
        burstBytes = 0
        return verdict
      }
      const elapsed = now() - burstStart
      if (elapsed < EDGE_SLOW_MIN_ELAPSED_MS) return verdict
      const rate = burstBytes / (elapsed / 1000)
      if (rate < EDGE_SLOW_MAX_BYTES_PER_SEC) {
        fire('slow', `${Math.round(elapsed / 1000)} 秒共收到 ${Math.round(burstBytes / 1024)}KB（${(rate / 1024).toFixed(1)}KB/s）`)
      }
      return verdict
    },
    openUrls: () => [...open],
    verdict: () => verdict,
  }
  return monitor
}
