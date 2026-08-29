import { cx } from '@/lib/format'

interface SkeletonBlockProps {
  className?: string
}

/**
 * 全站骨架的最小积木。统一用 surface-3 和品牌色扫光，避免各页面自行写 bg-white/5：
 * 本站是白色主题，那种深色站常用的透明白在这里几乎看不见，才会像“空白卡住了”。
 */
export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return <span className={cx('skeleton-shimmer block rounded-lg', className)} />
}

interface GameCardSkeletonProps {
  coverRatio?: 'square' | 'landscape'
}

/** 游戏卡占位和真实卡片共用同样的圆角、边框与封面比例，换成数据后不会跳版。 */
export function GameCardSkeleton({ coverRatio = 'square' }: GameCardSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <SkeletonBlock className={cx('rounded-none', coverRatio === 'square' ? 'aspect-square' : 'aspect-[4/3]')} />
      <div className="space-y-2.5 p-3">
        <SkeletonBlock className="h-3.5 w-3/4" />
        <SkeletonBlock className="h-3 w-1/2" />
      </div>
    </div>
  )
}

interface GameGridSkeletonProps {
  count?: number
  className?: string
  coverRatio?: GameCardSkeletonProps['coverRatio']
}

/** 列表页通用占位；网格列数由页面传入，卡片视觉保持一致。 */
export function GameGridSkeleton({ count = 10, className, coverRatio = 'square' }: GameGridSkeletonProps) {
  return (
    <div className={className} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <GameCardSkeleton key={i} coverRatio={coverRatio} />
      ))}
    </div>
  )
}

/**
 * 路由代码还没下载完时没有具体页面结构可参考，退回一张中性的 8BitGo 页面骨架。
 * 顶栏和侧边栏继续保留，只占位内容区，让导航位置始终稳定。
 */
export function PageSkeleton() {
  return (
    <div className="container-x py-8 sm:py-10" aria-busy="true">
      <div className="max-w-2xl" aria-hidden>
        <SkeletonBlock className="h-2.5 w-20 rounded-full" />
        <SkeletonBlock className="mt-3 h-8 w-56 max-w-[72vw]" />
        <SkeletonBlock className="mt-3 h-4 w-full" />
        <SkeletonBlock className="mt-2 h-4 w-4/5" />
      </div>

      <div className="mt-7 flex gap-2 overflow-hidden" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <span
            key={i}
            className={cx(
              'flex h-9 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface-2 px-2.5',
              i % 3 === 0 ? 'w-28' : 'w-24',
            )}
          >
            <SkeletonBlock className="h-4 w-4 shrink-0 rounded-full" />
            <SkeletonBlock className="h-2 flex-1 rounded-full" />
          </span>
        ))}
      </div>

      <GameGridSkeleton
        count={10}
        className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      />
    </div>
  )
}
