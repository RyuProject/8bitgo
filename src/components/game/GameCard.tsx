import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { cx, formatCount } from '@/lib/format'
import { GameCover } from './GameCover'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { useLang } from '@/services/lang'
import { useT } from '@/services/i18n'
import { genreLabel, gameTitle } from '@/services/i18nData'

interface Props {
  game: Game
  className?: string
  /** 列表页可改成方形封面；其他位置继续沿用横版比例。 */
  coverRatio?: 'landscape' | 'square'
  /** 显示排名角标 */
  rank?: number
  showCoin?: boolean
}

/** 游戏卡片（封面 + 标题 + 元信息） */
export function GameCard({ game, className, coverRatio = 'landscape', rank, showCoin = true }: Props) {
  const lang = useLang()
  const t = useT()
  const platform = platformMap[game.platform]
  const genre = genreMap[game.genres[0]]

  return (
    <Link
      to={`/games/${game.slug}`}
      className={cx(
        'group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60',
        className,
      )}
    >
      <div className="relative">
        <GameCover game={game} ratio={coverRatio} reserveBottomRight={game.multiplayer} />
        {rank !== undefined && (
          <span className="text-pixel absolute right-2 top-2 rounded bg-black/60 px-1.5 py-1 text-[11px] text-coin backdrop-blur">
            #{rank}
          </span>
        )}
        {game.multiplayer && (
          <Badge tone="dark" className="absolute bottom-2 right-2">
            👥 {game.players}P
          </Badge>
        )}
        {game.rom && (
          <Badge tone="online" className="absolute bottom-2 left-2">
            {t.common.instantPlay}
          </Badge>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition duration-300 group-hover:bg-black/30 group-hover:opacity-100">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-brand text-white shadow-lg shadow-brand/40 transition group-hover:scale-110">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </div>
      </div>

      <div className="space-y-1.5 p-3">
        {/* 标题会被 truncate 截断，tooltip 就得是「被截掉的那行字」本身；
            原名不会因此丢失 —— 详情页标题下面还专门显示一行（见 GameDetailPage） */}
        <h3 className="truncate text-sm font-semibold leading-tight" title={gameTitle(game, lang)}>
          {gameTitle(game, lang)}
        </h3>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">
            {platform.shortName} · {genreLabel(t, game.genres[0], genre?.name)}
          </span>
          {/* 游玩次数是真实统计的，还没人玩过就什么都不显示 —— 挂一个「🔥 0」既难看又没意义 */}
          {game.plays > 0 && <span className="shrink-0">🔥 {formatCount(game.plays)}</span>}
        </div>
        {showCoin && (
          <div className="flex items-center justify-end gap-2">
            <CoinBadge amount={game.coinReward} />
          </div>
        )}
      </div>
    </Link>
  )
}
