import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { Button, buttonClasses } from '@/components/ui/Button'
import { closeAuthModal, useAuthModalOpen } from '@/services/authModal'
import { loginWithEmailCode, loginWithGoogle, requestEmailCode, useCurrentUser } from '@/services/auth'
import { ApiError } from '@/services/api'
import { useT, fmt } from '@/services/i18n'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const inputClass =
  'h-12 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-fg placeholder:text-dim transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30'

/** 全站统一的登录弹窗：邮箱验证码 + Google，Duolingo 亮色风格。 */
export function AuthModal() {
  const open = useAuthModalOpen()
  const user = useCurrentUser()
  const t = useT()

  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const emailValid = EMAIL_RE.test(email.trim())
  const canSubmit = emailValid && /^\d{6}$/.test(code) && !busy

  // 打开时重置 + 锁定滚动 + 聚焦邮箱
  useEffect(() => {
    if (!open) return
    setEmail('')
    setCode('')
    setDevCode(null)
    setCooldown(0)
    setSending(false)
    setBusy(false)
    setError(null)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const t = setTimeout(() => emailRef.current?.focus(), 60)
    return () => {
      document.body.style.overflow = prev
      clearTimeout(t)
      if (timer.current) clearInterval(timer.current)
    }
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAuthModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 登录成功后自动关闭
  useEffect(() => {
    if (open && user) closeAuthModal()
  }, [open, user])

  if (!open) return null

  const startCooldown = (secs: number) => {
    setCooldown(secs)
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1 && timer.current) clearInterval(timer.current)
        return s - 1 <= 0 ? 0 : s - 1
      })
    }, 1000)
  }

  const sendCode = async () => {
    if (!emailValid || sending || cooldown > 0) return
    setError(null)
    setSending(true)
    try {
      const r = await requestEmailCode(email)
      setDevCode(r.devCode ?? null)
      startCooldown(r.cooldown)
      codeRef.current?.focus()
    } catch (err) {
      // 被限流时服务端会带 retryAfter 回来。照着它倒计时，按钮就不会在服务端还在
      // 429 的时候先亮起来 —— 否则用户点一次错一次，完全不知道要等多久。
      const retry = err instanceof ApiError ? Number((err.data as { retryAfter?: number } | null)?.retryAfter) : NaN
      if (Number.isFinite(retry) && retry > 0) startCooldown(retry)
      setError(err instanceof Error ? err.message : t.auth.sendFailed)
    } finally {
      setSending(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      await loginWithEmailCode(email, code)
      closeAuthModal()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.auth.loginFailed)
    } finally {
      setBusy(false)
    }
  }

  const google = async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await loginWithGoogle()
      closeAuthModal()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.auth.googleFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={closeAuthModal}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div
        className="relative my-auto w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-8"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 关闭 */}
        <button
          type="button"
          onClick={closeAuthModal}
          aria-label={t.common.close}
          className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-fg"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <h2 id="auth-modal-title" className="text-2xl font-extrabold text-fg">
          {t.auth.title}
        </h2>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {/* 邮箱 + 发送验证码 */}
          <div>
            <label htmlFor="auth-email" className="mb-1.5 block text-sm font-semibold text-muted">
              {t.auth.emailLabel}
            </label>
            <div className="flex gap-2">
              <input
                id="auth-email"
                ref={emailRef}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t.auth.emailPlaceholder}
                className={cx(inputClass, 'flex-1')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="button"
                onClick={sendCode}
                disabled={!emailValid || sending || cooldown > 0}
                className={buttonClasses('secondary', 'md', 'h-12 shrink-0 whitespace-nowrap px-4')}
              >
                {sending ? t.auth.sending : cooldown > 0 ? fmt(t.auth.resendIn, { n: cooldown }) : t.auth.sendCode}
              </button>
            </div>
          </div>

          {/* 验证码 */}
          <div>
            <label htmlFor="auth-code" className="mb-1.5 block text-sm font-semibold text-muted">
              {t.auth.codeLabel}
            </label>
            <input
              id="auth-code"
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder={t.auth.codePlaceholder}
              className={cx(inputClass, 'tracking-[0.3em]')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            {devCode && (
              <button
                type="button"
                onClick={() => setCode(devCode)}
                className="mt-1.5 text-xs text-muted transition hover:text-brand-hover"
              >
                {fmt(t.auth.devCodeHint, { code: devCode })}
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-live/10 px-3 py-2 text-sm font-medium text-live">
              {error}
            </p>
          )}

          <Button size="lg" type="submit" className="w-full" disabled={!canSubmit}>
            {busy ? t.auth.submitting : t.auth.submit}
          </Button>
        </form>

        {/* 分隔线 */}
        <div className="my-5 flex items-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <span className="text-sm font-semibold text-dim">{t.auth.or}</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        {/* Google */}
        <Button variant="secondary" size="lg" className="w-full" onClick={google} disabled={busy}>
          <GoogleIcon />
          {t.auth.google}
        </Button>

        {/* 条款 */}
        <p className="mt-6 text-center text-xs leading-relaxed text-muted">
          {t.auth.termsPrefix}{' '}
          <Link to="/terms" onClick={closeAuthModal} className="text-fg underline underline-offset-2 hover:text-brand-hover">
            {t.auth.termsLink}
          </Link>{' '}
          {t.auth.termsAnd}{' '}
          <Link to="/privacy" onClick={closeAuthModal} className="text-fg underline underline-offset-2 hover:text-brand-hover">
            {t.auth.privacyLink}
          </Link>
          {t.auth.termsSuffix}
        </p>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9086c1.7018-1.5668 2.6837-3.874 2.6837-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1809l-2.9086-2.2581c-.8059.54-1.8368.859-3.0478.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2823-1.1168-.2823-1.71s.1023-1.17.2823-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  )
}
