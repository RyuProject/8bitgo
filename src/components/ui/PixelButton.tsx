import { useLayoutEffect, useRef, type ReactNode } from 'react'
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
  const buttonRef = useRef<HTMLAnchorElement>(null)

  useLayoutEffect(() => {
    const button = buttonRef.current
    if (!button) return

    const snapWidthToPixel = () => {
      // 文案宽度经常带 1/64px 的小数，九宫格的右侧接缝因此会落在亚像素上。
      // 先恢复内容宽度再向上取整，避免重复测量时把上一次的固定宽度继续累加。
      button.style.width = ''
      button.style.width = `${Math.ceil(button.getBoundingClientRect().width)}px`
    }

    snapWidthToPixel()
    document.fonts?.ready.then(snapWidthToPixel)
    window.addEventListener('resize', snapWidthToPixel)
    return () => window.removeEventListener('resize', snapWidthToPixel)
  }, [children, compact])

  return (
    <Link
      ref={buttonRef}
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
        <span
          className={cx(
            'absolute inset-0 grid grid-cols-[var(--pixel-corner)_minmax(1px,1fr)_var(--pixel-corner)]',
            compact ? 'grid-rows-[17px_2px_17px]' : 'grid-rows-[23px_2px_23px]',
          )}
        >
          {PIECES.map((piece, index) => (
            <img
              key={piece}
              src={`/ui/pixel-buttons/${tone}-${piece}.svg`}
              alt=""
              className="block max-w-none object-fill"
              style={{
                // 裁切边缘仍有半透明抗锯齿像素；让前一格在后一格下面多铺 1px，
                // 半透明像素便会与同色图形合成，不再透出页面背景形成细线。
                width: index % 3 < 2 ? 'calc(100% + 1px)' : '100%',
                height: index < 6 ? 'calc(100% + 1px)' : '100%',
              }}
              draggable={false}
            />
          ))}
        </span>
      </span>
      <span className="relative z-10 flex -translate-y-[3px] items-center gap-2">{children}</span>
    </Link>
  )
}
