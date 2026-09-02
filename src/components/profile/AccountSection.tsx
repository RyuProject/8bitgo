/**
 * 「账号与安全」：登录邮箱、登录密码、其它设备的登录状态。
 *
 * 三件事共用一个原则 —— 每一个都会让**其它设备**重新登录（服务端把令牌版本 +1），
 * 而当前设备直接换一张新令牌，所以用户自己不会被自己的操作踢下线。
 * 这一点必须在界面上说出来，否则「我改了个密码，手机怎么退出了」会变成一条工单。
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import type { PublicUser } from '@/types'
import { Button, buttonClasses } from '@/components/ui/Button'
import { useT, fmt } from '@/services/i18n'
import { changeEmail, logoutAllDevices, requestEmailChangeCode, setPassword } from '@/services/auth'
import { CodeInput, Notice, Panel, inputClass, useCooldown } from './shared'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function AccountSection({ user }: { user: PublicUser }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EmailPanel user={user} />
      <PasswordPanel user={user} />
      {/* 「退出其它设备」横跨两列：它是一个动作而不是一组表单，挤在半栏里会被当成邮箱那块的一部分 */}
      <div className="lg:col-span-2">
        <DevicesPanel />
      </div>
    </div>
  )
}

/* ---------------- 登录邮箱 ---------------- */

function EmailPanel({ user }: { user: PublicUser }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const { cooldown, start, startFromError } = useCooldown()

  const emailValid = EMAIL_RE.test(email.trim()) && email.trim().toLowerCase() !== user.email.toLowerCase()

  const reset = () => {
    setOpen(false)
    setEmail('')
    setCode('')
    setDevCode(null)
    setError(null)
  }

  const send = async () => {
    if (!emailValid || sending || cooldown > 0) return
    setError(null)
    setSending(true)
    try {
      const r = await requestEmailChangeCode(email)
      setDevCode(r.devCode ?? null)
      start(r.cooldown)
    } catch (err) {
      startFromError(err)
      setError(err instanceof Error ? err.message : t.auth.sendFailed)
    } finally {
      setSending(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !emailValid || !/^\d{6}$/.test(code)) return
    setError(null)
    setBusy(true)
    try {
      await changeEmail(email, code)
      reset()
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={t.account.emailTitle}>
      <p className="break-all text-sm font-semibold text-fg">{user.email}</p>

      {!open ? (
        <div className="mt-4 space-y-3">
          {done && <Notice ok text={t.account.emailChanged} />}
          <Button size="sm" variant="secondary" onClick={() => { setDone(false); setOpen(true) }}>
            {t.account.emailChange}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div>
            <label htmlFor="acct-new-email" className="mb-1.5 block text-xs font-semibold text-muted">
              {t.account.emailNew}
            </label>
            <div className="flex gap-2">
              <input
                id="acct-new-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t.account.emailNewPlaceholder}
                className={inputClass}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="button"
                onClick={send}
                disabled={!emailValid || sending || cooldown > 0}
                className={buttonClasses('secondary', 'md', 'h-11 shrink-0 whitespace-nowrap px-3')}
              >
                {sending ? t.account.sending : cooldown > 0 ? fmt(t.account.resendIn, { n: cooldown }) : t.account.sendCode}
              </button>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-dim">{t.account.emailCodeHint}</p>
          </div>

          <CodeInput
            id="acct-email-code"
            label={t.account.code}
            placeholder={t.account.codePlaceholder}
            value={code}
            onChange={setCode}
          />
          {devCode && (
            <button type="button" onClick={() => setCode(devCode)} className="text-xs text-muted hover:text-brand-hover">
              {fmt(t.account.devCodeHint, { code: devCode })}
            </button>
          )}

          {error && <Notice text={error} />}

          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy || !emailValid || !/^\d{6}$/.test(code)}>
              {busy ? t.account.saving : t.common.save}
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

/* ---------------- 登录密码 ---------------- */

function PasswordPanel({ user }: { user: PublicUser }) {
  const t = useT()
  // hasPassword 由服务端给（只给布尔值，不给哈希）。它决定要不要问旧密码 ——
  // 验证码登录的账号从来没设过密码，逼他填一个填不出来的「当前密码」等于功能不可用。
  const hasPassword = Boolean(user.hasPassword)

  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const reset = () => {
    setOpen(false)
    setCurrent('')
    setNext('')
    setAgain('')
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (next.length < 6) return setError(t.errors.passwordShort)
    if (next !== again) return setError(t.account.passwordMismatch)
    setError(null)
    setBusy(true)
    try {
      await setPassword(next, hasPassword ? current : undefined)
      reset()
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={t.account.passwordTitle} desc={hasPassword ? t.account.passwordSet : t.account.passwordNone}>
      {!open ? (
        <div className="space-y-3">
          {done && <Notice ok text={t.account.passwordSaved} />}
          <Button size="sm" variant="secondary" onClick={() => { setDone(false); setOpen(true) }}>
            {hasPassword ? t.account.passwordChange : t.account.passwordCreate}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          {hasPassword && (
            <Labeled id="acct-cur-pw" label={t.account.currentPassword}>
              <input
                id="acct-cur-pw"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Labeled>
          )}
          <Labeled id="acct-new-pw" label={t.account.newPassword}>
            <input
              id="acct-new-pw"
              type="password"
              autoComplete="new-password"
              placeholder={t.account.newPasswordPlaceholder}
              className={inputClass}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Labeled>
          <Labeled id="acct-new-pw2" label={t.account.confirmPassword}>
            <input
              id="acct-new-pw2"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </Labeled>

          {error && <Notice text={error} />}

          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              {busy ? t.account.saving : t.common.save}
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

function Labeled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-muted">
        {label}
      </label>
      {children}
    </div>
  )
}

/* ---------------- 其它设备 ---------------- */

function DevicesPanel() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await logoutAllDevices()
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={t.account.devicesTitle} desc={t.account.devicesDesc}>
      <div className="space-y-3">
        {done && <Notice ok text={t.account.loggedOutAll} />}
        {error && <Notice text={error} />}
        <Button size="sm" variant="secondary" onClick={run} disabled={busy}>
          {busy ? t.account.saving : t.account.logoutAll}
        </Button>
      </div>
    </Panel>
  )
}
