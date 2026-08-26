import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

interface Props {
  children: ReactNode
  className?: string
  /** 每个子项的宽度类，例如 'w-40 sm:w-44' */
  itemClassName?: string
  gap?: string
  /** 是否让轨道向两侧溢出到页面容器的内边距（默认 true，放在卡片容器内时设为 false） */
  bleed?: boolean
}

/**
 * 横向滚动轨道：手机端用手指滑动，桌面端显示左右箭头。
 * 子元素会被包裹在 snap 项中。
 */
export function HScroll({
  children,
  className,
  itemClassName = 'w-56 sm:w-60',
  gap = 'gap-4',
  bleed = true,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    setCanLeft(el.scrollLeft > 4)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }, [])

  useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [update])

  const scrollBy = (dir: 1 | -1) => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }

  const items = Array.isArray(children) ? children : [children]

  return (
    <div className={cx('group/track relative', className)}>
      <div
        ref={ref}
        className={cx(
          'scrollbar-none flex snap-x snap-mandatory overflow-x-auto pb-2',
          // 负边距(-mx)让轨道向两侧溢出到页面边缘做「出血」；px 把首卡片推回容器内边；
          // scroll-pl 必须与 px 一致，否则 snap 会把首卡片吸附到边框而非内容边，首屏自动左移、与标题错位。
          // 负边距放在这个「可滚动」元素上（而非外层），左右箭头才不会跟着被推到视口外，导致整页横向溢出。
          bleed
            ? 'scroll-pl-4 -mx-4 px-4 sm:scroll-pl-6 sm:-mx-6 sm:px-6 lg:scroll-pl-8 lg:-mx-8 lg:px-8'
            : 'scroll-pl-0.5 px-0.5',
          gap,
        )}
      >
        {items.map((child, i) => (
          <div key={i} className={cx('shrink-0 snap-start', itemClassName)}>
            {child}
          </div>
        ))}
      </div>

      <ArrowButton side="left" visible={canLeft} onClick={() => scrollBy(-1)} />
      <ArrowButton side="right" visible={canRight} onClick={() => scrollBy(1)} />
    </div>
  )
}

function ArrowButton({
  side,
  visible,
  onClick,
}: {
  side: 'left' | 'right'
  visible: boolean
  onClick: () => void
}) {
  const t = useT()
  return (
    <button
      type="button"
      aria-label={side === 'left' ? t.common.scrollLeft : t.common.scrollRight}
      onClick={onClick}
      className={cx(
        'absolute top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-surface/90 text-fg shadow-lg backdrop-blur transition hover:bg-brand hover:border-brand md:flex',
        side === 'left' ? '-left-5 lg:-left-6' : '-right-5 lg:-right-6',
        visible ? 'opacity-0 group-hover/track:opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        {side === 'left' ? <path d="M15 5l-7 7 7 7" /> : <path d="M9 5l7 7-7 7" />}
      </svg>
    </button>
  )
}
