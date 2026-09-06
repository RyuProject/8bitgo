/**
 * 星级：只读展示（Stars）和可点选（StarPicker）两件。
 *
 * 为什么用 SVG 而不是 ⭐ emoji：平均分是 4.3 这种小数，emoji 只能整颗整颗地画，
 * 4.3 会被迫显示成 4 星 —— 那 0.3 正好是「4 分档」和「4.5 分档」的区别，抹掉之后
 * 所有游戏看起来都差不多。SVG 可以让第 5 颗星只填 30% 宽。
 *
 * 做法是叠两层同样的五颗星：底下一层是空心的，上面一层是实心的，
 * 用一个宽度按百分比截断的容器把实心层裁出来。比给每颗星单独算 linearGradient
 * 简单得多，也不会在同一页出现多个评分组件时撞 SVG 的 id。
 */
import { useState } from 'react'
import { fmt, useT } from '@/services/i18n'
import { FEATURES } from '@/config/features'
import { cx } from '@/lib/format'

const STAR_PATH =
  'M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.4l-5.8 3.06 1.1-6.46-4.69-4.58 6.49-.94L12 2.6z'

const SIZES = { sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-6 w-6' } as const
export type StarSize = keyof typeof SIZES

function Row({ filled, size }: { filled: boolean; size: StarSize }) {
  return (
    <div className="flex gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          className={cx(SIZES[size], 'shrink-0', filled ? 'text-coin' : 'text-line-strong')}
          fill={filled ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={filled ? 0 : 1.5}
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={STAR_PATH} />
        </svg>
      ))}
    </div>
  )
}

/**
 * 只读星级。value 是 0~5 的小数。
 *
 * ⚠️ 调用方要先判 ratingCount > 0 再渲染它。0 分在 1~5 分制里不是评分，是「还没人评过」，
 * 画成五颗空星会被读成「大家都给了最低分」。
 */
export function Stars({ value, size = 'md', label }: { value: number; size?: StarSize; label?: string }) {
  const t = useT()
  const pct = Math.max(0, Math.min(100, (value / 5) * 100))
  return (
    <span
      className="relative inline-block leading-none"
      role="img"
      aria-label={label ?? fmt(t.common.ratingAria, { n: value })}
    >
      <Row filled={false} size={size} />
      {/* 实心层压在空心层上，按百分比裁宽。inset-y-0 让两层严格对齐 */}
      <span className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>
        <Row filled size={size} />
      </span>
    </span>
  )
}

/**
 * 可点选的星级。
 *
 * 再点一次当前分数 = 撤销（onPick(0)）—— 手滑点了一星又不想给任何分的人，
 * 没有这条就只能被迫留一个分。悬停时预览的是「点下去会变成几分」，
 * 移开就回到真实值，不会让人以为已经打了分。
 */
export function StarPicker({
  value,
  onPick,
  disabled = false,
  size = 'lg',
}: {
  value: number
  onPick: (score: number) => void
  disabled?: boolean
  size?: StarSize
}) {
  const t = useT()
  const [hover, setHover] = useState(0)
  const shown = hover || value

  return (
    <div className="flex gap-0.5" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          aria-label={fmt(t.ratings.starAria, { n })}
          aria-pressed={value === n}
          onMouseEnter={() => setHover(n)}
          onFocus={() => setHover(n)}
          onBlur={() => setHover(0)}
          onClick={() => onPick(value === n ? 0 : n)}
          className={cx(
            'rounded p-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
            disabled ? 'cursor-wait opacity-60' : 'cursor-pointer hover:scale-110',
          )}
        >
          <svg
            viewBox="0 0 24 24"
            className={cx(SIZES[size], n <= shown ? 'text-coin' : 'text-line-strong')}
            fill={n <= shown ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={n <= shown ? 0 : 1.5}
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={STAR_PATH} />
          </svg>
        </button>
      ))}
    </div>
  )
}

/**
 * 卡片元信息行里的「⭐ 4.3」。
 *
 * 为什么是一行字而不是压在封面上的角标：封面的四个角已经排满了 ——
 * 左上平台、右上排名、左下「即点即玩」、右下人数。再塞一个只会互相盖住。
 *
 * ⚠️ 没人评过时**什么都不画**。rating 为 0 不是「0 分」，1~5 分制里没有 0 分这一档，
 * 画成「⭐ 0.0」等于告诉所有人这游戏烂透了 —— 而新站绝大多数游戏本来就还没有票。
 */
export function RatingText({ rating, count, className }: { rating: number; count: number; className?: string }) {
  const t = useT()
  /**
   * 先过一遍 Number()：这两个字段是这一版才加的，而游戏对象可能来自
   * 上一版存下的本地缓存或还没更新的服务端 SSR 数据 —— 那时候它们是 undefined，
   * 而 `undefined <= 0` 是 false，会一路走到 undefined.toFixed() 把整块列表炸掉。
   */
  const value = Number(rating) || 0
  const votes = Number(count) || 0
  if (!FEATURES.ratings || votes <= 0 || value <= 0) return null
  return (
    <span className={className} title={fmt(t.ratings.count, { n: votes })}>
      <span aria-hidden>⭐ </span>
      {value.toFixed(1)}
    </span>
  )
}
