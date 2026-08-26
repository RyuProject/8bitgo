import { Link } from 'react-router-dom'
import type { CollectionWithGames } from '@/services/games'
import { cx } from '@/lib/format'
import { gradientFor } from '@/lib/gradients'

export function CollectionCard({ collection, className }: { collection: CollectionWithGames; className?: string }) {
  const covers = collection.games.slice(0, 4)
  return (
    <Link
      to={`/collections/${collection.slug}`}
      className={cx(
        'group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60',
        className,
      )}
    >
      <div className="relative grid aspect-[16/10] grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden bg-surface-2 p-0.5">
        {covers.map((g) => (
          <div
            key={g.slug}
            className="relative grid place-items-center overflow-hidden rounded-sm text-3xl transition duration-500 group-hover:scale-105"
            style={{ background: gradientFor(g.slug) }}
            aria-hidden
          >
            <span className="pixel-grid absolute inset-0 opacity-60" />
            <span className="relative drop-shadow">{g.icon}</span>
          </div>
        ))}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
        <div className="absolute bottom-2 left-3 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-black/60 text-lg backdrop-blur" aria-hidden>
            {collection.icon}
          </span>
          <span className="text-sm font-bold text-white drop-shadow">{collection.title}</span>
        </div>
      </div>
      <div className="p-3">
        <p className="line-clamp-2 text-xs leading-relaxed text-muted">{collection.description}</p>
        <p className="mt-2 text-xs font-semibold text-brand-hover">{collection.games.length} 款游戏</p>
      </div>
    </Link>
  )
}
