import { Component, type ErrorInfo, type ReactNode } from 'react'
import { newStartupId, recordStartupEvent } from '@/services/startupFunnel'
import { collectStartupDiagnostics, noteStartupEvent, type StartupRecovery } from '@/services/startupDiagnostics'
import {
  assetsFromCnEdge,
  describeImportEvidence,
  failedLegacyChunkFile,
  isSystemJsChunkLoadError,
  lazyFailure,
  moduleLinkFailure,
  onOriginAssetsPage,
  originAssetsUrl,
  repairAssets,
  repairFixedSomething,
  repairLoadInfo,
  resolveChunkUrl,
  summarizeRepair,
} from '@/services/moduleLinkRecovery'
import { deferRecoveryReport, takeRecoveryForFailure, type PendingReport } from '@/services/pageRecovery'

const CHUNK_RELOAD_PREFIX = '8bitgo.chunk-reload:'
const ORIGIN_RELOAD_PREFIX = '8bitgo.chunk-origin-reload:'
const CHUNK_RELOAD_COOLDOWN_MS = 60_000

/**
 * 部署刚切换时，旧页面可能还握着上一版 chunk 文件名：点一次站内链接就会下载 404。
 * 这类错误整页刷新通常能拿到新 HTML，所以自动自救一次；一分钟内仍失败就停下来画兜底，
 * 不能用无限刷新把真正的发布故障藏起来。
 */
const STALE_CHUNK = /Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed/i

/** 一分钟内同一页每种自动刷新只做一次，防止真正的发布故障被无限刷新藏起来。 */
function claimReload(prefix: string): boolean {
  try {
    const key = `${prefix}${location.pathname}`
    const previous = Number(sessionStorage.getItem(key) || 0)
    const now = Date.now()
    if (now - previous < CHUNK_RELOAD_COOLDOWN_MS) return false
    sessionStorage.setItem(key, String(now))
    return true
  } catch {
    return false
  }
}

function browserOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  } catch {
    return false
  }
}

function reloadWhenOnline(): void {
  const reload = () => {
    if (onOriginAssetsPage()) location.replace(originAssetsUrl(location))
    else location.reload()
  }
  window.addEventListener('online', reload, { once: true })
}

/** 刷新这一页。退到主站资源之后再刷新也留在主站：普通 reload 会回到地址栏里那份（已去掉参数的）EdgeOne 页面 */
function reloadPage(): void {
  if (onOriginAssetsPage()) location.replace(originAssetsUrl(location))
  else location.reload()
}

function toOriginAssets(): void {
  location.replace(originAssetsUrl(location))
}

/**
 * 入口在大陆加速入口（cn.<裸域>/_cn/assets/）上时，改用主站资源整页重新载入。
 *
 * 懒加载 chunk 按「相对引用方」解析（vite.config.ts 的 renderBuiltUrl），入口从 EdgeOne 来，整张模块图就都在 EdgeOne 上；
 * 入口脚本有 onerror 退回主站，懒加载 chunk 没有。也不能只把失败的那个文件换到主站：页面 chunk 会反过来 import
 * 入口（`./index-<哈希>.js`），换了目录的 chunk 会按主站地址再拉一份入口，入口重复执行、React 出现两份。
 * 所以带 `__assets=origin` 整页重新载入，服务端这次吐一份全部指向主站的 HTML（shared/cover-cdn-hint.js）。
 */
function claimOriginReload(edge: boolean): boolean {
  return edge && claimReload(ORIGIN_RELOAD_PREFIX)
}

/** 上一份文档自动刷新过、这一份又崩了：从 pageRecovery 接过来的前情 */
type PreviousAttempt = ReturnType<typeof takeRecoveryForFailure>

/** 这次故障的一句话：再坏一次时写进报告（「刷新前：…」） */
function incidentSummary(error: unknown, note: string): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return [message.slice(0, 140), note.slice(0, 150)].filter(Boolean).join('；')
}

/**
 * 要自动刷新时调用：报告留到刷新后的新页面再发（好了记 `recovered`，又坏了并进那一份；见 services/pageRecovery.ts）。
 * 2026-11-19 以前这里是「先上报再刷新」，刷新后好了的也记成一份「加载失败」，和停在兜底页的真故障混在一组。
 * sessionStorage 存不进去时退回原来的做法：先报，现场不能丢。
 */
function deferThenNavigate(
  error: unknown,
  info: ErrorInfo,
  note: string,
  via: 'reload' | 'origin',
  file: string | null,
  previous: PreviousAttempt,
  navigate: () => void,
): void {
  const fullNote = withPrevious(note, previous)
  const report = buildCrashReport(error, info, fullNote)
  if (!deferRecoveryReport({ file, via, summary: incidentSummary(error, fullNote), report }) && report) sendCrashReport(report)
  navigate()
}

/**
 * 以前就不上报的静默刷新（部署切换的旧 chunk、没查出坏文件的偶发失败）：好了照旧什么都不发，
 * 只把前情留给刷新后的页面 —— 再崩一次时，那份报告能写出「这已经是自动刷新之后」。
 */
function silentReload(error: unknown, file: string | null, previous: PreviousAttempt, note = ''): boolean {
  if (!claimReload(CHUNK_RELOAD_PREFIX)) return false
  deferRecoveryReport({ file, via: 'reload', summary: incidentSummary(error, withPrevious(note, previous)), report: null })
  reloadPage()
  return true
}

function withPrevious(note: string, previous: PreviousAttempt): string {
  if (!previous) return note
  return [note, `自动刷新后再次失败（刷新前：${previous.summary.slice(0, 200)}）`].filter(Boolean).join('；')
}

/**
 * chunk 没加载上（404 / 网络 / HTTP 错误）或者加载上了却解析 / 链接失败（字节坏了，2026-11-15 PK / TH 的
 * `does not provide an export named`）：先让 public/assets/asset-repair-v7.js 按构建时的 SHA-256 清单核对依赖图
 * 用过的 chunk，坏的绕过缓存重取 —— 普通刷新只会从一年 immutable 的缓存里拿回同一份坏字节。
 *
 * 2026-11-16 诊断包 #761（微信 iOS，cn.8bitgo.com/_cn/assets/ 上懒加载 GameDetailPage 报
 * `Importing a module script failed`，自动刷新后再失败）之后：
 * - Safari 这句错误不带地址，懒加载失败的 chunk 由 lazyNamed 挂在错误上，作为点名文件交给修复脚本；
 * - 大陆加速入口取不下来、主站正常（edgeOnly）：改用主站资源整页重新载入；
 * - 修好了（缓存坏副本 / 偶发取不下来 / 文件正常、失败在本页模块表里）：刷新一次；
 * - 若被点名的懒加载 chunk 在 EdgeOne 上字节已校验正确、强制重取后仍无法动态导入，直接改用主站资源整页重载；
 *   这表示文件内容本身没坏，继续刷新同一资源域可能重复遇到浏览器 / 边缘链路问题（诊断包 #951）；
 * - 没发现坏文件、但这是 404 那类旧 chunk：照旧刷新一次，不算故障；一分钟内又坏了，在加速入口上就换主站再试一次；
 * - 其余：上报，停在兜底页。
 * 2026-11-19 起，要自动刷新的那几种不再「先上报」，由刷新后的页面补报结论（deferThenNavigate）。
 * 修复脚本是首页内联钩子按需加载的；钩子不在（旧模板）时退回原来的行为。
 */
function recoverBrokenAsset(error: unknown, info: ErrorInfo, previous: PreviousAttempt): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const stale = STALE_CHUNK.test(message) || isSystemJsChunkLoadError(error)
  const syntax = error instanceof Error && error.name === 'SyntaxError'
  if (!stale && !syntax) return false
  // 设备明确报告离线时，核对、刷新只会再失败一次，还会白白用掉一分钟一次的自动刷新。
  // 诊断包 #872 的 chunk 和修复脚本都在 1ms 内失败，但现场没有记录 onLine 状态，不能据此断言设备离线。
  // 等浏览器报告恢复联网再刷新，不算故障、不上报。
  if (stale && browserOffline()) {
    reloadWhenOnline()
    return true
  }
  const entrySrc = currentEntrySrc()
  const failure = moduleLinkFailure(message)
  const lazy = lazyFailure(error)
  const chunk = lazy?.file ?? failedLegacyChunkFile(error)
  const graph = describeImportEvidence(lazy?.graph)
  // integrity 清单只含现代 ES 产物；legacy 走 SystemJS，不能拿现代文件的清单声称旧 chunk 正常。
  // 能从 SystemJS 错误里取到文件名时，懒加载层已用两个唯一查询串重试；仍失败先整页刷新，重复失败再切主站资源。
  if (isSystemJsChunkLoadError(error) || lazy?.file?.includes('-legacy-')) {
    if (silentReload(error, chunk, previous, graph)) return true
    const edge = assetsFromCnEdge(entrySrc, location.origin)
    if (claimOriginReload(edge)) {
      const note = [`legacy 页面脚本${chunk ? ` ${chunk}` : ''}重复加载失败，已改用主站资源重新载入`, graph].filter(Boolean).join('；')
      deferThenNavigate(error, info, note, 'origin', chunk, previous, toOriginAssets)
      return true
    }
    return false
  }
  // 证据里点名失败的依赖也交给修复脚本：强制重取一遍，顺带把这几个文件写回浏览器缓存
  const named = [
    failure?.specifier ? resolveChunkUrl(failure.specifier, entrySrc) : null,
    lazy?.file ? resolveChunkUrl(`./${lazy.file}`, entrySrc) : null,
    ...(lazy?.graph?.failed ?? []).map((dep) => resolveChunkUrl(`./${dep}`, entrySrc)),
  ].filter((url): url is string => Boolean(url))
  const pending = repairAssets({ reason: message.slice(0, 300), urls: named })
  if (!pending) return stale ? silentReload(error, chunk, previous, graph) : false
  void pending.then((result) => {
    const note = [lazy ? `懒加载：${lazy.file ?? lazy.name}` : '', graph, summarizeRepair(result, repairLoadInfo())]
      .filter(Boolean).join('；')
    const edge = stale && assetsFromCnEdge(entrySrc, location.origin)
    if (edge && result?.edgeOnly?.length && claimOriginReload(edge)) {
      deferThenNavigate(error, info, `${note}；已改用主站资源重新载入`, 'origin', chunk, previous, toOriginAssets)
      return
    }
    // #951：文件 SHA-256 正确但模块加载仍失败时，同一 EdgeOne 地址重载无法改变响应链路；整页换主站资源。
    if (edge && lazy?.file && result?.refreshed.includes(lazy.file) && claimOriginReload(edge)) {
      deferThenNavigate(error, info, `${note}；模块内容校验正常但导入仍失败，已改用主站资源重新载入`, 'origin', chunk, previous, toOriginAssets)
      return
    }
    if (repairFixedSomething(result)) {
      if (claimReload(CHUNK_RELOAD_PREFIX)) {
        deferThenNavigate(error, info, note, 'reload', chunk, previous, reloadPage)
        return
      }
      if (claimOriginReload(edge)) {
        deferThenNavigate(error, info, `${note}；刷新后仍失败，已改用主站资源重新载入`, 'origin', chunk, previous, toOriginAssets)
        return
      }
      reportRenderCrash(error, info, note, previous)
      return
    }
    if (stale && silentReload(error, chunk, previous, note)) return
    if (claimOriginReload(edge)) {
      deferThenNavigate(error, info, `${note}；刷新后仍失败，已改用主站资源重新载入`, 'origin', chunk, previous, toOriginAssets)
      return
    }
    reportRenderCrash(error, info, note, previous)
  })
  return true
}

interface AppErrorBoundaryState {
  failed: boolean
  /** 给人看的错误摘要：错误原文 + 前几帧调用栈 + 浏览器 / 版本。玩家截图反馈时才知道是哪里坏了 */
  detail: string
}

/**
 * 拼「技术细节」那一段。
 *
 * 2026-11-15 有人在 Android 模拟器里打开《拳皇97》详情页只看到「页面暂时没有正常打开」，同一页在
 * 桌面 Chromium、Android 16 模拟器的 Chrome 134（中英文、点开始）都复现不出来 —— 而这张兜底页把错误
 * 原文整个吞掉了，只能猜。现在把它摆出来（折叠着，不吓人），截图就能定位。
 * 只放错误本身、浏览器 UA 和前端版本，不放地址参数、账号或存档之类的东西。
 */
export function describeRenderError(error: unknown, ua = '', build = ''): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const frames = error instanceof Error && typeof error.stack === 'string'
    ? error.stack.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ') || l.includes('@')).slice(0, 4)
    : []
  return [head.slice(0, 400), ...frames.map((f) => f.slice(0, 200)), ua && `UA: ${ua.slice(0, 200)}`, build && `build: ${build}`]
    .filter(Boolean)
    .join('\n')
}

/**
 * 拼一份「页面崩溃」报告：错误原文、组件栈、修复结论，以及此刻的诊断包（环境、页面打开以来慢 / 失败的请求、日志）。
 * 只在 /games/<slug> 上有：漏斗按游戏记账，别的页面没有挂靠的游戏。
 * 诊断包现在就采：要刷新的那几种会把它存进 sessionStorage，刷新后的页面看不到这一页的请求和日志。
 */
function buildCrashReport(error: unknown, info: ErrorInfo, note = '', recovery?: StartupRecovery): PendingReport | null {
  try {
    const slug = location.pathname.match(/(?:^|\/)games\/([^/?#]+)/)?.[1]
    if (!slug) return null
    const components = String(info.componentStack ?? '')
      .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' < ')
    const detail = [describeRenderError(error), components && `组件：${components}`, note, `build: ${currentBuild()}`]
      .filter(Boolean).join('\n')
    const visitId = newStartupId()
    const attemptId = newStartupId()
    noteStartupEvent(visitId, attemptId, 'failed')
    const diagnostics = collectStartupDiagnostics(attemptId, detail, { resourcesSincePageStart: true })
    return {
      slug: decodeURIComponent(slug),
      visitId,
      attemptId,
      detail,
      diagnostics: diagnostics && recovery ? { ...diagnostics, recovery } : diagnostics,
    }
  } catch {
    return null
  }
}

function sendCrashReport(report: PendingReport): void {
  recordStartupEvent(report.slug, {
    visitId: report.visitId,
    attemptId: report.attemptId,
    event: 'failed',
    runtime: 'page',
    platform: '',
    detail: report.detail,
    diagnostics: report.diagnostics ?? undefined,
  })
}

/**
 * 游戏详情页上的渲染崩溃按一次「启动失败」上报（运行时记 `page`），后台「错误诊断」按错误原文归组。
 *
 * 2026-11-15 有人在 Android 模拟器（Chrome 110）里打开《拳皇97》只看到兜底页；同一页在 Chromium 110、
 * Chrome 134 的 Android 模拟器、强制 legacy 包里都打得开、能开局，猜不出来。这张页面以前只往本机控制台
 * 打一行，谁也看不到。现在玩家不用截图，下一次出现就能在后台看到错误原文、组件栈和粗粒度浏览器信息
 * （服务端只存「Chrome 110 / Android 15」，不存完整 UA；地址参数、账号、存档都不上报）。
 * 上一份文档自动刷新过（previous）：这就是刷新之后又失败，诊断包标 failed_again，后台和第一次就失败的分开。
 */
function reportRenderCrash(error: unknown, info: ErrorInfo, note = '', previous: PreviousAttempt = null): void {
  try {
    const recovery: StartupRecovery | undefined = previous
      ? { outcome: 'failed_again', via: previous.via, afterMs: previous.afterMs, previous: previous.summary.slice(0, 200) }
      : undefined
    const report = buildCrashReport(error, info, withPrevious(note, previous), recovery)
    if (report) sendCrashReport(report)
  } catch {
    /* 上报本身出错也不能影响兜底页 */
  }
}

function currentEntrySrc(): string {
  try {
    return document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src ?? ''
  } catch {
    return ''
  }
}

function currentBuild(): string {
  return currentEntrySrc().split('/').pop() ?? ''
}

/**
 * 最外层兜底。
 *
 * 路由页都是懒加载的，任何一次 chunk 下载失败或组件渲染异常如果没人接住，React 会卸载
 * 整个根节点，玩家只剩一张白页。这里刻意不依赖路由和翻译 Context：它们本身坏掉时，
 * 这张最后的错误页也必须能画出来。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false, detail: '' }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    let ua = ''
    try { ua = navigator.userAgent } catch { /* 拿不到就不写 */ }
    return { failed: true, detail: describeRenderError(error, ua, currentBuild()) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[8bitgo] 页面渲染失败', error, info.componentStack)
    // 部署切换的旧 chunk 会自动刷新自救，不算故障；其余情况把现场送进后台「错误诊断」
    // chunk 下载失败 / 字节坏了：先核对修复，再按结果决定刷新还是上报（异步，自己负责上报）
    // 上一份文档是自动刷新过来的：接过前情，这次的报告写明「自动刷新后再次失败」（services/pageRecovery.ts）
    const previous = takeRecoveryForFailure()
    if (!recoverBrokenAsset(error, info, previous)) reportRenderCrash(error, info, '', previous)
  }

  render() {
    if (!this.state.failed) return this.props.children

    const chinese = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('zh')
    const languagePrefix = typeof location !== 'undefined'
      ? location.pathname.match(/^\/(zh-Hant|en|es|fr|it|de|ja)(?:\/|$)/)?.[1]
      : undefined
    const homeHref = languagePrefix ? `/${languagePrefix}/` : '/'
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-5 py-12 text-fg" role="alert">
        <section className="w-full max-w-lg rounded-card border border-line bg-surface p-6 text-center shadow-xl shadow-black/5 sm:p-8">
          <span className="text-5xl" aria-hidden>🛠️</span>
          <h1 className="mt-5 text-2xl font-extrabold tracking-tight">
            {chinese ? '页面暂时没有正常打开' : 'This page did not open correctly'}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
            {chinese
              ? '你的存档和账号数据没有受到影响。重新载入通常可以恢复；如果仍然失败，可以先回到首页。'
              : 'Your saves and account data are safe. Reloading usually fixes this; otherwise, return to the home page.'}
          </p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => location.reload()}
              className="green-action inline-flex h-11 items-center justify-center px-5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2"
            >
              {chinese ? '重新载入' : 'Reload'}
            </button>
            <a
              href={homeHref}
              className="inline-flex h-11 items-center justify-center rounded-2xl border-2 border-line-strong bg-surface px-5 text-sm font-bold shadow-[0_4px_0_0_var(--color-line-strong)] transition-[transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 active:translate-y-[3px] active:shadow-none"
            >
              {chinese ? '回到首页' : 'Back to home'}
            </a>
          </div>
          {this.state.detail && (
            <details className="mt-6 text-left">
              <summary className="cursor-pointer text-xs font-semibold text-muted">
                {chinese ? '技术细节（反馈问题时请截图这一段）' : 'Technical details (screenshot this when reporting)'}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-3 text-[11px] leading-snug text-muted">
                {this.state.detail}
              </pre>
            </details>
          )}
        </section>
      </main>
    )
  }
}
