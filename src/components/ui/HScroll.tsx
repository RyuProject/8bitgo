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
          'scrollbar-none flex snap-x snap-mandatory overflow-x-auto',
          // 垂直留白 + 等量负外边距。
          // 设了 overflow-x 之后 overflow-y 会从 visible 变成 auto，垂直方向跟着被剪；
          // 而卡片 hover 时会上浮 4px（card-hover 的 -translate-y-1）并撑开一层阴影，
          // 留白不够的话上沿和阴影下缘都会被切掉。
          //
          // 阴影到底有多高，是**量出来的**，不是心算的。card-hover 用的是
          // shadow-[0_16px_32px_-14px_rgba(0,0,0,0.18)]，按「偏移 16 + 扩散 -14 + 模糊的一半 16」
          // 算出来是 18px —— 这个算法是错的：CSS 模糊半径对应的高斯 σ 是它的一半（16），
          // 而高斯的尾巴远不止一个 σ。在 Chromium 里实测（白底、1× 缩放），这层阴影到卡片
          // 下方 **33px** 才真正到纯白；20px 处还剩 2.4% 的灰，肉眼就是一道横切线。
          //
          // 所以下边至少要留 33 − 4（上浮抵掉的）= 29px，取 pb-8 = 32px。
          // 上边只需要容下那 4px 上浮（阴影往上最多到卡片顶边下方 14px，够不着上沿），pt-2 足够。
          // 负外边距把多出来的高度收回去：-mt-2 抵掉 pt-2，-mb-6 保持和改之前一样的下方占位。
          '-mt-2 pt-2 pb-8 -mb-6',
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
