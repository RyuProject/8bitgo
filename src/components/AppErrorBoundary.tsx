import { Component, type ErrorInfo, type ReactNode } from 'react'

const CHUNK_RELOAD_PREFIX = '8bitgo.chunk-reload:'
const CHUNK_RELOAD_COOLDOWN_MS = 60_000

/**
 * 部署刚切换时，旧页面可能还握着上一版 chunk 文件名：点一次站内链接就会下载 404。
 * 这类错误整页刷新通常能拿到新 HTML，所以自动自救一次；一分钟内仍失败就停下来画兜底，
 * 不能用无限刷新把真正的发布故障藏起来。
 */
function recoverStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (!/Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed/i.test(message)) {
    return false
  }

  try {
    const key = `${CHUNK_RELOAD_PREFIX}${location.pathname}`
    const previous = Number(sessionStorage.getItem(key) || 0)
    const now = Date.now()
    if (now - previous < CHUNK_RELOAD_COOLDOWN_MS) return false
    sessionStorage.setItem(key, String(now))
    location.reload()
    return true
  } catch {
    return false
  }
}

interface AppErrorBoundaryState {
  failed: boolean
}

/**
 * 最外层兜底。
 *
 * 路由页都是懒加载的，任何一次 chunk 下载失败或组件渲染异常如果没人接住，React 会卸载
 * 整个根节点，玩家只剩一张白页。这里刻意不依赖路由和翻译 Context：它们本身坏掉时，
 * 这张最后的错误页也必须能画出来。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[8bitgo] 页面渲染失败', error, info.componentStack)
    recoverStaleChunk(error)
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
              className="inline-flex h-11 items-center justify-center rounded-2xl bg-brand px-5 text-sm font-bold text-white shadow-[0_4px_0_0_var(--color-brand-shadow)] transition-[transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 active:translate-y-[3px] active:shadow-none"
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
        </section>
      </main>
    )
  }
}
