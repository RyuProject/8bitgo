/**
 * 启动诊断包：只在一局**失败 / 超时 / 慢启动**时随启动漏斗事件上报，给后台「错误诊断」页用。
 *
 * 为什么要它：启动漏斗（startupFunnel.ts）每局只留一句 160 字的错误摘要。2026-11-11 萨尔瓦多
 * Safari 卡在「下载游戏核心」那次，浏览器是翻 nginx 日志对出来的、卡在哪一步是从「没有百分比」
 * 推断的。诊断包把当时的环境、这一局的阶段时间线、引擎最后几十行日志和慢 / 失败的网络请求
 * 一起带上，后台可以按错误归类、一键复制给 AI 排查。
 *
 * 边界（隐私政策第 4 节写明，`npm run test:legal` 对账）：
 *   - 只在出问题的那一局发；正常开局什么都不多发。
 *   - 不发 IP、完整 User-Agent、账号、ROM 地址：浏览器 / 系统由服务端从请求头归成「Safari 26 / macOS」
 *     这一级再存；网络请求只留「主机 + 文件名」，ROM 文件名换成 [ROM]；日志里的网址、令牌、IP 先在
 *     这里脱敏一遍，服务端入库前再洗一遍。
 *   - 总大小封顶 24KB（keepalive 请求体全局只有 64KB）。
 *
 * 采集本身绝不能影响游戏：所有钩子都 try/catch，原生 console 照常调用。
 */

const LOG_LIMIT = 80
const LOG_LINE_MAX = 300
const BUNDLE_LOG_MAX = 60
const RESOURCE_MAX = 30
const BUNDLE_BYTES_MAX = 24_000

export interface DiagnosticLogLine {
  /** 距本局点击开始的毫秒数（打包时换算） */
  t: number
  /** 来源：page（外层页面）/ ejs（EmulatorJS iframe）/ stage（加载阶段文字）等 */
  s: string
  l: 'error' | 'warn' | 'log' | 'info'
  m: string
}

export interface DiagnosticResource {
  /** 主机 + 文件名，不带查询串；ROM 换成 [ROM] */
  n: string
  /** initiatorType：fetch / xmlhttprequest / script … */
  i: string
  /** 距本局点击开始的毫秒数 */
  at: number
  /** 耗时 ms */
  d: number
  /** 传输字节（0 = 命中浏览器缓存或跨域不可见） */
  tx: number
  /** 解码后字节 */
  sz: number
  /** HTTP 状态（浏览器不给时为 0） */
  st: number
  /** 协议：h2 / h3 / http/1.1 */
  p: string
}

export interface StartupDiagnostics {
  v: 1
  /** 入口脚本的内容哈希名，等于「哪一次部署」 */
  build: string
  /** 完整的失败原因（漏斗 detail 只留 160 字） */
  reason: string
  env: {
    mem: number | null
    cores: number | null
    net: { type: string; downlink: number | null; rtt: number | null; saveData: boolean } | null
    screen: string
    touch: number
    lang: string
    coi: boolean
    sab: boolean
    online: boolean
    /** 这一局里页面处于后台的累计毫秒数 */
    hiddenMs: number
    visible: boolean
  }
  attempt: {
    /** 本次访问里的第几次开局（1 起） */
    index: number
    sinceStartMs: number
  }
  timeline: Array<{ t: number; e: string }>
  logs: DiagnosticLogLine[]
  resources: DiagnosticResource[]
}

interface RawLog { at: number; s: string; l: DiagnosticLogLine['l']; m: string }
interface RawResource extends Omit<DiagnosticResource, 'at'> { atEpoch: number }

interface AttemptState {
  startedAt: number
  index: number
  timeline: Array<{ at: number; e: string }>
}

const logs: RawLog[] = []
const attempts = new Map<string, AttemptState>()
const visitStarts = new Map<string, number>()
const frameSources = new Set<Performance>()
const frameSnapshots: RawResource[] = []
const snapshotProviders = new Set<() => string | null | undefined>()
let hiddenSince: number | null = null
const hiddenSpans: Array<[number, number]> = []
let installed = false

/* ---------- 脱敏 ---------- */

const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g
// 完整 8 段，或带 :: 的压缩写法；不会误伤 18:15:39 这种时间
const IPV6_RE = /(?<![\w:])(?:(?:[\da-f]{1,4}:){7}[\da-f]{1,4}|(?:[\da-f]{1,4}:){1,6}:(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,5})?|::[\da-f]{1,4}(?::[\da-f]{1,4}){0,6})(?![\w:])/gi

/** 网址只留「主机 + 最后一段」；ROM 目录下的文件名换成 [ROM].扩展名 */
export function shortenUrl(raw: string): string {
  try {
    const url = new URL(raw, typeof location !== 'undefined' ? location.href : 'https://8bitgo.com/')
    if (url.protocol === 'blob:') return 'blob:[本地文件]'
    if (url.protocol === 'data:') return 'data:[内联]'
    const segments = url.pathname.split('/').filter(Boolean)
    let last = decodeURIComponent(segments.at(-1) ?? '')
    if (segments.includes('roms') || segments.includes('_route-probe')) {
      const ext = last.includes('.') ? last.slice(last.indexOf('.')) : ''
      last = `[ROM]${ext.slice(0, 16)}`
    }
    const dir = segments.length > 1 ? `${segments[0]}/…/` : ''
    return `${url.host}/${dir}${last}`.slice(0, 120)
  } catch {
    return '[URL]'
  }
}

export function scrubDiagnosticText(value: unknown, max = LOG_LINE_MAX): string {
  return String(value ?? '')
    // PPSSPP 输出带终端颜色码（ESC[91m），只留文字
    // oxlint-disable-next-line no-control-regex -- 就是要匹配 ESC
    .replace(/\u001b?\[\d{1,3}(?:;\d{1,3})*m/g, '')
    // oxlint-disable-next-line no-control-regex -- 就是要把控制字符换成空格
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/(?:https?|blob|wss?):\/\/[^\s"'<>)\]]+/gi, (url) => shortenUrl(url))
    .replace(/\b(bearer)\s+[^\s,;]+/gi, '$1 [已隐藏]')
    .replace(/\b(authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token|key)\b(\s*[:=]\s*)[^\s,;&]+/gi, '$1$2[已隐藏]')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '[令牌]')
    .replace(IPV4_RE, '[IP]')
    .replace(IPV6_RE, '[IP]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/* ---------- 采集 ---------- */

const formatArg = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const v = value as { name?: unknown; message?: unknown; stack?: unknown }
    if (typeof v.message === 'string') {
      const stack = typeof v.stack === 'string' ? ` | ${v.stack.split('\n').slice(1, 4).map((s) => s.trim()).join(' ')}` : ''
      return `${typeof v.name === 'string' ? v.name : 'Error'}: ${v.message}${stack}`
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** 记一行诊断日志。适配器（iframe 里的引擎日志、加载阶段文字）也走这里。 */
export function diagLog(source: string, level: DiagnosticLogLine['l'], ...args: unknown[]): void {
  try {
    const m = scrubDiagnosticText(args.map(formatArg).join(' '))
    if (!m) return
    const last = logs.at(-1)
    // 引擎有时一秒打几十行同样的东西（音频欠载之类），连着重复的只留一条
    if (last && last.m === m && last.s === source) return
    logs.push({ at: Date.now(), s: source.slice(0, 16), l: level, m })
    if (logs.length > LOG_LIMIT) logs.shift()
  } catch {
    /* 记日志本身不能把游戏搞挂 */
  }
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  try {
    performance.setResourceTimingBufferSize?.(1000)
  } catch { /* 老浏览器没有 */ }
  for (const level of ['error', 'warn'] as const) {
    const native = console[level]
    if (typeof native !== 'function') continue
    console[level] = (...args: unknown[]) => {
      diagLog('page', level, ...args)
      native.apply(console, args as [])
    }
  }
  window.addEventListener('error', (event) => {
    diagLog('page', 'error', event.message || 'script error', event.error ?? '', event.filename ? `@${shortenUrl(event.filename)}:${event.lineno}` : '')
  })
  window.addEventListener('unhandledrejection', (event) => diagLog('page', 'error', 'unhandledrejection', event.reason))
  if (document.visibilityState === 'hidden') hiddenSince = Date.now()
  document.addEventListener('visibilitychange', () => {
    const now = Date.now()
    if (document.visibilityState === 'hidden') {
      hiddenSince = now
    } else if (hiddenSince != null) {
      hiddenSpans.push([hiddenSince, now])
      if (hiddenSpans.length > 50) hiddenSpans.shift()
      hiddenSince = null
    }
    diagLog('page', 'info', `visibility=${document.visibilityState}`)
  })
}

function readResources(perf: Performance): RawResource[] {
  try {
    return (perf.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => ({
      n: shortenUrl(entry.name),
      i: String(entry.initiatorType || '').slice(0, 16),
      atEpoch: perf.timeOrigin + entry.startTime,
      d: Math.round(entry.duration),
      tx: Math.round(entry.transferSize || 0),
      sz: Math.round(entry.decodedBodySize || 0),
      st: Math.round((entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus || 0),
      p: String(entry.nextHopProtocol || '').slice(0, 12),
    }))
  } catch {
    return []
  }
}

/**
 * 运行时 iframe 的网络请求在它自己的 performance 里（EmulatorJS 的核心就是在 iframe 里下的），
 * 外层页面看不到。适配器在 iframe 就绪后登记；返回的函数在销毁时调用：先把当时的记录拍下来，
 * 因为 iframe 被移除后就读不到了。
 */
export function watchFramePerformance(win: Window | null | undefined): () => void {
  let perf: Performance | null = null
  try {
    perf = win?.performance ?? null
    perf?.setResourceTimingBufferSize?.(1000)
  } catch {
    perf = null
  }
  if (!perf) return () => {}
  frameSources.add(perf)
  return () => {
    if (!frameSources.delete(perf)) return
    frameSnapshots.push(...readResources(perf))
    if (frameSnapshots.length > 400) frameSnapshots.splice(0, frameSnapshots.length - 400)
  }
}

/**
 * 登记一个「打包那一刻的现场」：运行时自己知道、但不会主动打日志的状态（PSP 的读盘字节数、
 * 预读命中率、最近一次帧率采样……）。打包时调用，结果作为一行 snapshot 日志放在最后。
 * 返回注销函数；运行时销毁时调用。
 */
export function registerDiagnosticSnapshot(provider: () => string | null | undefined): () => void {
  snapshotProviders.add(provider)
  return () => {
    snapshotProviders.delete(provider)
  }
}

function snapshotLines(sinceStart: number): DiagnosticLogLine[] {
  const out: DiagnosticLogLine[] = []
  for (const provider of snapshotProviders) {
    try {
      const m = scrubDiagnosticText(provider() ?? '', LOG_LINE_MAX)
      if (m) out.push({ t: sinceStart, s: 'snapshot', l: 'info', m })
    } catch {
      /* 现场取不到就算了 */
    }
  }
  return out
}

/** 启动漏斗每个事件都过一遍这里：记这一局的时间线，点击开始时起算 */
export function noteStartupEvent(visitId: string, attemptId: string | undefined, event: string): void {
  if (typeof window === 'undefined') return
  // 详情页曝光就装好钩子：点击开始前几秒的页面报错也可能就是原因
  install()
  if (!attemptId) return
  const now = Date.now()
  let state = attempts.get(attemptId)
  if (!state) {
    const index = (visitStarts.get(visitId) ?? 0) + 1
    visitStarts.set(visitId, index)
    state = { startedAt: now, index, timeline: [] }
    attempts.set(attemptId, state)
    if (attempts.size > 20) attempts.delete(attempts.keys().next().value as string)
  }
  if (state.timeline.length < 40) state.timeline.push({ at: now, e: event.slice(0, 24) })
}

function hiddenMsSince(start: number, now: number): number {
  let total = 0
  for (const [from, to] of hiddenSpans) total += Math.max(0, Math.min(to, now) - Math.max(from, start))
  if (hiddenSince != null) total += Math.max(0, now - Math.max(hiddenSince, start))
  return total
}

function buildId(): string {
  try {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
    return (script?.src.split('/').pop() ?? '').split('?')[0].slice(0, 40)
  } catch {
    return ''
  }
}

function environment(start: number, now: number): StartupDiagnostics['env'] {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }
  }
  const c = nav.connection
  return {
    mem: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    net: c ? {
      type: String(c.effectiveType ?? '').slice(0, 8),
      downlink: typeof c.downlink === 'number' ? c.downlink : null,
      rtt: typeof c.rtt === 'number' ? c.rtt : null,
      saveData: Boolean(c.saveData),
    } : null,
    screen: `${screen.width}x${screen.height}@${Math.round((window.devicePixelRatio || 1) * 100) / 100}`,
    touch: nav.maxTouchPoints || 0,
    lang: String(nav.language || '').slice(0, 16),
    coi: Boolean(window.crossOriginIsolated),
    sab: typeof SharedArrayBuffer === 'function',
    online: nav.onLine !== false,
    hiddenMs: hiddenMsSince(start, now),
    visible: document.visibilityState !== 'hidden',
  }
}

/**
 * 挑出这一局里值得看的请求：失败的、慢的、大的。命中缓存的小文件没信息量，挤掉它们给真问题留位置。
 */
function pickResources(start: number): DiagnosticResource[] {
  const all = [...readResources(performance), ...frameSnapshots, ...[...frameSources].flatMap(readResources)]
  const seen = new Set<string>()
  const relevant = all.filter((r) => {
    if (r.atEpoch < start - 2000) return false
    if (/\/api\/(?:games\/[^/]+\/startup|rooms|live|netplay)/.test(r.n)) return false
    const key = `${r.n}@${Math.round(r.atEpoch)}`
    if (seen.has(key)) return false
    seen.add(key)
    return r.st >= 400 || r.d >= 800 || r.sz >= 512 * 1024 || (r.tx === 0 && r.sz === 0 && r.d >= 200)
  })
  relevant.sort((a, b) => b.d - a.d)
  return relevant.slice(0, RESOURCE_MAX)
    .sort((a, b) => a.atEpoch - b.atEpoch)
    .map(({ atEpoch, ...rest }) => ({ ...rest, at: Math.round(atEpoch - start) }))
}

/** 打包。没有这一局的记录（比如页面刚刷新）时返回 null，漏斗事件照常上报。 */
export function collectStartupDiagnostics(attemptId: string | undefined, reason = ''): StartupDiagnostics | null {
  if (typeof window === 'undefined' || !attemptId) return null
  const state = attempts.get(attemptId)
  if (!state) return null
  try {
    const now = Date.now()
    const start = state.startedAt
    const bundle: StartupDiagnostics = {
      v: 1,
      build: buildId(),
      reason: scrubDiagnosticText(reason, 600),
      env: environment(start, now),
      attempt: { index: state.index, sinceStartMs: now - start },
      timeline: state.timeline.map(({ at, e }) => ({ t: at - start, e })),
      logs: logs.filter((line) => line.at >= start - 5000).slice(-(BUNDLE_LOG_MAX - Math.min(4, snapshotProviders.size)))
        .map(({ at, s, l, m }) => ({ t: at - start, s, l, m }))
        .concat(snapshotLines(now - start)),
      resources: pickResources(start),
    }
    // 超了就先砍最早的日志，再砍请求，保证一定发得出去
    while (JSON.stringify(bundle).length > BUNDLE_BYTES_MAX && (bundle.logs.length || bundle.resources.length)) {
      if (bundle.logs.length > 10 || !bundle.resources.length) bundle.logs.shift()
      else bundle.resources.pop()
    }
    return bundle
  } catch {
    return null
  }
}

/** 只给测试用 */
export function resetStartupDiagnosticsForTest(): void {
  logs.length = 0
  attempts.clear()
  visitStarts.clear()
  frameSources.clear()
  frameSnapshots.length = 0
  snapshotProviders.clear()
  hiddenSpans.length = 0
  hiddenSince = null
}
