import { Link } from 'react-router-dom'
import type { PlatformWithCount } from '@/services/games'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { PlatformIcon } from './PlatformIcon'

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
          <span className="text-pixel text-[10px] text-muted">{platform.year}</span>
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
