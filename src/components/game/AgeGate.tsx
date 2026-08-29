import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { checkAdultBirthDate, localDateInputValue } from '@/lib/age'
import { api, apiEnabled } from '@/services/api'
import { useT } from '@/services/i18n'

interface Props {
  backdrop?: ReactNode
  onVerified: () => void
}

/** 成人游戏入口：验证通过之前完全不挂载 EmulatorPlayer，所有启动路径自然都被挡住。 */
export function AgeGate({ backdrop, onVerified }: Props) {
  const t = useT()
  const [birthDate, setBirthDate] = useState('')
  const [error, setError] = useState<'invalid' | 'underage' | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const result = checkAdultBirthDate(birthDate)
    if (result === 'adult') {
      // 不把出生日期写进 localStorage / sessionStorage / 服务端；组件卸载后原值随即消失。
      onVerified()
      return
    }
    setError(result)
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-black">
      <div className="relative min-h-[25rem] w-full overflow-hidden bg-black sm:aspect-video sm:min-h-0">
        <div className="absolute inset-0 opacity-35 blur-sm">{backdrop}</div>
        <div className="scanlines absolute inset-0" aria-hidden />
        <div className="absolute inset-0 bg-black/75" />
        <form onSubmit={submit} className="absolute inset-0 flex items-center justify-center px-4 py-3 sm:px-8">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-black/75 p-4 text-center text-white shadow-2xl backdrop-blur sm:p-6">
            <span className="text-3xl sm:text-4xl" aria-hidden>🔞</span>
            <h2 className="mt-2 text-lg font-extrabold sm:text-xl">{t.game.ageGateTitle}</h2>
            <p className="mt-1 text-xs leading-relaxed text-white/70 sm:text-sm">{t.game.ageGateBody}</p>
            <label className="mx-auto mt-4 block max-w-xs text-left">
              <span className="mb-1 block text-xs font-medium text-white/80">{t.game.birthDate}</span>
              <input
                type="date"
                required
                autoComplete="bday"
                max={localDateInputValue()}
                value={birthDate}
                onChange={(event) => {
                  setBirthDate(event.target.value)
                  setError(null)
                }}
                aria-invalid={Boolean(error)}
                className="h-10 w-full rounded-xl border border-white/20 bg-white/10 px-3 text-sm text-white [color-scheme:dark] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
            </label>
            {error && (
              <p role="alert" className="mx-auto mt-2 max-w-xs rounded-lg bg-live/20 px-3 py-2 text-xs text-red-200">
                {error === 'underage' ? t.game.ageGateUnderage : t.game.ageGateInvalid}
              </p>
            )}
            <Button type="submit" className="mt-4 w-full max-w-xs">
              {t.game.ageGateContinue}
            </Button>
            <p className="mt-3 text-[10px] leading-relaxed text-white/45 sm:text-[11px]">{t.game.ageGatePrivacy}</p>
          </div>
        </form>
      </div>
    </div>
  )
}

type AccessStatus = 'checking' | 'adult' | 'open' | 'error'

interface GuardProps {
  slug: string
  /** 缓存详情里的值只用来提前收紧，不用来放宽；最终以实时接口为准。 */
  markedAdult: boolean
  backdrop?: ReactNode
  children: ReactNode
}

/**
 * 成人标记的实时门卫。
 *
 * 详情页可能来自 CDN 旧缓存，因此 markedAdult=false 时不能直接挂载播放器。先走 no-store
 * 接口确认；markedAdult=true 时则立即显示年龄门，网络失败也不会误放行。
 */
export function GameAgeGuard({ slug, markedAdult, backdrop, children }: GuardProps) {
  const t = useT()
  const [access, setAccess] = useState<{ slug: string; status: AccessStatus }>(() => ({
    slug,
    status: markedAdult ? 'adult' : 'checking',
  }))
  const [verifiedSlug, setVerifiedSlug] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!apiEnabled()) {
      setAccess({ slug, status: markedAdult ? 'adult' : 'open' })
      return
    }

    let cancelled = false
    setAccess({ slug, status: markedAdult ? 'adult' : 'checking' })
    api
      .get<{ adult: boolean }>(`/api/games/${encodeURIComponent(slug)}/access`)
      .then(({ adult }) => {
        if (!cancelled) setAccess({ slug, status: adult ? 'adult' : 'open' })
      })
      .catch(() => {
        if (!cancelled) setAccess({ slug, status: markedAdult ? 'adult' : 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [slug, markedAdult, attempt])

  // 路由切换后的第一帧不能沿用上一款游戏的 open，否则邀请链接可能抢在 effect 前自动启动。
  const status = access.slug === slug ? access.status : markedAdult ? 'adult' : 'checking'
  if (status === 'open' || (status === 'adult' && verifiedSlug === slug)) return children
  if (status === 'adult') {
    return <AgeGate backdrop={backdrop} onVerified={() => setVerifiedSlug(slug)} />
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-black">
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        <div className="absolute inset-0 opacity-25 blur-sm">{backdrop}</div>
        <div className="absolute inset-0 bg-black/80" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white">
          {status === 'checking' ? (
            <>
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-brand" aria-hidden />
              <p className="text-sm text-white/70">{t.game.ageGateChecking}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-white/75">{t.game.ageGateCheckFailed}</p>
              <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
                {t.game.ageGateRetry}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
