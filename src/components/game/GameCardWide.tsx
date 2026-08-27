import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { cx, formatCount } from '@/lib/format'
import { GameCover } from './GameCover'
import { Badge } from '@/components/ui/Badge'

interface Props {
  game: Game
  className?: string
  /** 视频缩略图风格：显示播放按钮与时长 */
  video?: boolean
  /** 显示「新」角标 */
  isNew?: boolean
}

/** 横版卡片（16:9），用于「最新上线」「一起玩」等区块 */
export function GameCardWide({ game, className, video = true, isNew }: Props) {
  const platform = platformMap[game.platform]

  return (
    <Link
      to={`/games/${game.slug}`}
      className={cx('group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60', className)}
    >
      <div className="relative">
        <GameCover game={game} ratio="wide" showTitle={false} iconSize="md" />
        {video && (
          <>
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition group-hover:scale-110 group-hover:bg-brand">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </span>
          </>
        )}
        {isNew && (
          <Badge tone="brand" className="absolute right-2 top-2">
            NEW
          </Badge>
        )}
      </div>
      <div className="p-3">
        <h3 className="truncate text-sm font-semibold" title={game.title}>
          {game.title}
        </h3>
        <p className="mt-1 flex items-center justify-between text-[11px] text-muted">
          <span>
            {platform.name} · {game.year}
          </span>
          {game.plays > 0 && <span>▶ {formatCount(game.plays)}</span>}
        </p>
      </div>
    </Link>
  )
}
