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
 * 前三名的名次角标配色（金 / 银 / 铜）。
 *
 * ⚠️⚠️ 颜色必须落在**底色**上、文字用深色，**绝不能拿金银铜当文字色** ——
 * 浅色主题的 `--color-surface` 是纯白，`#ffc800` 这类亮色当文字对比度不到 2:1，
 * 等于没画。金那一对直接沿用 Button 的 coin 档（`bg-coin` + `#7a4f00`），
 * 两处保持一致，改配色时一起改。
 *
 * 第 4 名往后走 `bg-surface-3 text-muted`：角标尺寸不变（十张卡的左上角要对齐），
 * 只是退到背景里去。
 */
const MEDAL_TONES: Record<number, string> = {
  1: 'bg-coin text-[#7a4f00]',
  2: 'bg-[#c9ced6] text-[#3d434c]',
  3: 'bg-[#dda15e] text-[#4a2a0c]',
}

/**
 * 榜单用的游戏卡片：**顶部一行名次+平台 → 满宽方形封面 → 标题 → 简介 → 底部元信息**。
 *
 * 和 GameCard 的分工：那一张是「封面占满、信息压在图上」的横向轨道卡，
 * 适合一眼扫过去挑封面；这一张是**榜单**卡 —— 名次要第一眼看见、简介要能读。
 * 两种排版塞进同一个组件只会变成一堆互斥的 props，改一处必崩另一处。
 *
 * ⚠️ 封面必须**占满卡片宽度**（2026-09-12 改）。上一版是居中的 `w-20`（80 像素），
 * 五列栅格下每张卡内宽才 110~130 像素，等于故意把图缩到一半 —— 用户的原话是
 * 「看不见 cover 上是什么」。要腾地方就压别的：卡片内边距从 p-4 收到 p-3，
 * 名次从「2xl 大数字」换成小角标。**别再给封面设固定宽度。**
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
        'card-hover group flex flex-col rounded-card border border-line bg-surface p-3 hover:border-brand/60',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        {/*
          名次角标。尺寸固定（两位数的「10」也在同一个方块里），tabular-nums 让
          个位数和两位数宽度一致，十张卡的左上角才对得齐。
        */}
        <span
          aria-hidden
          className={cx(
            'flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-black leading-none tabular-nums',
            MEDAL_TONES[rank] ?? 'bg-surface-3 text-muted',
          )}
        >
          {rank}
        </span>
        {/*
          平台角标。用 shortName（NES / ARCADE / HTML5），不是全名 ——
          这一行只有半张卡宽，全名会把它挤到第二行去。
          ⚠️ 底色只能用主题变量。以前这里是 bg-white/5，**浅色主题下就是纯白配纯白**，
          等于没有底 —— 深色主题里看着好好的，切到浅色就露馅。
        */}
        {platform && (
          <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            {platform.shortName}
          </span>
        )}
      </div>

      {/* 封面：满宽方形，卡片有多宽它就有多宽（理由见组件头的 ⚠️） */}
      <div className="mt-2 w-full overflow-hidden rounded-lg">
        <GameCover game={game} ratio="square" iconSize="md" still />
      </div>

      <h3 className="mt-2.5 truncate text-center text-sm font-semibold leading-tight" title={title}>
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
      <div className="mt-auto flex items-center justify-between gap-2 pt-2.5 text-[11px] text-muted">
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
