import type { ReactNode } from 'react'
import { cx } from '@/lib/format'

export function Card({ title, extra, children, className }: { title?: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface', className)}>
      {(title || extra) && (
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold">{title}</h2>
          {extra}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{typeof value === 'number' ? value.toLocaleString('zh-CN') : value}</p>
      {sub && <p className="mt-1 text-xs text-dim">{sub}</p>}
    </div>
  )
}

/** 单色横向条形图：一行一个条目，标签在左、数值在右 */
export function BarList({ items, format }: { items: Array<{ label: string; value: number; hint?: string }>; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate" title={it.label}>
            {it.label}
            {it.hint && <span className="ml-1 text-dim">{it.hint}</span>}
          </span>
          <span className="h-2 overflow-hidden rounded-sm bg-white/5">
            <span className="block h-full rounded-sm bg-brand" style={{ width: `${(it.value / max) * 100}%` }} />
          </span>
          <span className="w-16 text-right tabular-nums text-muted">{format ? format(it.value) : it.value.toLocaleString('zh-CN')}</span>
        </li>
      ))}
    </ul>
  )
}

export const inputClass =
  'h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-dim focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30'

export const btnClass = {
  primary: 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-semibold text-white transition hover:bg-brand-hover disabled:opacity-50',
  secondary:
    'inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg transition hover:border-line-strong disabled:opacity-50',
  danger: 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-live/40 px-3 text-sm text-red-300 transition hover:bg-live/15 disabled:opacity-50',
  small: 'inline-flex h-7 items-center rounded-md px-2 text-xs transition',
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-dim">{hint}</span>}
    </label>
  )
}
