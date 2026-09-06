/**
 * 翻译按钮：游戏简介 / 文章正文右上角，点一下用火山引擎把内容翻成当前 UI 语言并缓存。
 *
 * ── 这是通用组件 ──────────────────────────────────────────
 * 游戏和文章共用它。差异只在两处：
 *   1. endpoint  —— 调哪个接口（游戏 `/api/games/<slug>/translate-description`、
 *                   文章 `/api/posts/<slug>/translate`）
 *   2. onTranslated —— 后端返回什么就交给父组件什么（游戏是 { text }，文章是 { excerpt, content }），
 *      父组件自己决定覆盖哪块 state，组件本身不关心被翻译的是简介还是正文
 *
 * 出现条件交给父组件的 `show` / 外层条件渲染控（游戏用 needsTranslation()、文章用
 * needsPostTranslation()）—— 接口「按需」特性：一个语种永远只翻译一次，缓存命中后秒回。
 *
 * ── 状态机 ────────────────────────────────────────────────
 *   idle        → 显示「翻译」按钮（描边样式，与「展开全文」区分明显）
 *   translating → loading，禁用按钮，按钮文案变成「翻译中…」
 *   translated  → 闪一下「✓ 已翻译」反馈（1.5s），然后按钮整体消失
 *   error       → 显示「翻译失败」+ 重试（失败文案由后端 error 字段给出）
 *
 * ── 副作用 ────────────────────────────────────────────────
 * 翻译成功后调 onTranslated(data)。父组件把 data 里的内容覆盖到对应显示块上，
 * 不去刷新整个对象 —— 几十字的局部 setState 既便宜也不影响页面其它部分
 * （评论数、相关推荐之类都是独立的）。
 */
import { useState } from 'react'
import { useT } from '@/services/i18n'
import { useLang } from '@/services/lang'
import type { Lang } from '@/config/languages'
import { api, apiEnabled, ApiError } from '@/services/api'

type Status = 'idle' | 'translating' | 'translated' | 'error'

interface Props<T> {
  /** 翻译接口路径。例如 `/api/games/<slug>/translate-description` 或 `/api/posts/<slug>/translate` */
  endpoint: string
  /**
   * 翻译完成回调：把后端返回的完整响应交给父组件。
   * 即使这次是从缓存直接返回（cached: true），也会调一次 —— 父组件的覆盖状态
   * 才是真正显示的内容，绕过它就只是骗 React 一次渲染。
   * 游戏侧通常 `(r) => setTranslatedDescription(r.text)`，
   * 文章侧通常 `(r) => { setExcerpt(r.excerpt); setContent(r.content) }`。
   */
  onTranslated: (data: T) => void
  /** 是否显示按钮：默认 true。游戏用 needsTranslation()、文章用 needsPostTranslation() 算好后传进来 */
  show?: boolean
  /** 当前 UI 语言 —— 通常页面里 useLang() 拿到 */
  lang?: Lang
}

// 不限 T 的形状：游戏返回 { text }、文章返回 { excerpt, content }，都不强制带 lang 字段
export function TranslateButton<T>({ endpoint, onTranslated, show = true, lang: langProp }: Props<T>) {
  const t = useT()
  const ctxLang = useLang()
  const lang = langProp ?? ctxLang
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')

  if (!show) return null

  async function startTranslate() {
    if (!apiEnabled()) return
    setStatus('translating')
    setErrorMsg('')
    try {
      const r = await api.post<T>(endpoint, { lang })
      onTranslated(r)
      setStatus('translated')
      // 闪一下反馈后让按钮淡出 —— 父组件会因为 show 改成 false
      // 而在下次渲染时不再挂这个按钮，但 1.5s 留个「✓ 已翻译」的视觉过渡，
      // 否则玩家会怀疑刚才那次点击没生效
      setTimeout(() => setStatus('idle'), 1500)
    } catch (e) {
      // api.ts 已经把后端 error 字段塞进了 ApiError.message（见 ApiError 构造里的 msg 选取）。
      // 用 message + status 两份信息一起显示：503 一眼能看出是没配服务，
      // 502 是上游问题，4xx 是请求不对 —— 不要统一糊一句「网络错误」
      const status = e instanceof ApiError ? e.status : 0
      const msg = e instanceof Error ? e.message : String(e)
      setErrorMsg(status ? `[${status}] ${msg}` : msg)
      setStatus('error')
    }
  }

  // 「✓ 已翻译」闪完一次后让父组件再决定要不要展示按钮
  // （此时 needsTranslation() 已经返回 false 了，外层不会再挂它）
  if (status === 'translated') {
    return (
      <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400" role="status">
        ✓ {t.game.translatedJustNow}
      </span>
    )
  }

  // loading 态 + 错误态都要占同样大的位置，避免按钮文字变长把 h2 挤歪
  const label =
    status === 'translating'
      ? t.game.translating
      : status === 'error'
        ? t.game.translateRetry
        : t.game.translate

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={startTranslate}
        disabled={status === 'translating'}
        // 颜色明显（和「展开全文」区分开），但不喧宾夺主 —— 玩家不点也完全可以看英文原文
        className="rounded-full border border-brand/60 bg-brand/5 px-3 py-1 text-xs font-semibold text-brand transition hover:bg-brand hover:text-white disabled:cursor-wait disabled:opacity-60"
      >
        {status === 'translating' ? <span className="inline-block animate-pulse">{label}</span> : label}
      </button>
      {status === 'error' && errorMsg && (
        <p className="max-w-[16rem] text-right text-[11px] leading-snug text-red-600 dark:text-red-400" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  )
}
