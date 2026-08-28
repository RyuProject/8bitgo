import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { cx, formatCount } from '@/lib/format'
import { GameCover } from './GameCover'
import { Badge } from '@/components/ui/Badge'
import { useLang } from '@/services/lang'
import { gameTitle } from '@/services/i18nData'

interface Props {
  game: Game
  className?: string
  /** 显示「新」角标 */
  isNew?: boolean
}

/**
 * 宽卡片（1:1 封面），用于「最新上线」「一起玩」等区块。
 *
 * 封面上不叠播放按钮：这些卡的封面本来就是会自动播放的视频（见 GameCover 的
 * IntersectionObserver），中间压一个圆钮正好挡住画面中心，而动起来的画面本身
 * 已经足够说明「这里有视频」了。
 */
export function GameCardWide({ game, className, isNew }: Props) {
  const lang = useLang()
  const platform = platformMap[game.platform]
  // 中文界面下要显示中文译名。以前这里直接写 game.title，于是「最新上线」整块
  // 在中文站上全是英文原名，而旁边用 GameCard 的区块却是中文 —— 同一页两套名字
  const title = gameTitle(game, lang)

  return (
    <Link
      to={`/games/${game.slug}`}
      className={cx('group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60', className)}
    >
      <div className="relative">
        <GameCover game={game} ratio="square" showTitle={false} iconSize="md" />
        {isNew && (
          <Badge tone="brand" className="absolute right-2 top-2">
            NEW
          </Badge>
        )}
      </div>
      <div className="p-3">
        <h3 className="truncate text-sm font-semibold" title={title}>
          {title}
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
