import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'
import { completeWeiboLogin, takeWeiboReturnTo } from '@/services/auth'

/**
 * 微博授权回调页（/auth/weibo/callback）。
 *
 * 这个路径就是微博开放平台里填的「授权回调页」，必须和后端 WEIBO_REDIRECT_URI
 * 一字不差 —— 三处（开放平台后台 / 后端 .env / 这个路由）任意一处不一致，
 * 微博都会直接拒绝，报 redirect_uri_mismatch。
 *
 * 页面本身只做三件事：核对 state、拿 code 换本站 JWT、把人送回授权前的那一页。
 * 成功时走整页跳转而不是 navigate()：语言前缀是 BrowserRouter 的 basename，
 * 而回调地址是没有前缀的（微博只认一个），只有整页跳转才能带着 /en、/ja 回去。
 */
export function WeiboCallbackPage() {
  const t = useT()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  /**
   * StrictMode 下 effect 会跑两遍，而 code 是**一次性**的：第二遍必然失败，
   * 而且它的报错会盖掉第一遍的成功。用 ref 挡住，只兑换一次。
   */
  const started = useRef(false)

  // 一次性的中转页，内容对搜索引擎毫无意义，而且 URL 上还挂着 code
  useSeo({ title: t.auth.weibo, description: t.auth.weiboPending, noindex: true })

  useEffect(() => {
    if (started.current) return
    started.current = true

    // 用户在微博那边点了「取消」：微博带 error / error_description 回来，没有 code
    const denied = params.get('error')
    const code = params.get('code') || ''
    if (denied || !code) {
      setError(denied ? t.errors.weiboCancelled : t.errors.weiboNoCode)
      return
    }

    completeWeiboLogin(code, params.get('state') || '')
      .then(() => {
        // replace 而不是 assign：回调地址留在历史里的话，用户按「后退」会再打开
        // 一次已经用掉的 code，看到一个莫名其妙的失败页
        window.location.replace(takeWeiboReturnTo())
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t.auth.weiboFailed))
  }, [params, t])

  return (
    <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      {error ? (
        <>
          <span className="grid h-20 w-20 place-items-center rounded-3xl bg-live/10 text-4xl" aria-hidden>
            ⚠️
          </span>
          <h1 className="mt-6 text-2xl font-extrabold tracking-tight">{t.auth.weiboFailed}</h1>
          <p role="alert" className="mt-3 max-w-md leading-relaxed text-muted">
            {error}
          </p>
          <div className="mt-8 flex gap-3">
            <Button to="/login">{t.auth.title}</Button>
            <Button to="/" variant="secondary">
              {t.common.backHome}
            </Button>
          </div>
        </>
      ) : (
        <>
          <span
            className="h-12 w-12 animate-spin rounded-full border-4 border-line border-t-brand"
            role="status"
            aria-label={t.auth.weiboPending}
          />
          <p className="mt-6 leading-relaxed text-muted">{t.auth.weiboPending}</p>
        </>
      )}
    </div>
  )
}
