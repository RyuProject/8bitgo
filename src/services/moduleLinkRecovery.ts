/**
 * React 侧接入「坏 chunk 自修复」（public/assets/asset-repair-v4.js）。
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
 * 生产构建里 `lazyNamed(() => import('@/pages/GameDetailPage'), …)` 编出来是
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
  const hit = /import\(\s*[`'"]\.\/([\w.-]+\.js)[`'"]\s*\)/.exec(source)
  return hit ? hit[1] : null
}

/** 懒加载失败时把 chunk 文件名挂在错误对象上（React 会把同一个对象交给错误边界） */
export function tagLazyFailure(error: unknown, file: string | null, name: string): void {
  if (!error || typeof error !== 'object') return
  try {
    Object.defineProperty(error, LAZY_FAILURE, { value: { file, name }, configurable: true })
  } catch {
    /* 冻结的错误对象：拿不到点名，修复脚本仍会按 Resource Timing 核对 */
  }
}

export function lazyFailure(error: unknown): { file: string | null; name: string } | null {
  if (!error || typeof error !== 'object') return null
  const tag = (error as Record<string, unknown>)[LAZY_FAILURE] as { file: string | null; name: string } | undefined
  return tag && typeof tag.name === 'string' ? tag : null
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

/** 与 public/assets/asset-repair-v4.js 的返回值一致（新字段在旧脚本里没有，所以是可选的） */
export interface AssetRepairResult {
  manifest: boolean
  checked: number
  ok: number
  /** 浏览器缓存里那份坏了，绕过缓存重取后对上了 */
  repaired: string[]
  /** 错误点名的文件，缓存里那份看着没问题，仍强制重取覆盖了一遍 */
  refreshed: string[]
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
  return Boolean(result && result.repaired.length + result.refreshed.length + result.remapped.length + (result.recovered?.length ?? 0) > 0)
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
  if (result.remapped.length) parts.push(`普通地址异常、查询串回源正常，已改走回源地址并请求清缓存：${list(result.remapped)}`)
  if (result.edgeOnly?.length) parts.push(`大陆加速入口取不下来、主站正常：${list(result.edgeOnly)}`)
  if (result.bad.length) parts.push(`回源也对不上：${list(result.bad)}`)
  if (result.failed.length) parts.push(`取不下来：${list(result.failed)}`)
  if (result.trace?.length) parts.push(`经过：${result.trace.slice(0, 3).join('｜')}`)
  parts.push(`${result.ms}ms`)
  return parts.join('；')
}

/* ---------- 懒加载就地重试 ---------- */

/**
 * 网络层导入失败（chunk 取不下来）才值得重试；SyntaxError（字节坏了、缺导出）重试同一份缓存没用，交给修复脚本。
 * 措辞覆盖 Chrome（Failed to fetch dynamically imported module）、Firefox（error loading dynamically imported module）、
 * Safari（Importing a module script failed）。
 */
const RETRYABLE_IMPORT = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|Unable to preload|NetworkError|Load failed/i

export function retryableImportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { name?: unknown; message?: unknown }
  if (err.name === 'SyntaxError') return false
  return RETRYABLE_IMPORT.test(`${String(err.name ?? '')}: ${String(err.message ?? '')}`)
}

/** 重试间隔：第二次立刻小退避，第三次换带查询串的地址（绕开浏览器 / 边缘按 URL 记住的失败）。 */
export const LAZY_RETRY_DELAYS_MS: readonly number[] = [500, 1800]
/** 离线时最多等多久「恢复联网」再重试；等不到也照样试一次，交给错误边界。 */
const OFFLINE_WAIT_MS = 20_000

export interface RetryEnv {
  sleep: (ms: number) => Promise<void>
  /** 浏览器明确报告离线时，等 online 事件（或超时） */
  waitOnline: (maxMs: number) => Promise<void>
  online: () => boolean
  /** 按 URL 导入（第三次尝试用带查询串的地址） */
  importUrl: (url: string) => Promise<unknown>
}

function defaultRetryEnv(): RetryEnv {
  return {
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
 * `Importing a module script failed`，紧接着同主机的修复脚本 1ms 就加载失败 —— 那一刻整台设备连不上网，
 * 页面本身来自缓存）。以前懒加载一失败就直接进错误边界、刷新一次，网络还没恢复，第二次照样失败停在兜底页。
 *
 * 现在先在页面里重试：小退避后再调一次原加载函数（它连同 CSS / 依赖预加载一起重走）；仍失败就换带查询串的地址，
 * 绕开浏览器模块表、HTTP 缓存或边缘按完整 URL 记住的失败。浏览器明确报告离线时先等恢复联网再试。
 * 全部失败才把最后一个错误抛给错误边界（那里还有修复脚本和整页刷新）。
 */
export async function importWithRetry<T>(
  load: () => Promise<T>,
  file: string | null,
  base: string,
  env: RetryEnv = defaultRetryEnv(),
): Promise<T> {
  let lastError: unknown
  const attempts = LAZY_RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      if (!env.online()) await env.waitOnline(OFFLINE_WAIT_MS)
      else await env.sleep(LAZY_RETRY_DELAYS_MS[attempt - 1])
    }
    try {
      const busted = attempt === attempts - 1 && file
        ? bustedChunkUrl(file, base, `${Date.now().toString(36)}${attempt}`)
        : null
      return busted ? await (env.importUrl(busted) as Promise<T>) : await load()
    } catch (error) {
      lastError = error
      if (!retryableImportError(error)) break
    }
  }
  throw lastError
}
