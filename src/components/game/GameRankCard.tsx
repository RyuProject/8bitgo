import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { genreMap } from '@/data/genres'
import { cx } from '@/lib/format'
import { GameCover } from './GameCover'
import { useT } from '@/services/i18n'
import { genreLabel } from '@/services/i18nData'

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
 * 榜单用的游戏卡片：**只有两层 —— 顶部一行「名次 + 类型」，下面一张满宽方形封面**。
 * 游戏名和游玩次数都压在封面上（同一行，名字在左、次数在右）。
 *
 * ⚠️ 封面下面**不要再加标题和简介**（2026-09-12 去掉的）。去掉之前那两样是重复的：
 * 封面上本来就压着游戏名，下面再写一遍；简介在 110~130 像素宽的卡片里只能塞两行，
 * 两行中文说不清任何事，却把卡片撑高一倍。
 *
 * ⚠️ 右上角是**游戏类型**，不是平台。平台角标封面自己左上角画着（GameCover 的
 * showBadge），两处都画平台等于一张卡上同一件事说两遍，而类型没人说。
 *
 * ⚠️ 封面必须**占满卡片宽度**。上一版是居中的 `w-20`（80 像素），五列栅格下每张卡
 * 内宽才 110~130 像素，等于故意把图缩到一半 —— 用户的原话是「看不见 cover 上是什么」。
 * **别再给封面设固定宽度。**
 *
 * 和 GameCard 的分工：那一张是横向轨道卡；这一张是**榜单**卡，名次要第一眼看见。
 * 两种排版塞进同一个组件只会变成一堆互斥的 props，改一处必崩另一处。
 *
 * 顺带：卡片里不再有长度不定的文字，所以同一行里的卡片天然等高 ——
 * 以前靠「简介固定两行 min-h」撑出来的对齐，现在是结构本身保证的。
 */
export function GameRankCard({ game, rank, metric, className }: Props) {
  const t = useT()
  const genreId = game.genres[0]
  const genre = genreId ? genreMap[genreId] : undefined

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
          类型角标。
          ⚠️ 底色只能用主题变量。以前这里是 bg-white/5，**浅色主题下就是纯白配纯白**，
          等于没有底 —— 深色主题里看着好好的，切到浅色就露馅。
        */}
        {genreId && (
          <span className="min-w-0 truncate rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
            {genre?.icon && <span aria-hidden>{genre.icon} </span>}
            {genreLabel(t, genreId, genre?.name)}
          </span>
        )}
      </div>

      {/* 封面：满宽方形，卡片有多宽它就有多宽（理由见组件头的 ⚠️） */}
      <div className="mt-2 w-full overflow-hidden rounded-lg">
        {/*
          游玩次数挂在封面标题**同一行的最右边**（GameCover 的 titleRight）。
          统计值缺省就不传：挂一个「0」会被读成「没人玩」，而真相是「还没统计到」。
        */}
        <GameCover game={game} ratio="square" iconSize="md" still titleRight={metric} />
      </div>
    </Link>
  )
}
