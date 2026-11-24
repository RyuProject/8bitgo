/**
 * React 侧接入「坏 chunk 自修复」（public/assets/asset-repair-v7.js）。
 *
 * 2026-11-15 PK / TH 两位玩家打开详情页就崩：
 * `SyntaxError: The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'`。
 * 源站那份 live-Cqhc9j-k.js 明明导出了 x，同一构建两次打出的产物逐字节相同，改导出名也会换文件名 ——
 * 所以是浏览器手里那份内容和源站不一样（某一跳缓存给了别的字节）。文件名带内容哈希、一年 immutable，
 * 普通刷新不会重新取它，只会原样再崩一次。
 *
 * 修复逻辑不放在这个 bundle 里：bundle 自己坏了时它也跑不起来。首页内联钩子定义
 * `window.__8bitgoAssetRepair`，出错时才从入口脚本所在资源域加载那份独立脚本；这里只负责调用和把结果写进诊断包。
 *
 * 2026-11-16 诊断包 #761（微信 iOS，cn.8bitgo.com/_cn/assets/ 上懒加载 GameDetailPage 报
 * `Importing a module script failed`）补了三件事：
 *   - Safari 的这句错误不带地址：懒加载函数的源码里就有 chunk 文件名（lazyChunkFile），出错时挂在错误上，
 *     兜底页把它作为点名文件交给修复脚本；
 *   - 「修复脚本没有运行」分清是加载失败、超时还是核对没跑完，并写出试过的地址（repairLoadInfo）；
 *   - 入口在大陆加速入口上时，懒加载失败改用主站资源整页重新载入（originAssetsUrl），见 AppErrorBoundary。
 */

/** 各家浏览器的措辞：Chrome / Firefox / Safari */
const LINK_ERROR_PATTERNS: readonly RegExp[] = [
  /The requested module ['"]([^'"]+)['"] does not provide an export named ['"]([^'"]+)['"]/,
  /import not found: (\S+)/,
  /Importing binding name ['"]([^'"]+)['"] is not found/,
]

export interface ModuleLinkFailure {
  /** 出错的模块（相对 import 的写法，例如 ./live-Cqhc9j-k.js）；Firefox / Safari 不给 */
  specifier: string | null
  /** 缺的导出名 */
  exportName: string
}

export function moduleLinkFailure(message: string): ModuleLinkFailure | null {
  const chrome = LINK_ERROR_PATTERNS[0].exec(message)
  if (chrome) return { specifier: chrome[1], exportName: chrome[2] }
  for (const pattern of LINK_ERROR_PATTERNS.slice(1)) {
    const hit = pattern.exec(message)
    if (hit) return { specifier: null, exportName: hit[1] }
  }
  return null
}

/** 相对 import 以入口脚本所在目录为基准（大陆入口是 cn.8bitgo.com/_cn/assets/）。 */
export function resolveChunkUrl(specifier: string, entrySrc: string): string | null {
  if (!/^\.\.?\/[\w.-]+\.js$/.test(specifier) || !entrySrc) return null
  try {
    return new URL(specifier, entrySrc).href
  } catch {
    return null
  }
}

/* ---------- 懒加载失败点名 ---------- */

const LAZY_FAILURE = '__8bitgoLazyChunk'

/**
 * 从懒加载函数的源码里取出 chunk 文件名。
 *
 * 现代生产构建里 `lazyNamed(() => import('@/pages/GameDetailPage'), …)` 编出来是
 * ``()=>h(()=>import(`./GameDetailPage-BfqMSSyK.js`),__vite__mapDeps([…]),import.meta.url)``，
 * 函数的源码文本里就有准确的文件名（与导出名无关，BrowsePages 这种一个文件多个页面也对）。
 * Safari 的 `Importing a module script failed` 不带地址，靠它才知道是哪个 chunk。
 * 开发环境是 `/src/...` 的源码路径，认不出就返回 null。
 */
export function lazyChunkFile(load: unknown): string | null {
  let source = ''
  try {
    source = String(load)
  } catch {
    return null
  }
  // 现代包里能看到 import('./x.js')；legacy 包经 plugin-legacy 转成 System.import，
  // 有时再包一层 __vite__mapDeps，文件名会被移到运行时依赖表里，见下方的错误 URL 回退。
  const hit = /\b(?:System\.)?import\(\s*[`'"]\.\/([\w.-]+\.js)[`'"]\s*\)/.exec(source)
  return hit ? hit[1] : null
}

const SYSTEMJS_LOAD_FAILURE = /SystemJS[^\n)]*errors\.md/i

/** legacy 动态 chunk 的加载错误会把失败 URL 放进 SystemJS 的通用错误消息。 */
export function failedLegacyChunkFile(error: unknown): string | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'string')) return null
  let source = ''
  try {
    if (typeof error === 'string') source = error
    else {
      const value = error as { message?: unknown; stack?: unknown }
      source = [value.message, value.stack].filter((part) => typeof part === 'string').join('\n')
    }
  } catch {
    return null
  }
  if (!SYSTEMJS_LOAD_FAILURE.test(source)) return null
  const hit = /(?:^|[\\/\s"'(])([\w.-]+-legacy-[\w.-]+\.js)(?=[?#,\s)'"\]]|$)/i.exec(source)
  return hit?.[1] ?? null
}

/** 懒加载失败时把 chunk 文件名挂在错误对象上（React 会把同一个对象交给错误边界） */
export function tagLazyFailure(error: unknown, file: string | null, name: string): void {
  if (!error || typeof error !== 'object') return
  try {
    const graph = importEvidence(error)
    Object.defineProperty(error, LAZY_FAILURE, { value: graph ? { file, name, graph } : { file, name }, configurable: true })
  } catch {
    /* 冻结的错误对象：拿不到点名，修复脚本仍会按 Resource Timing 核对 */
  }
}

export interface LazyFailureTag {
  file: string | null
  name: string
  /** importWithRetry 第一次失败时从 Resource Timing / SystemJS 错误里看到的模块图证据 */
  graph?: ImportGraphEvidence | null
}

export function lazyFailure(error: unknown): LazyFailureTag | null {
  if (!error || typeof error !== 'object') return null
  const tag = (error as Record<string, unknown>)[LAZY_FAILURE] as LazyFailureTag | undefined
  return tag && typeof tag.name === 'string' ? tag : null
}

/* ---------- 模块图证据：失败的是懒加载入口本身，还是它的静态依赖 ---------- */

/**
 * 2026-11-19 诊断包 #1285 / #1368 / #1393（以及更早的 #917 / #1108）的现场都是：
 * `Failed to fetch dynamically imported module: …/GameDetailPage-*.js`，换两个查询串重试仍失败，
 * 修复脚本随后用 fetch() 取原 URL、强制重取、查询串副本，SHA-256 全对。
 *
 * 本地用 Chromium 153 与 WebKit 26.6 复现（scripts/test-asset-repair.mjs 记了实验结论）：
 *   - 懒加载入口的**静态依赖**取不下来（404 / 错误 MIME / 请求被中止 / window.stop()）时，
 *     Chrome 报错里写的仍是**入口**的地址，Safari 的「Importing a module script failed」干脆不带地址；
 *   - 失败的依赖被这一份文档的模块表记住：换查询串重新导入入口，依赖仍按原地址解析，直接拿到同一个失败，
 *     连请求都不再发；只有整页刷新（新文档、新模块表）才会重新取；
 *   - 同一时刻 fetch() 这些文件全都正常。
 * 所以「原 URL 内容正常但导入失败」不说明 CDN 上那份有问题，v6 据此改走回源地址、请求清边缘缓存是误判。
 *
 * 能不能在页面里分辨：Resource Timing 里入口那条已经完整下载（有正文、不是错误状态）就说明失败在依赖里，
 * 再换查询串重试入口只会白下一遍入口（3G 上就是几百 KB 和两秒多），直接交给错误边界整页刷新。
 * 依赖请求失败时 Chrome 也会留一条 responseStatus 为 0 / ≥400、没有正文的记录，可以点名；WebKit 不记失败的请求。
 * legacy 的 SystemJS 错误本身就写着失败的那个 URL，和入口文件名一比就知道。
 */
export interface ImportGraphEvidence {
  /**
   * ok：入口已完整下载，失败在依赖；failed：入口自己没下下来；unknown：看不出（跨源无 TAO、开发环境）；
   * preload：预加载助手暖缓存时依赖就取不下来了（还没碰模块表）
   */
  top: 'ok' | 'failed' | 'unknown' | 'preload'
  /** 同目录下这次导入期间失败的 JS 请求（文件名），最多 6 个 */
  failed: string[]
}

/** 只用到 Resource Timing 的这几个字段；测试里可以直接给普通对象 */
export interface ResourceTimingLike {
  name: string
  responseStart?: number
  transferSize?: number
  decodedBodySize?: number
  /** Chrome 109+；Safari / Firefox 没有 */
  responseStatus?: number
}

const IMPORT_EVIDENCE = '__8bitgoImportEvidence'

function tagImportEvidence(error: unknown, evidence: ImportGraphEvidence): void {
  if (!error || typeof error !== 'object') return
  try {
    Object.defineProperty(error, IMPORT_EVIDENCE, { value: evidence, configurable: true })
  } catch { /* 冻结的错误对象：没有证据，兜底页照常核对 */ }
}

function importEvidence(error: unknown): ImportGraphEvidence | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as Record<string, unknown>)[IMPORT_EVIDENCE] as ImportGraphEvidence | undefined
  return value && typeof value.top === 'string' ? value : null
}

const MAX_FAILED_DEPS = 6

/**
 * 读模块图证据。不按时间筛：悬停预取（PlayerChunk.preloadPlayer）或更早的页面早就可能把某个依赖取失败了，
 * 被模块表记住之后，这一次导入拿到的正是那个旧失败 —— 它恰恰是原因。
 */
export function importGraphEvidence(
  file: string,
  base: string,
  error: unknown,
  entries: readonly ResourceTimingLike[],
  pageOrigin: string,
): ImportGraphEvidence {
  // legacy：SystemJS 先装好入口才去取它的依赖，错误里写的是真正失败的那个文件
  const legacyFailed = isSystemJsChunkLoadError(error) ? failedLegacyChunkFile(error) : null
  if (legacyFailed) return { top: legacyFailed === file ? 'failed' : 'ok', failed: [legacyFailed] }

  let dir = ''
  try {
    dir = new URL('./', base).href
  } catch {
    return { top: 'unknown', failed: [] }
  }
  const rows = entries.filter((entry) => {
    const url = String(entry.name || '')
    return url.startsWith(dir) && /^[\w.-]+\.js(?:[?#]|$)/.test(url.slice(dir.length))
  })
  const fileName = (url: string) => url.slice(dir.length).split(/[?#]/)[0]
  const status = (entry: ResourceTimingLike) => (typeof entry.responseStatus === 'number' ? entry.responseStatus : 0)
  const loaded = (entry: ResourceTimingLike) => (entry.decodedBodySize ?? 0) > 0 && (status(entry) === 0 || (status(entry) >= 200 && status(entry) < 300))
  // 跨源（大陆加速入口）没有 Timing-Allow-Origin 时，成功的请求也是全 0；同源或这个源有成功记录（TAO 在）才看得出失败
  const originOf = (url: string) => {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }
  const visible = new Set<string>([pageOrigin])
  for (const entry of rows) if (loaded(entry) || (entry.responseStart ?? 0) > 0) visible.add(originOf(entry.name))
  const failedRow = (entry: ResourceTimingLike) => status(entry) >= 400
    || (status(entry) === 0 && !(entry.decodedBodySize ?? 0) && !(entry.transferSize ?? 0) && !(entry.responseStart ?? 0) && visible.has(originOf(entry.name)))

  // 入口本身：原地址的记录（不论早晚，悬停预取 / modulepreload 也算）
  const own = rows.filter((entry) => fileName(entry.name) === file && !/[?&]chunk-retry=/.test(entry.name))
  const top = own.some(loaded) ? 'ok' : own.some(failedRow) ? 'failed' : 'unknown'
  const failed: string[] = []
  for (const entry of rows) {
    if (!failedRow(entry)) continue
    const name = fileName(entry.name)
    if (name !== file && !failed.includes(name) && failed.length < MAX_FAILED_DEPS) failed.push(name)
  }
  return { top, failed }
}

function readResourceTimings(): ResourceTimingLike[] {
  try {
    return typeof performance === 'undefined' ? [] : (performance.getEntriesByType('resource') as unknown as ResourceTimingLike[])
  } catch {
    return []
  }
}

/**
 * 预加载助手（scripts/lib/vite-resilient-preload.mjs）暖缓存重试过仍取不下来的 JS / CSS 依赖。
 * 这种失败没碰模块表：再调一次原加载函数（又会重新暖资源）就能重试，不必换入口查询串、更不必整页刷新。
 */
const PRELOAD_FAILURE = '__8bitgoPreloadFailure'

export function preloadFailure(error: unknown): { failed: string[] } | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as Record<string, unknown>)[PRELOAD_FAILURE] as { failed?: unknown } | undefined
  if (!value || !Array.isArray(value.failed)) return null
  return { failed: value.failed.filter((name): name is string => typeof name === 'string' && /^[\w.-]+\.(?:js|css)$/.test(name)).slice(0, MAX_FAILED_DEPS) }
}

/** 写进诊断包的一句话：失败在入口还是依赖 */
export function describeImportEvidence(evidence: ImportGraphEvidence | null | undefined): string {
  if (!evidence) return ''
  const deps = evidence.failed.length ? `，失败的请求：${evidence.failed.join('、')}` : ''
  if (evidence.top === 'preload') return `模块图：静态依赖重试后仍取不下来（没进模块表，已整套重试）${deps}`
  if (evidence.top === 'ok') return `模块图：入口已完整下载、失败在静态依赖（被本页模块表记住，只有整页刷新能重取）${deps}`
  if (evidence.top === 'failed') return `模块图：入口本身没下下来${deps}`
  return deps ? `模块图：看不出入口是否下完${deps}` : ''
}

/* ---------- 大陆加速入口 ---------- */

/**
 * 入口脚本是不是从大陆加速入口（cn.<裸域>/_cn/assets/）加载的。只有这种情况懒加载才有「换主站」可退：
 * 大陆入口站点本身、非大陆访客、本地开发的资源都和页面同源。
 */
export function assetsFromCnEdge(entrySrc: string, pageOrigin: string): boolean {
  if (!entrySrc || !pageOrigin) return false
  try {
    const url = new URL(entrySrc, pageOrigin)
    return url.origin !== pageOrigin && url.pathname.startsWith('/_cn/assets/')
  } catch {
    return false
  }
}

/**
 * 带 `__assets=origin` 的当前页地址：服务端据此不把资源改写到 EdgeOne（shared/cover-cdn-hint.js），
 * 客户端入口在渲染前用 consumeOriginAssetsParam 去掉它。
 */
export function originAssetsUrl(loc: { pathname: string; search: string; hash: string }): string {
  const kept = loc.search.replace(/^\?/, '').split('&').filter((part) => part && !/^__assets(?:=|$)/.test(part))
  kept.push('__assets=origin')
  return `${loc.pathname}?${kept.join('&')}${loc.hash}`
}

let fromOrigin = false

/**
 * 客户端入口（entry-client.tsx）在渲染前调用：地址带 `__assets=origin` 就记下「这一页的资源来自主站」，
 * 并把参数从地址栏去掉（免得被分享出去，也和服务端渲染时用的地址一致 —— 服务端早就剥掉了）。
 *
 * 不放在首页内联钩子里做：钩子后面的语言跳转脚本和 edge-route-v2.js 会用 location.search 拼跳转地址，
 * 钩子先去掉的话，一旦发生跳转，这个标记就丢了，跳过去的页面又回到 EdgeOne。
 */
export function consumeOriginAssetsParam(
  loc: { pathname: string; search: string; hash: string } = location,
  hist: Pick<History, 'replaceState' | 'state'> = history,
): boolean {
  const parts = loc.search.replace(/^\?/, '').split('&').filter(Boolean)
  const kept = parts.filter((part) => part !== '__assets=origin')
  if (kept.length === parts.length) return false
  fromOrigin = true
  try {
    hist.replaceState(hist.state, '', `${loc.pathname}${kept.length ? `?${kept.join('&')}` : ''}${loc.hash}`)
  } catch {
    /* 改不了地址栏也不影响「这一页来自主站」的判断 */
  }
  return true
}

/** 这一页是不是「改用主站资源重新载入」的那一份 */
export function onOriginAssetsPage(): boolean {
  return fromOrigin
}

/* ---------- 修复脚本 ---------- */

/** 与 public/assets/asset-repair-v7.js 的返回值一致（新字段在旧脚本里没有，所以是可选的） */
export interface AssetRepairResult {
  manifest: boolean
  checked: number
  ok: number
  /** 浏览器缓存里那份坏了，绕过缓存重取后对上了 */
  repaired: string[]
  /** 错误点名的文件，缓存里那份看着没问题，仍强制重取覆盖了一遍 */
  refreshed: string[]
  /** v7：点名文件的普通地址字节、类型都正常 —— 导入失败发生在浏览器这一份文档里，整页刷新即可，不改地址、不清边缘 */
  inDocument?: string[]
  /** 普通地址异常但查询串回源正常：临时改用该地址（下次开页由 import map 生效），并已通知服务端清边缘缓存 */
  remapped: string[]
  /** 回源那份也对不上：多半是部署本身的问题 */
  bad: string[]
  /** 取不下来（网络 / HTTP 错误），主站也取不下来或本来就是主站 */
  failed: string[]
  /** 取不下来，绕过缓存重试一次就好了 */
  recovered?: string[]
  /** 大陆加速入口取不下来，主站同名文件正常 */
  edgeOnly?: string[]
  /** 异常文件的取数经过 */
  trace?: string[]
  /** 资源从哪个主机取的 */
  from?: string
  reloaded: boolean
  ms: number
}

interface RepairOptions {
  reason: string
  urls: string[]
}

type RepairHook = (opts: RepairOptions & { reload: boolean }) => Promise<AssetRepairResult | null>

/** 首页内联钩子记的每次修复脚本加载：地址、结果（ok / error / timeout / empty=加载了却没定义入口）、耗时 */
export interface RepairLoadAttempt {
  u: string
  r: string
  ms: number
}

export interface RepairLoadInfo {
  attempts: RepairLoadAttempt[]
  /** 外层 20 秒等不到结果 */
  timedOut: boolean
  /** 页面没有内联钩子（旧模板 / 嵌入页） */
  noHook: boolean
}

const REPAIR_TIMEOUT_MS = 20_000
let lastLoad: { timedOut: boolean; noHook: boolean } = { timedOut: false, noHook: false }

type RepairWindow = Window & { __8bitgoAssetRepair?: RepairHook; __8bitgoAssetRepairLoad?: unknown }

function repairWindow(): RepairWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as RepairWindow)
}

/**
 * 调首页内联钩子；钩子不在（旧模板、SSR 外的嵌入页）返回 null，调用方退回原来的处理。
 * 刷新由调用方决定（reload: false）：要先把诊断包发出去。
 */
export function repairAssets(opts: RepairOptions): Promise<AssetRepairResult | null> | null {
  const hook = repairWindow()?.__8bitgoAssetRepair
  if (typeof hook !== 'function') {
    lastLoad = { timedOut: false, noHook: true }
    return null
  }
  lastLoad = { timedOut: false, noHook: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      lastLoad = { ...lastLoad, timedOut: true }
      resolve(null)
    }, REPAIR_TIMEOUT_MS)
  })
  const run = Promise.resolve()
    .then(() => hook({ ...opts, reload: false }))
    .catch(() => null)
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
}

/** 最近一次 repairAssets 时修复脚本是怎么加载的（给诊断包分清「加载失败」和「超时」） */
export function repairLoadInfo(): RepairLoadInfo {
  const raw = repairWindow()?.__8bitgoAssetRepairLoad
  const attempts = Array.isArray(raw)
    ? raw.slice(0, 6).filter((row): row is RepairLoadAttempt => Boolean(row) && typeof row.u === 'string')
      .map((row) => ({ u: row.u, r: String(row.r), ms: Number(row.ms) || 0 }))
    : []
  return { attempts, ...lastLoad }
}

export function repairFixedSomething(result: AssetRepairResult | null): boolean {
  return Boolean(result && result.repaired.length + result.refreshed.length + result.remapped.length
    + (result.recovered?.length ?? 0) + (result.inDocument?.length ?? 0) > 0)
}

const LOAD_OUTCOME: Record<string, string> = {
  ok: '已加载',
  error: '加载失败',
  timeout: '5 秒超时',
  empty: '加载了但没有运行',
}

function describeLoad(load: RepairLoadInfo | undefined): string {
  if (!load) return '资源核对：修复脚本没有运行（加载失败或超时）'
  if (load.noHook) return '资源核对：页面没有修复钩子（旧模板）'
  const tried = load.attempts.map((a) => `${a.u} ${LOAD_OUTCOME[a.r] ?? a.r} ${a.ms}ms`).join('；')
  if (load.attempts.some((a) => a.r === 'ok')) {
    return `资源核对：修复脚本已加载（${tried}），${load.timedOut ? '核对 20 秒内没有结束' : '核对没有返回结果'}`
  }
  if (!load.attempts.length) {
    return load.timedOut ? '资源核对：20 秒内修复脚本一次加载都没结束' : '资源核对：修复脚本没有运行（没有加载记录）'
  }
  return `资源核对：修复脚本没有加载上：${tried}${load.timedOut ? '；20 秒等不到结果' : ''}`
}

/** 写进诊断包的一行：后台按这行就分得清「浏览器缓存坏了」「CDN 边缘坏了」「源站就是坏的」「EdgeOne 取不下来」 */
export function summarizeRepair(result: AssetRepairResult | null, load?: RepairLoadInfo): string {
  if (!result) return describeLoad(load)
  const list = (names: string[]) => names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '')
  const parts = [`资源核对：${result.from ? `资源在 ${result.from}，` : ''}${result.manifest ? '有' : '没有'}校验清单，查了 ${result.checked} 个，${result.ok} 个正常`]
  if (result.repaired.length) parts.push(`浏览器缓存里的坏副本已重取：${list(result.repaired)}`)
  if (result.refreshed.length) parts.push(`已强制重取：${list(result.refreshed)}`)
  if (result.recovered?.length) parts.push(`取不下来、重试后正常：${list(result.recovered)}`)
  if (result.inDocument?.length) parts.push(`文件字节与类型都正常，导入失败发生在本页模块表里（整页刷新即可，不改地址、不清边缘）：${list(result.inDocument)}`)
  if (result.remapped.length) parts.push(`普通地址异常、查询串回源正常，已改走回源地址并请求清缓存：${list(result.remapped)}`)
  if (result.edgeOnly?.length) parts.push(`大陆加速入口取不下来、主站正常：${list(result.edgeOnly)}`)
  if (result.bad.length) parts.push(`回源也对不上：${list(result.bad)}`)
  if (result.failed.length) parts.push(`取不下来：${list(result.failed)}`)
  if (result.trace?.length) parts.push(`经过：${result.trace.slice(0, 3).join('｜')}`)
  parts.push(`${result.ms}ms`)
  return parts.join('；')
}

/* ---------- 懒加载就地重试 ---------- */

/** 懒加载成功时通知谁（services/pageRecovery.ts 等着确认「刷新后那个 chunk 加载上了」） */
let chunkLoadedListener: ((file: string) => void) | null = null
export function onLazyChunkLoaded(listener: ((file: string) => void) | null): void {
  chunkLoadedListener = listener
}
function notifyChunkLoaded(file: string | null): void {
  if (!file || !chunkLoadedListener) return
  try {
    chunkLoadedListener(file)
  } catch { /* 回报出错不能让页面加载失败 */ }
}

/**
 * 网络层导入失败（chunk 取不下来）才值得重试；SyntaxError（字节坏了、缺导出）重试同一份缓存没用，交给修复脚本。
 * 措辞覆盖 Chrome（Failed to fetch dynamically imported module）、Firefox（error loading dynamically imported module）、
 * Safari（Importing a module script failed）和 legacy 包里的 SystemJS 脚本加载错误。
 */
const RETRYABLE_IMPORT = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|Unable to preload|NetworkError|Load failed/i

/**
 * plugin-legacy 把懒加载改成 System.import；脚本请求失败时 SystemJS 抛出的错误只带资源 URL 和
 * HTMLScriptElement 回调栈，不含现代浏览器的「动态模块加载失败」措辞。
 */
export function isSystemJsChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { message?: unknown; stack?: unknown }
  const message = String(err.message ?? '')
  const stack = String(err.stack ?? '')
  return /SystemJS\b[\s\S]{0,500}errors\.md/i.test(message)
    && /HTMLScriptElement\.<anonymous>/i.test(`${message}\n${stack}`)
}

export function retryableImportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { name?: unknown; message?: unknown }
  if (err.name === 'SyntaxError') return false
  const message = `${String(err.name ?? '')}: ${String(err.message ?? '')}`
  return RETRYABLE_IMPORT.test(message) || isSystemJsChunkLoadError(error)
}

/** 重试间隔：逐步拉长，避免弱网 / 后台页立刻重复争抢连接。 */
export const LAZY_RETRY_DELAYS_MS: readonly number[] = [500, 1800]
/** 离线时最多等多久「恢复联网」再重试；等不到也照样试一次，交给错误边界。 */
const OFFLINE_WAIT_MS = 20_000
let chunkRetrySequence = 0

function nextChunkRetryNonce(attempt: number): string {
  chunkRetrySequence = (chunkRetrySequence + 1) % Number.MAX_SAFE_INTEGER
  return `${Date.now().toString(36)}-${chunkRetrySequence.toString(36)}-${attempt.toString(36)}`
}

export interface RetryEnv {
  sleep: (ms: number) => Promise<void>
  /** 浏览器明确报告离线时，等 online 事件（或超时） */
  waitOnline: (maxMs: number) => Promise<void>
  online: () => boolean
  /** 按 URL 导入（重试时用带唯一查询串的地址） */
  importUrl: (url: string) => Promise<unknown>
  /** Resource Timing 与当前页面的源，读模块图证据用；测试可以不给（等于看不出） */
  resources?: () => readonly ResourceTimingLike[]
  pageOrigin?: string
}

function defaultRetryEnv(): RetryEnv {
  let pageOrigin = ''
  try {
    pageOrigin = typeof location === 'undefined' ? '' : location.origin
  } catch { /* 拿不到就只认同源以外看不出 */ }
  return {
    resources: readResourceTimings,
    pageOrigin,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    online: () => {
      try {
        return typeof navigator === 'undefined' || navigator.onLine !== false
      } catch {
        return true
      }
    },
    waitOnline: (maxMs) => new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        clearTimeout(timer)
        window.removeEventListener('online', done)
        resolve()
      }
      timer = setTimeout(done, maxMs)
      window.addEventListener('online', done)
    }),
    importUrl: (url) => import(/* @vite-ignore */ url),
  }
}

/**
 * 带查询串的 chunk 地址：与入口同目录（chunk 之间都是 `./x.js` 相对引用，查询串不会传给它的依赖，
 * 依赖仍按原地址命中同一个模块实例，不会出现两份 React）。
 */
export function bustedChunkUrl(file: string, base: string, nonce: string): string | null {
  if (!/^[\w.-]+\.js$/.test(file) || !base) return null
  try {
    const url = new URL(`./${file}`, base)
    url.searchParams.set('chunk-retry', nonce)
    return url.href
  } catch {
    return null
  }
}

/**
 * 懒加载就地重试（2026-11-16 诊断包 #872：iOS Safari《拳皇2001》详情页 GameDetailPage chunk
 * `Importing a module script failed`，紧接着修复脚本也在 1ms 内加载失败。现场没有 HTTP 状态、响应体、
 * Resource Timing 或 navigator.onLine，能确认的是两次资源请求都没完成；短暂断网只是可能原因，具体网络层未知。
 * 旧页面遇到第一次懒加载失败就进错误边界并刷新一次；如果资源链路还没恢复，第二次也会失败停在兜底页。
 *
 * 现在先在页面里重试：网络型错误可能被浏览器模块表按原 URL 缓存为失败，重复调用原加载函数只会得到同一个拒绝；
 * 因此每次重试都换唯一查询串，让浏览器和边缘重新取入口 chunk。静态依赖仍保持原 URL 和同一个 React 实例；
 * 如果失败在静态依赖，asset-repair 会按构建依赖图核对它，再刷新页面清掉失败模块表。明确离线时先等恢复联网。
 * 全部失败才把最后一个错误抛给错误边界（那里还有修复脚本和整页刷新）。
 *
 * 2026-11-19：第一次失败后先看模块图证据（importGraphEvidence）。入口已经完整下载、失败在静态依赖时，
 * 换查询串重试入口必然拿到同一个被记住的失败（Chromium 153 / WebKit 26.6 实测），不再白下两遍入口，直接交给错误边界。
 * 证据挂在错误上，兜底页写进诊断包、把失败的依赖点名交给修复脚本。
 */
export async function importWithRetry<T>(
  load: () => Promise<T>,
  file: string | null,
  base: string,
  env: RetryEnv = defaultRetryEnv(),
): Promise<T> {
  let lastError: unknown
  let retryFile = file
  // 上一次是预加载助手暖缓存失败（模块表还干净）：再走一遍原加载函数，让助手重新暖缓存
  let viaLoad = false
  let checkedGraph = false
  const attempts = LAZY_RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      if (!env.online()) await env.waitOnline(OFFLINE_WAIT_MS)
      else await env.sleep(LAZY_RETRY_DELAYS_MS[attempt - 1])
    }
    try {
      const busted = attempt > 0 && retryFile && !viaLoad
        ? bustedChunkUrl(retryFile, base, nextChunkRetryNonce(attempt))
        : null
      const loaded = busted ? await (env.importUrl(busted) as Promise<T>) : await load()
      notifyChunkLoaded(file)
      return loaded
    } catch (error) {
      lastError = error
      if (!retryableImportError(error)) break
      const warmFailure = preloadFailure(error)
      viaLoad = Boolean(warmFailure)
      if (warmFailure) {
        tagImportEvidence(error, { top: 'preload', failed: warmFailure.failed })
        continue
      }
      // 模块加载器那一层的失败（第一次见到时）：看是入口还是依赖。依赖失败被模块表记住，换查询串重试入口没用
      if (!checkedGraph && file && env.resources) {
        checkedGraph = true
        const evidence = importGraphEvidence(file, base, error, env.resources(), env.pageOrigin ?? '')
        tagImportEvidence(error, evidence)
        if (evidence.top === 'ok') break
      }
      // SystemJS 把加载失败统一包装成一条错误，但其中仍带着真实失败的 legacy chunk URL。
      // 从这里补出文件名后，下一次用 System.import 的带查询串 URL，避开失败模块的缓存键。
      retryFile ??= failedLegacyChunkFile(error)
    }
  }
  throw lastError
}
