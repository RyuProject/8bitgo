import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { cx } from '@/lib/format'
import { GameCover } from './GameCover'
import { useLang } from '@/services/lang'
import { useT } from '@/services/i18n'
import { genreLabel, gameTitle, gameDescription } from '@/services/i18nData'

interface Props {
  game: Game
  /** 名次。从 1 开始，画在左上角 */
  rank: number
  /**
   * 右下角那个数字。**由调用方给**，而且必须和这一栏的排序依据是同一个量。
   *
   * 不在卡片里写死成「游玩次数」或「评分」：榜单按什么排，卡片上就该显示什么，
   * 否则界面在陈述一件和排序无关的事 —— 一个按游玩次数排的榜却在每张卡上标评分，
   * 读者只会觉得这个榜排错了。给 undefined 就整块不画（比如统计值为 0 时）。
   */
  metric?: ReactNode
  className?: string
}

/**
 * 榜单用的游戏卡片：**左上名次 + 右上平台 + 居中封面 + 标题简介 + 底部一行元信息**。
 *
 * 和 GameCard 的分工：那一张是「封面占满、信息压在图上」的横向轨道卡，
 * 适合一眼扫过去挑封面；这一张是**榜单**卡 —— 名次要第一眼看见、简介要能读，
 * 所以走的是「留白 + 小封面 + 居中文字」。两种排版塞进同一个组件只会变成
 * 一堆互斥的 props，改一处必崩另一处。
 */
export function GameRankCard({ game, rank, metric, className }: Props) {
  const lang = useLang()
  const t = useT()
  const platform = platformMap[game.platform]
  const genreId = game.genres[0]
  const genre = genreId ? genreMap[genreId] : undefined
  const title = gameTitle(game, lang)
  const description = gameDescription(game, lang)

  return (
    <Link
      to={`/games/${game.slug}`}
      className={cx(
        'card-hover group flex flex-col rounded-card border border-line bg-surface p-4 hover:border-brand/60',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/*
          名次用「大而淡」而不是彩色角标：它是这一栏的骨架，要一眼看出顺序，
          但不该比游戏名更抢眼 —— 读者真正要认的是游戏。
          tabular-nums 让个位数和两位数的数字宽度一致，十张卡的左边缘才对得齐。
        */}
        <span aria-hidden className="text-2xl font-bold leading-none text-dim tabular-nums">
          {rank}
        </span>
        {/*
          平台角标。用 shortName（NES / ARCADE / HTML5），不是全名 ——
          这一行只有半张卡宽，全名会把它挤到第二行去。
        */}
        {platform && (
          <span className="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            {platform.shortName}
          </span>
        )}
      </div>

      {/* 封面固定成小方块居中：榜单要的是整齐，不是每张图各自占满 */}
      <div className="mx-auto mt-2 w-20 overflow-hidden rounded-lg">
        <GameCover game={game} ratio="square" iconSize="sm" still />
      </div>

      <h3 className="mt-3 truncate text-center text-sm font-semibold leading-tight" title={title}>
        {title}
      </h3>
      {/*
        简介固定两行。**必须占住高度**（min-h）：有的游戏没填简介，不占位的话
        同一行里的卡片高矮不齐，底部那行元信息也跟着错开。
      */}
      <p className="mt-1 line-clamp-2 min-h-8 text-center text-xs leading-4 text-muted">{description}</p>

      {/*
        底部一行。mt-auto 把它压到卡片底边 —— 上面简介的实际行数即使不同，
        这一行的位置也一致。
      */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-muted">
        <span className="truncate">
          {genre?.icon && <span aria-hidden>{genre.icon} </span>}
          {genreId ? genreLabel(t, genreId, genre?.name) : ''}
        </span>
        {/* 统计值缺省就整块不画：挂一个「0」会被读成「没人玩」，而真相是「还没统计到」 */}
        {metric !== undefined && <span className="flex shrink-0 items-center gap-1">{metric}</span>}
      </div>
    </Link>
  )
}
