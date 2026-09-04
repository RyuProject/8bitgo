import type { ReactNode } from 'react'
import { cx } from '@/lib/format'
import { FEATURES } from '@/config/features'
import { useT, fmt } from '@/services/i18n'

type Tone = 'neutral' | 'brand' | 'coin' | 'live' | 'online' | 'dark'

const tones: Record<Tone, string> = {
  neutral: 'bg-black/[0.06] text-fg',
  brand: 'bg-brand-soft text-brand-hover',
  coin: 'bg-coin-soft text-coin',
  live: 'bg-live text-white',
  online: 'bg-online/15 text-online',
  dark: 'bg-black/60 text-white backdrop-blur',
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  pixel,
  title,
  'aria-label': ariaLabel,
}: {
  children: ReactNode
  tone?: Tone
  className?: string
  pixel?: boolean
  /** 悬停说明。只画一个表情的徽章（比如房间卡上的 👋）必须给，否则鼠标党无从知道它是什么 */
  title?: string
  /** 读屏用。同上：表情本身对读屏器是噪音，真正的意思要写在这里 */
  'aria-label'?: string
}) {
  return (
    <span
      title={title}
      aria-label={ariaLabel}
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-4',
        pixel && 'text-pixel text-[11px]',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function CoinBadge({ amount, className }: { amount: number; className?: string }) {
  const t = useT()
  if (!FEATURES.coins || amount <= 0) return null
  return (
    <Badge tone="coin" className={className}>
      <span aria-hidden>🪙</span>{fmt(t.common.coinBadge, { n: amount })}
    </Badge>
  )
}

export function LiveBadge({ className }: { className?: string }) {
  const t = useT()
  if (!FEATURES.live) return null
  return (
    <Badge tone="live" className={cx('uppercase', className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-white animate-blink" aria-hidden />
      {t.common.liveBadge}
    </Badge>
  )
}
