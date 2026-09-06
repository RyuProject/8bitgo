import { Link } from 'react-router-dom'
import type { PlatformWithCount } from '@/services/games'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { PlatformIcon } from './PlatformIcon'
import { EXPERIMENTAL_PLATFORMS } from '@/data/platforms'

export function PlatformCard({ platform, className }: { platform: PlatformWithCount; className?: string }) {
  const t = useT()
  return (
    <Link
      to={`/platforms/${platform.id}`}
      className={cx(
        'group card-hover relative block overflow-hidden rounded-card border border-line bg-surface p-4 hover:border-brand/60',
        className,
      )}
    >
      <div
        className="absolute -right-6 -top-6 h-28 w-28 rounded-full opacity-25 blur-2xl transition group-hover:opacity-50"
        style={{ background: platform.color }}
        aria-hidden
      />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between">
          {/*
            自制图标本身就是一整个成品插画，再套一层淡色底 + 描边的方框只会显得脏，
            所以有图的平台直接铺满这 48×48，方框只留给还在用 emoji 的平台。
          */}
          {platform.image ? (
            <PlatformIcon platform={platform} className="h-12 w-12" />
          ) : (
            <span
              className="grid h-12 w-12 place-items-center rounded-xl text-2xl shadow-inner"
              style={{ background: `${platform.color}22`, border: `1px solid ${platform.color}55` }}
              aria-hidden
            >
              {platform.icon}
            </span>
          )}
          <span className="flex flex-col items-end gap-1">
            <span className="text-pixel text-[10px] text-muted">{platform.year}</span>
            {/*
              实验性平台（目前只有 PS2）要在**进去之前**就说清楚。
              等玩家点进去、挑了款游戏、等它加载失败再说，那是三步之后的事了。
            */}
            {EXPERIMENTAL_PLATFORMS.has(platform.id) && (
              <span className="rounded bg-coin-soft px-1.5 py-0.5 text-[10px] font-semibold text-coin">
                {t.common.experimental}
              </span>
            )}
          </span>
        </div>
        <h3 className="mt-4 text-base font-bold leading-tight">{platformLabel(t, platform.id, platform.name)}</h3>
        <p className="mt-0.5 text-xs text-muted">{platform.manufacturer}</p>
        <p className="mt-auto pt-4 text-sm font-semibold" style={{ color: platform.color }}>
          {fmt(t.common.gamesCountArrow, { n: platform.count })}
        </p>
      </div>
    </Link>
  )
}
