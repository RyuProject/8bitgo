/**
 * 「注销账号」。
 *
 * 为什么要一封确认邮件而不是只弹一个「确定吗」：
 * 删号不可逆，而这个按钮在登录态的页面上 —— 一台没锁屏的电脑、一个借出去的浏览器
 * 都能点到这里。要求收信等于再确认一次「人还在，而且这个邮箱真的是他的」。
 *
 * 界面上分两步：先点「我要注销账号」（发码），再填码确认。
 * 不做「填完码自动提交」——这是唯一一个不可撤销的操作，必须有一次明确的点击。
 */
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useT, fmt } from '@/services/i18n'
import { deleteMyAccount, requestDeleteCode } from '@/services/auth'
import { CodeInput, Notice, Panel, useCooldown } from './shared'

export function DangerZone({ email }: { email: string }) {
  const t = useT()
  const navigate = useNavigate()

  const [armed, setArmed] = useState(false)
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { cooldown, start, startFromError } = useCooldown()

  const arm = async () => {
    if (sending || cooldown > 0) return
    setError(null)
    setSending(true)
    try {
      const r = await requestDeleteCode()
      setDevCode(r.devCode ?? null)
      start(r.cooldown)
      setArmed(true)
    } catch (err) {
      startFromError(err)
      setError(err instanceof Error ? err.message : t.auth.sendFailed)
    } finally {
      setSending(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !/^\d{6}$/.test(code)) return
    setError(null)
    setBusy(true)
    try {
      await deleteMyAccount(code)
      // 账号已经没了，留在 /me 只会立刻弹登录框 —— 直接回首页
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed)
      setBusy(false)
    }
  }

  return (
    <Panel danger title={t.account.dangerTitle} desc={t.account.dangerDesc}>
      {!armed ? (
        <div className="space-y-3">
          {error && <Notice text={error} />}
          <Button size="sm" variant="secondary" onClick={arm} disabled={sending}>
            {sending ? t.account.sending : t.account.dangerStart}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-muted">{fmt(t.account.dangerCodeSent, { email })}</p>
          <div className="max-w-xs">
            <CodeInput
              id="acct-delete-code"
              label={t.account.code}
              placeholder={t.account.codePlaceholder}
              value={code}
              onChange={setCode}
            />
          </div>
          {devCode && (
            <button type="button" onClick={() => setCode(devCode)} className="text-xs text-muted hover:text-brand-hover">
              {fmt(t.account.devCodeHint, { code: devCode })}
            </button>
          )}
          {error && <Notice text={error} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="danger" type="submit" disabled={busy || !/^\d{6}$/.test(code)}>
              {busy ? t.account.saving : t.account.dangerConfirm}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setArmed(false); setCode(''); setError(null) }}>
              {t.account.dangerCancel}
            </Button>
            <button
              type="button"
              onClick={arm}
              disabled={sending || cooldown > 0}
              className="text-xs font-semibold text-muted transition hover:text-brand-hover disabled:opacity-50"
            >
              {cooldown > 0 ? fmt(t.account.resendIn, { n: cooldown }) : t.account.sendCode}
            </button>
          </div>
        </form>
      )}
    </Panel>
  )
}
