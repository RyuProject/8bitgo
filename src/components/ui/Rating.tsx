import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'

export function Stars({ value, className, size = 12 }: { value: number; className?: string; size?: number }) {
  const t = useT()
  const pct = Math.max(0, Math.min(5, value)) / 5
  return (
    <span
      className={cx('relative inline-block leading-none text-black/15', className)}
      style={{ fontSize: size }}
      aria-label={fmt(t.common.ratingAria, { n: value.toFixed(1) })}
      role="img"
    >
      <span aria-hidden>★★★★★</span>
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 overflow-hidden whitespace-nowrap text-coin"
        style={{ width: `${pct * 100}%` }}
      >
        ★★★★★
      </span>
    </span>
  )
}

export function RatingLine({ rating, count, className }: { rating: number; count?: number; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs text-muted', className)}>
      <Stars value={rating} />
      <span className="font-semibold text-fg">{rating.toFixed(1)}</span>
      {count !== undefined && <span>({count.toLocaleString(getLang())})</span>}
    </span>
  )
}
