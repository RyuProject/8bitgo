import { memo } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { cx, formatCount } from '@/lib/format'
import { GameCover } from './GameCover'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { RatingText } from './StarRating'
import { useLang } from '@/services/lang'
import { useT } from '@/services/i18n'
import { genreLabel, gameTitle } from '@/services/i18nData'

interface Props {
  game: Game
  className?: string
  /** 封面比例：默认 1:1 方形；部分列表可显式传 landscape 保持横版。 */
  coverRatio?: 'landscape' | 'square'
  /** 显示排名角标 */
  rank?: number
  showCoin?: boolean
  /**
   * 封面不走懒加载（首屏那几张用）。
   * 惰性图要等滚动才真正开始下，一屏全是黑/渐变格子；首屏这几点字节不值得省。
   */
  eager?: boolean
}

/**
 * 列表里首屏大致能看到的卡片数。这几个的封面不走懒加载 ——
 * 惰性图要等滚动才真正开始下载，首屏省这几个字节、换来一屏占位格，不划算。
 * 大盘列表（/games、平台页、类型页）共用这一个数，免得各写一份。
 */
export const ABOVE_FOLD_CARDS = 8

/**
 * 游戏卡片（封面 + 标题 + 元信息）。
 *
 * ## 为什么这里包了一层 memo（2026-09-18）
 *
 * `/games` 是**无限续接**的：每往下滚一页就往同一个数组里 push 24 张卡，
 * 而数组一变，整张网格连同**已经渲染过的那几百张**一起重渲染一遍 ——
 * 卡片里的封面、角标、评分、以及三元表达式加起来不是零成本，
 * 在手机上滚到第五六页就能感觉到那一下卡顿。
 *
 * 卡片的 props 全是稳定的（`game` 是同一个对象引用，其余是字符串 / 数字 / 布尔），
 * 所以 memo 能真的挡下这些重渲染：新一页进来时，老卡片直接复用上一次的元素树。
 * 语言或主题变化不受影响 —— 那两条走的是 useLang / useT 的订阅，绕不过 memo 也不会被它拦住。
 *
 * ⚠️ 加新 prop 时注意：传**每次渲染都新建的对象 / 数组 / 箭头函数**会让 memo 失效。
 * 这个组件目前刻意不收回调，就是为了它。
 */
export const GameCard = memo(function GameCard({ game, className, coverRatio = 'square', rank, showCoin = true, eager }: Props) {
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
        <GameCover game={game} ratio={coverRatio} reserveBottomRight={game.multiplayer} eager={eager} />
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
        {(game.playable || game.rom || game.roms) && (
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
          {/* 评分和游玩次数都是真实统计的，没有就什么都不显示 ——
              挂一个「⭐ 0.0」或「🔥 0」既难看又会被读成「评价很差 / 没人玩」 */}
          <span className="flex shrink-0 items-center gap-1.5">
            <RatingText rating={game.rating} count={game.ratingCount} />
            {game.plays > 0 && <span>🔥 {formatCount(game.plays)}</span>}
          </span>
        </div>
        {showCoin && (
          <div className="flex items-center justify-end gap-2">
            <CoinBadge amount={game.coinReward} />
          </div>
        )}
      </div>
    </Link>
  )
})
