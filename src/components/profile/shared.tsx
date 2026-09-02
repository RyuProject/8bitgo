/**
 * 个人中心各区块共用的小零件。
 *
 * 抽出来的理由很实际：换绑邮箱和注销账号都要「发验证码 + 倒计时 + 显示本地演示码」，
 * 两处各写一遍的话，服务端返回 retryAfter 时的倒计时修正必然只会修在其中一处
 * （另一处的按钮会在服务端还在 429 的时候先亮起来，用户点一次错一次）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { ApiError } from '@/services/api'

export const inputClass =
  'h-11 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-fg placeholder:text-dim transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30'

/** 个人中心里的一块卡片。标题 + 说明 + 内容 */
export function Panel({
  title,
  desc,
  danger,
  children,
}: {
  title: string
  desc?: string
  /** 危险操作（注销账号）用红描边，视觉上和别的区块区分开 */
  danger?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={cx(
        'rounded-card border bg-surface p-5 sm:p-6',
        danger ? 'border-live/40 bg-live/[0.03]' : 'border-line',
      )}
    >
      <h3 className={cx('text-base font-extrabold', danger && 'text-live')}>{title}</h3>
      {desc && <p className="mt-1 text-sm leading-relaxed text-muted">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** 一行提示。ok = 绿色成功，否则红色报错 */
export function Notice({ text, ok }: { text: string; ok?: boolean }) {
  return (
    <p
      role={ok ? 'status' : 'alert'}
      className={cx(
        'rounded-xl px-3 py-2 text-sm font-medium',
        ok ? 'bg-brand-soft text-brand-hover' : 'bg-live/10 text-live',
      )}
    >
      {text}
    </p>
  )
}

/**
 * 「发送验证码」按钮的倒计时。
 *
 * 秒数一律由服务端说了算：成功时用返回的 cooldown，被限流时用 429 里的 retryAfter。
 * 前端自己存一份常量的话，改了服务端就会出现「按钮亮了但服务端还在 429」。
 */
export function useCooldown() {
  const [cooldown, setCooldown] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const start = (secs: number) => {
    if (!(secs > 0)) return
    setCooldown(Math.ceil(secs))
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1 && timer.current) clearInterval(timer.current)
        return s - 1 <= 0 ? 0 : s - 1
      })
    }, 1000)
  }

  /** 被限流时按服务端给的 retryAfter 倒计时；没给就不动 */
  const startFromError = (err: unknown) => {
    const retry = err instanceof ApiError ? Number((err.data as { retryAfter?: number } | null)?.retryAfter) : NaN
    if (Number.isFinite(retry) && retry > 0) start(retry)
  }

  return { cooldown, start, startFromError }
}

/** 6 位数字验证码输入框。非数字直接过滤掉，省掉一次「验证码格式不正确」的往返 */
export function CodeInput({
  value,
  onChange,
  placeholder,
  label,
  id,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
  id: string
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-muted">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder={placeholder}
        className={cx(inputClass, 'tracking-[0.3em]')}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </div>
  )
}
