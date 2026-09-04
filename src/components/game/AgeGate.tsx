/**
 * 成人游戏的入口门卫。
 *
 * 规则（服务端 GET /api/games/:slug/access 说了算，这里只画结论）：
 *   1. 成人游戏**必须登录**才能玩 —— 没登录先给登录按钮；
 *   2. 出生日期**记在账号上**，首次填写后不再逐页询问；填一次就锁定（服务端只在没填过时写入），
 *      填错了由管理员在后台清掉再重填；
 *   3. 未满 18 的账号如实记下并拦住，到生日当天服务端现算就放行，不需要再填一次。
 *
 * 出生日期属于敏感个人信息：只在提交那一次发给 PUT /api/me/birth-date，
 * 不写 sessionStorage，不放进 URL，不进任何日志。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { PublicUser } from '@/types'
import { Button } from '@/components/ui/Button'
import { MIN_BIRTH_YEAR, checkAdultBirthDate, isAdultByBirthDate, localDateInputValue, parseBirthDate } from '@/lib/age'
import { api, apiEnabled } from '@/services/api'
import { setBirthDate as saveBirthDate, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { cx } from '@/lib/format'

/* ------------------------------------------------------------------ */
/*  出生日期表单（年龄门与个人中心共用）                                 */
/* ------------------------------------------------------------------ */

/** 把 YYYY-MM-DD 按当前语言排成人能读的日期，给确认那一步用。解析不了就原样显示。 */
export function formatBirthDate(value: string, lang: string): string {
  const parsed = parseBirthDate(value)
  if (!parsed) return value
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(new Date(parsed.year, parsed.month - 1, parsed.day, 12))
  } catch {
    return value
  }
}

interface BirthDateFormProps {
  /** 保存成功（服务端已记录）后回调，参数是更新后的当前用户 */
  onSaved?: (user: PublicUser) => void
  /** 暗底（年龄门里）还是普通面板（个人中心） */
  tone?: 'dark' | 'light'
}

/**
 * 两步：选日期 → 确认。
 *
 * 多这一步确认是因为提交后就锁死了 —— <input type="date"> 里年份多敲一位、月日点反
 * 都是常见手滑，而纠错只能找管理员。把「不可修改」在提交前说一次，比事后解释便宜得多。
 */
export function BirthDateForm({ onSaved, tone = 'dark' }: BirthDateFormProps) {
  const t = useT()
  const lang = useLang()
  const [birthDate, setBirthDate] = useState('')
  const [step, setStep] = useState<'edit' | 'confirm'>('edit')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dark = tone === 'dark'

  const toConfirm = (event: FormEvent) => {
    event.preventDefault()
    if (checkAdultBirthDate(birthDate) === 'invalid') {
      setError(t.game.ageGateInvalid)
      return
    }
    setError(null)
    setStep('confirm')
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const user = await saveBirthDate(birthDate)
      onSaved?.(user)
    } catch (err) {
      // 服务端的 409（已经设置过）/ 400 会带着中文原因回来；网络错误没有 message 就用兜底文案
      setError(err instanceof Error && err.message ? err.message : t.game.ageGateSaveFailed)
      setStep('edit')
    } finally {
      setBusy(false)
    }
  }

  const labelClass = cx('mb-1 block text-xs font-medium', dark ? 'text-white/80' : 'text-muted')
  const inputClass = cx(
    'h-10 w-full rounded-xl border px-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40',
    dark ? 'border-white/20 bg-white/10 text-white [color-scheme:dark]' : 'border-line bg-surface-2 text-fg',
  )
  const errorClass = cx(
    'mt-2 rounded-lg px-3 py-2 text-xs',
    dark ? 'bg-live/20 text-red-200' : 'bg-live/10 font-medium text-live',
  )

  if (step === 'confirm') {
    return (
      <div className={cx('text-left', dark ? 'text-white' : 'text-fg')}>
        <p className="text-sm font-bold">{t.game.ageGateConfirmTitle}</p>
        <p className={cx('mt-1 text-xs leading-relaxed sm:text-sm', dark ? 'text-white/75' : 'text-muted')}>
          {fmt(t.game.ageGateConfirmBody, { date: formatBirthDate(birthDate, lang) })}
        </p>
        {error && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button type="button" className="flex-1" onClick={() => void submit()} disabled={busy}>
            {t.game.ageGateConfirm}
          </Button>
          <Button type="button" variant="secondary" className="flex-1" onClick={() => setStep('edit')} disabled={busy}>
            {t.game.ageGateBack}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={toConfirm} className="text-left">
      <label className="block">
        <span className={labelClass}>{t.game.birthDate}</span>
        <input
          type="date"
          required
          autoComplete="bday"
          min={`${MIN_BIRTH_YEAR}-01-01`}
          max={localDateInputValue()}
          value={birthDate}
          onChange={(event) => {
            setBirthDate(event.target.value)
            setError(null)
          }}
          aria-invalid={Boolean(error)}
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
      <Button type="submit" className="mt-4 w-full">
        {t.game.ageGateContinue}
      </Button>
    </form>
  )
}

/* ------------------------------------------------------------------ */
/*  门卫                                                               */
/* ------------------------------------------------------------------ */

/** 服务端不放行的三种原因，和 routes/games.js 的 adultAccessVerdict 一一对应 */
type Reason = 'login' | 'birthDate' | 'underage'
type AccessStatus = 'checking' | 'open' | 'error' | Reason

interface AccessResponse {
  adult: boolean
  /** 新服务端才有；旧服务端只回 adult */
  allowed?: boolean
  reason?: Reason | null
}

function isReason(v: unknown): v is Reason {
  return v === 'login' || v === 'birthDate' || v === 'underage'
}

/**
 * 按本地已知的账号状态算一遍。只在拿不到服务端结论的时候用：
 * 没配后端、服务端还是旧版本（只回 adult）、接口报错，以及「详情已标成人但接口说不是」那次事故的防线。
 * 结论和服务端同一份规则（shared/age.js），差别只在于这里看的是缓存里的出生日期。
 */
function localVerdict(user: Pick<PublicUser, 'birthDate'> | null): AccessStatus {
  if (!user) return 'login'
  if (!user.birthDate) return 'birthDate'
  return isAdultByBirthDate(user.birthDate) ? 'open' : 'underage'
}

function verdictOf(r: AccessResponse, markedAdult: boolean, user: Pick<PublicUser, 'birthDate'> | null): AccessStatus {
  if (!r.adult) {
    // 只收紧不放宽：详情已标成人时，接口回 false 也不放行。
    // 这条接口出过一次「数据库布尔判成 false」的 bug，年龄门当场消失了。
    return markedAdult ? localVerdict(user) : 'open'
  }
  if (r.allowed === true) return 'open'
  if (isReason(r.reason)) return r.reason
  return localVerdict(user)
}

interface GuardProps {
  slug: string
  /** 缓存详情里的值只用来提前收紧，不用来放宽；最终以实时接口为准。 */
  markedAdult: boolean
  backdrop?: ReactNode
  /**
   * 「请先登录」那一步的按钮。不传就弹全站登录框；
   * 嵌入页（第三方 iframe 里没有登录框，登录态也带不进来）传一个跳回主站的链接。
   */
  loginAction?: ReactNode
  children: ReactNode
}

/**
 * 成人标记的实时门卫。
 *
 * 详情页可能来自 CDN 旧缓存，因此 markedAdult=false 时不能直接挂载播放器，先走 no-store
 * 接口确认。接口同时给出「这个人现在能不能玩」：登录、填了出生日期都会让它重新问一次。
 */
export function GameAgeGuard({ slug, markedAdult, backdrop, loginAction, children }: GuardProps) {
  const t = useT()
  const user = useCurrentUser()
  const [access, setAccess] = useState<{ slug: string; status: AccessStatus }>(() => ({ slug, status: 'checking' }))
  const [attempt, setAttempt] = useState(0)

  // 依赖里只放这两个字段而不是整个 user：收藏 / 最近游玩的变化不该让门卫重新跑一遍
  const userId = user?.id ?? null
  const userBirthDate = user?.birthDate ?? null

  useEffect(() => {
    const account = userId ? { birthDate: userBirthDate } : null
    if (!apiEnabled()) {
      setAccess({ slug, status: markedAdult ? localVerdict(account) : 'open' })
      return
    }

    let cancelled = false
    // 已经放行的播放器不因为一次复查就被卸载（玩着玩着在顶栏登录了也一样）——
    // 只有结论变严了才收回去。换了游戏则必须回到 checking。
    setAccess((prev) => (prev.slug === slug && prev.status === 'open' ? prev : { slug, status: 'checking' }))
    api
      .get<AccessResponse>(`/api/games/${encodeURIComponent(slug)}/access`)
      .then((r) => {
        if (!cancelled) setAccess({ slug, status: verdictOf(r, markedAdult, account) })
      })
      .catch(() => {
        // 详情已标成人时不能因为接口失败就露出播放器，按本地账号状态先拦着
        if (!cancelled) setAccess({ slug, status: markedAdult ? localVerdict(account) : 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [slug, markedAdult, attempt, userId, userBirthDate])

  // 路由切换后的第一帧不能沿用上一款游戏的 open，否则邀请链接可能抢在 effect 前自动启动。
  const status = access.slug === slug ? access.status : 'checking'
  if (status === 'open') return children

  if (status === 'login' || status === 'birthDate' || status === 'underage') {
    return (
      <GateFrame backdrop={backdrop}>
        <span className="text-3xl sm:text-4xl" aria-hidden>
          🔞
        </span>
        <h2 className="mt-2 text-lg font-extrabold sm:text-xl">{t.game.ageGateTitle}</h2>
        {status === 'login' && (
          <>
            <p className="mt-1 text-xs leading-relaxed text-white/70 sm:text-sm">{t.game.ageGateLoginBody}</p>
            <div className="mx-auto mt-4 max-w-xs">
              {loginAction ?? (
                <Button type="button" className="w-full" onClick={openAuthModal}>
                  {t.game.ageGateLogin}
                </Button>
              )}
            </div>
          </>
        )}
        {status === 'birthDate' && (
          <>
            <p className="mt-1 text-xs leading-relaxed text-white/70 sm:text-sm">{t.game.ageGateBody}</p>
            <div className="mx-auto mt-4 max-w-xs">
              <BirthDateForm
                tone="dark"
                onSaved={(u) => {
                  // 先按回来的用户对象放行，省一次 checking 的闪动；出生日期变了会让 effect 再向服务端确认一次，
                  // 服务端不同意的话那边会收回去
                  setAccess({ slug, status: isAdultByBirthDate(u.birthDate) ? 'open' : 'underage' })
                }}
              />
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-white/45 sm:text-[11px]">{t.game.ageGatePrivacy}</p>
          </>
        )}
        {status === 'underage' && (
          <>
            <p role="alert" className="mx-auto mt-3 max-w-xs rounded-lg bg-live/20 px-3 py-2 text-xs text-red-200 sm:text-sm">
              {t.game.ageGateUnderage}
            </p>
            <p className="mt-3 text-[10px] leading-relaxed text-white/45 sm:text-[11px]">{t.game.ageGateUnderageLocked}</p>
          </>
        )}
      </GateFrame>
    )
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

/** 年龄门的外框：封面压暗做底、扫描线、居中一张卡。验证通过之前完全不挂载 EmulatorPlayer，所有启动路径自然都被挡住。 */
function GateFrame({ backdrop, children }: { backdrop?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-black">
      <div className="relative min-h-[25rem] w-full overflow-hidden bg-black sm:aspect-video sm:min-h-0">
        <div className="absolute inset-0 opacity-35 blur-sm">{backdrop}</div>
        <div className="scanlines absolute inset-0" aria-hidden />
        <div className="absolute inset-0 bg-black/75" />
        <div className="absolute inset-0 flex items-center justify-center px-4 py-3 sm:px-8">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-black/75 p-4 text-center text-white shadow-2xl backdrop-blur sm:p-6">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
