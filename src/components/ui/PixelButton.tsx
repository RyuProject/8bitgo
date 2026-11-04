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

/**
 * 统一用 CSS 绘制圆角按钮，避免九宫格 SVG 在不同浏览器缩放时出现接缝，
 * 也让不同语言的按钮宽度自然跟随文案变化。
 */
export function PixelButton({ to, tone = 'white', compact = false, className, children }: PixelButtonProps) {
  return (
    <Link
      to={to}
      className={cx(
        'pixel-button',
        tone === 'green' ? 'pixel-button--green green-action' : 'pixel-button--white',
        compact && 'pixel-button--compact',
        className,
      )}
    >
      {children}
    </Link>
  )
}
