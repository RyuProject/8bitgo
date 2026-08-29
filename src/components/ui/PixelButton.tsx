import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'

type PixelButtonTone = 'green' | 'white'

interface PixelButtonProps {
  to: string
  tone?: PixelButtonTone
  compact?: boolean
  className?: string
  children: ReactNode
}

const PIECES = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const

/**
 * 用户绘制的按钮是九宫格切片。保留切片而不是把它们压成一张位图，
 * 是为了让中文、英文等不同长度的文案都能保持像素边角，不被横向拉扁。
 */
export function PixelButton({ to, tone = 'white', compact = false, className, children }: PixelButtonProps) {
  return (
    <Link
      to={to}
      className={cx(
        'group relative inline-flex items-center justify-center whitespace-nowrap font-bold text-fg select-none',
        'transition-transform duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'active:translate-y-[3px]',
        compact ? 'h-9 px-4 text-sm [--pixel-corner:1.25rem]' : 'h-12 px-6 text-base [--pixel-corner:1.625rem]',
        tone === 'green' && 'text-white',
        className,
      )}
    >
      <span
        className="pointer-events-none absolute inset-0 transition-[filter] group-hover:brightness-105"
        aria-hidden
      >
        <span className="absolute inset-0 grid grid-cols-[var(--pixel-corner)_minmax(1px,1fr)_var(--pixel-corner)] grid-rows-[47.8%_4.4%_47.8%]">
          {PIECES.map((piece) => (
            <img
              key={piece}
              src={`/ui/pixel-buttons/${tone}-${piece}.svg`}
              alt=""
              className="h-full w-full object-fill"
              draggable={false}
            />
          ))}
        </span>
      </span>
      <span className="relative z-10 flex -translate-y-[3px] items-center gap-2">{children}</span>
    </Link>
  )
}
