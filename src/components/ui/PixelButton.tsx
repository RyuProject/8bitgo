import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
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
 * 边框的九宫格拼法。
 *
 * ── 为什么不是 CSS Grid + <img> ─────────────────────────────
 * 原来这里是一个 3×3 的 grid，九张切片各是一个 <img>，靠 `grid-rows-[17px_2px_17px]`
 * 定行高、`width/height: calc(100% + 1px)` 补缝、`object-fit: fill` 拉伸。
 * 在 Chromium 上完全正确，但在微信内置浏览器里拼不上：
 * 圆角被压扁、两侧多出一条平直的竖带、顶边和角块之间出现台阶、底部两个角挂到框外。
 * （2026-09-04 对着用户截图逐像素量过：按钮盒子本身是对的 —— 36 CSS px 高、
 * 88 px 宽、行距 10 px —— 错的只有边框素材在盒子里的**行高分配**。）
 *
 * 病根是这套写法同时压了三件各引擎实现不一致的事：
 *   1. grid 的行轨道尺寸（微信那个内核把 17px/2px/17px 三行摊平了）
 *   2. 替换元素（<img>）在 grid 子项里用百分比宽高
 *   3. 无固有尺寸的 SVG 配 object-fit: fill
 *
 * 现在三样一起去掉：九块都是普通 <span>，用 `position:absolute` 定位、
 * 背景图 `background-size:100% 100%` 拉伸。这两样是十几年前就到处一致的东西。
 *
 * 附带的好处：中间那一条的高度由 top/bottom 内缩算出来（H − 2×角高），
 * 不再要求「角高 × 2 + 2px 正好等于按钮高度」。以前 h-9 和 17px+2px+17px
 * 是靠人肉对齐的，字号一缩放（微信自带字体大小滑杆就会）边框立刻对不上盒子。
 *
 * ⚠️ 顺序就是绘制顺序：中间和四条边先画、四个角**最后**画。
 *    每块边都往角里多铺 1px（那个 calc(... - 1px)），压在角下面，
 *    切片边缘的半透明抗锯齿像素才不会透出背景形成一条细线。
 */
const CORNER = 'var(--pixel-corner)'
const EDGE = 'var(--pixel-edge)'
/** 往邻块下面多铺的 1px（补缝用），横向 / 纵向各一份 */
const BLEED_X = 'calc(var(--pixel-corner) - 1px)'
const BLEED_Y = 'calc(var(--pixel-edge) - 1px)'

const FRAME: Record<string, CSSProperties> = {
  center: { left: BLEED_X, right: BLEED_X, top: BLEED_Y, bottom: BLEED_Y },
  top: { left: BLEED_X, right: BLEED_X, top: 0, height: EDGE },
  bottom: { left: BLEED_X, right: BLEED_X, bottom: 0, height: EDGE },
  left: { left: 0, width: CORNER, top: BLEED_Y, bottom: BLEED_Y },
  right: { right: 0, width: CORNER, top: BLEED_Y, bottom: BLEED_Y },
  'top-left': { left: 0, top: 0, width: CORNER, height: EDGE },
  'top-right': { right: 0, top: 0, width: CORNER, height: EDGE },
  'bottom-left': { left: 0, bottom: 0, width: CORNER, height: EDGE },
  'bottom-right': { right: 0, bottom: 0, width: CORNER, height: EDGE },
}

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
        // --pixel-corner 是角块的**宽**，跟着字号走（长短文案的圆角看起来才一致）；
        // --pixel-edge 是角块的**高**，固定 px —— 素材就是按这个高度切的，
        // 跟着字号缩放会把圆角的像素台阶拉花。
        compact
          ? 'h-9 px-4 text-sm [--pixel-corner:1.25rem] [--pixel-edge:17px]'
          : 'h-12 px-6 text-base [--pixel-corner:1.625rem] [--pixel-edge:23px]',
        tone === 'green' && 'text-white',
        className,
      )}
    >
      <span
        className="pointer-events-none absolute inset-0 transition-[filter] group-hover:brightness-105"
        aria-hidden
      >
        {Object.entries(FRAME).map(([piece, box]) => (
          <span
            key={piece}
            className="absolute bg-no-repeat"
            style={{
              ...box,
              backgroundImage: `url(/ui/pixel-buttons/${tone}-${piece}.svg)`,
              // 100% 100% 才是「拉满、不保比例」；contain / cover 都会让角块留白或裁掉。
              backgroundSize: '100% 100%',
            }}
          />
        ))}
      </span>
      <span className="relative z-10 flex -translate-y-[3px] items-center gap-2">{children}</span>
    </Link>
  )
}
