/**
 * 翻译按钮：游戏简介右上角，点一下用火山引擎把简介翻成当前 UI 语言并缓存。
 *
 * ── 触发位置 ────────────────────────────────────────────────
 * 挂游戏详情页「游戏简介」h2 旁边，和 h2 在同一行 flex 布局。
 * 出现条件 = 当前语言不是 zh-Hans / en，且这一语言的简介没翻译过（见 i18nData.needsTranslation）。
 * 这是「按需」而非「自动」—— 一个语种永远只翻译一次，缓存命中后接口秒回。
 *
 * ── 状态机 ────────────────────────────────────────────────
 *   idle        → 显示「翻译」按钮（描边样式，与「展开全文」区分明显）
 *   translating → loading，禁用按钮，按钮文案变成「翻译中…」
 *   translated  → 闪一下「✓ 已翻译」反馈（1.5s），然后按钮整体消失
 *   error       → 显示「翻译失败」+ 重试（失败文案由后端 error 字段给出）
 *
 * ── 副作用 ────────────────────────────────────────────────
 * 翻译成功后调 onTranslated(text)。父组件（GameDetailPage）把这段文字覆盖到简介组件上，
 * 不去刷新整个 game 对象 —— 30 字的局部 setState 既便宜也不会影响页面其它部分
 * （评论数、相关推荐之类都是独立的）。
 */
import { useState } from 'react'
import type { Game } from '@/types'
import { useT } from '@/services/i18n'
import { useLang } from '@/services/lang'
import type { Lang } from '@/config/languages'
import { api, apiEnabled, ApiError } from '@/services/api'

type Status = 'idle' | 'translating' | 'translated' | 'error'

interface Props {
  game: Game
  /**
   * 翻译完成回调：把这段文字塞回简介组件，覆盖原值。
   * 即使这次是从缓存直接返回（cached: true），也会调一次 —— 父组件的覆盖状态
   * 才是简介真正显示的内容，绕过它就只是骗 React 一次渲染。
   */
  onTranslated: (text: string) => void
  /** 当前 UI 语言 —— 通常页面里 useLang() 拿到 */
  lang?: Lang
}

export function TranslateButton({ game, onTranslated, lang: langProp }: Props) {
  const t = useT()
  const ctxLang = useLang()
  const lang = langProp ?? ctxLang
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')

  async function startTranslate() {
    if (!apiEnabled()) return
    setStatus('translating')
    setErrorMsg('')
    try {
      const r = await api.post<{ lang: string; text: string; cached: boolean }>(
        `/api/games/${encodeURIComponent(game.slug)}/translate-description`,
        { lang },
      )
      onTranslated(r.text)
      setStatus('translated')
      // 闪一下反馈后让按钮淡出 —— 父组件会因为 needsTranslation() 改成 false
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
