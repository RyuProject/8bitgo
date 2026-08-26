import { Link } from 'react-router-dom'
import type { LiveStreamWithGame } from '@/services/games'
import { cx, formatCount } from '@/lib/format'
import { GameCover } from './GameCover'
import { LiveBadge, Badge } from '@/components/ui/Badge'

export function StreamCard({ stream, className }: { stream: LiveStreamWithGame; className?: string }) {
  return (
    <Link
      to={`/games/${stream.game.slug}`}
      className={cx('group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-live/60', className)}
    >
      <div className="relative">
        <GameCover game={stream.game} ratio="wide" showTitle={false} />
        <LiveBadge className="absolute left-2 top-2" />
        <Badge tone="dark" className="absolute bottom-2 left-2">
          👁 {formatCount(stream.viewers)}
        </Badge>
        <span className="scanlines absolute inset-0 opacity-40" aria-hidden />
      </div>
      <div className="flex gap-3 p-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-pink-500 text-sm font-bold text-white"
          aria-hidden
        >
          {stream.streamer.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={stream.title}>
            {stream.title}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {stream.streamer} · {stream.game.titleZh ?? stream.game.title}
          </p>
        </div>
      </div>
    </Link>
  )
}
