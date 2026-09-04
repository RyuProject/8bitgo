import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'
import { completeOAuthLogin, takeOAuthReturnTo } from '@/services/auth'
import type { Translation } from '@/locales'

/**
 * 第三方登录的落地页（/auth/callback）。
 *
 * 注意这**不是**注册给 Microsoft / Apple 的重定向地址 —— 那两个填的是后端的
 * /api/auth/oauth/<provider>/callback。后端把 code 换成本站 JWT 之后，才 302 到这里。
 * 所以这一页只做三件事：核对 cst、收下令牌、把人送回授权前那一页。
 *
 * 令牌走 URL 的 **fragment**：`#` 后面的内容浏览器不会发给任何服务器，
 * 也不会进反代 / CDN 的访问日志。下面拿到之后立刻 replaceState 把它从地址栏抹掉，
 * 免得留在历史记录里被随手分享出去。
 */

/** 后端回传的失败原因 → 文案。分开写是因为每一种用户能做的事不一样 */
function messageFor(code: string, t: Translation): string {
  const map: Record<string, string> = {
    denied: t.errors.oauthDenied,
    state: t.errors.oauthStateMismatch,
    nocode: t.errors.oauthNoCode,
    token: t.errors.oauthExchangeFailed,
    noemail: t.errors.oauthNoEmail,
    unverified: t.errors.oauthEmailUnverified,
    banned: t.errors.banned,
  }
  return map[code] || t.auth.oauthFailed
}

export function OAuthCallbackPage() {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  /** 这一页只该跑一次：StrictMode 下 effect 会跑两遍，而 hash 已经被第一遍抹掉了 */
  const started = useRef(false)

  // 一次性的中转页，对搜索引擎毫无意义，而且地址里还挂着令牌
  useSeo({ title: t.auth.oauthPending, description: t.auth.oauthPending, noindex: true })

  useEffect(() => {
    if (started.current) return
    started.current = true

    // 用 hash 而不是 useSearchParams：令牌在 # 后面，不在查询串里
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    // 先抹地址栏，再做别的 —— 中间任何一步抛错都不该把令牌留在那儿
    window.history.replaceState(null, '', window.location.pathname)

    const failed = hash.get('error')
    if (failed) {
      setError(messageFor(failed, t))
      return
    }
    completeOAuthLogin(hash.get('token') || '', hash.get('cst') || '')
      .then(() => {
        // replace 而不是 assign：这一页留在历史里的话，用户按「后退」会看到一个
        // 令牌已经被抹掉的空回调页。整页跳转还能带着语言前缀回去（前缀是路由 basename）
        window.location.replace(takeOAuthReturnTo())
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t.auth.oauthFailed))
  }, [t])

  return (
    <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      {error ? (
        <>
          <span className="grid h-20 w-20 place-items-center rounded-3xl bg-live/10 text-4xl" aria-hidden>
            ⚠️
          </span>
          <h1 className="mt-6 text-2xl font-extrabold tracking-tight">{t.auth.oauthFailed}</h1>
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
            aria-label={t.auth.oauthPending}
          />
          <p className="mt-6 leading-relaxed text-muted">{t.auth.oauthPending}</p>
        </>
      )}
    </div>
  )
}
