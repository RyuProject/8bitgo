import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { cx } from '@/lib/format'
import { GameCover } from './GameCover'
import { useLang } from '@/services/lang'
import { useT } from '@/services/i18n'
import { genreLabel, gameTitle } from '@/services/i18nData'

interface Props {
  game: Game
  /** 名次。从 1 开始，画在最左边的角标里 */
  rank: number
  /**
   * 最右边那个数字。**由调用方给**，而且必须和这一栏的排序依据是同一个量。
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
 * 第 4 名往后走 `bg-surface-3 text-muted`：角标尺寸不变（十行的左边缘要对齐），
 * 只是退到背景里去。
 */
const MEDAL_TONES: Record<number, string> = {
  1: 'bg-coin text-[#7a4f00]',
  2: 'bg-[#c9ced6] text-[#3d434c]',
  3: 'bg-[#dda15e] text-[#4a2a0c]',
}

/**
 * 榜单用的一行：**名次角标 + 小方封面 + 标题/平台·类型 + 右侧统计值**。
 *
 * 和 GameCard 的分工：那一张是「封面占满、信息压在图上」的横向轨道卡，
 * 适合一眼扫过去挑封面；这一行是**榜**——名次要第一眼看见，十条之间要能快速比较。
 *
 * 为什么是横条不是方卡（2026-09-12 改的）：上一版是「居中小封面 + 居中两行简介」的方卡，
 * 结果是上半截一大片空白、简介又碎又基本在重复标题、名次淡得看不见。
 * 榜单本来就是**一维**的东西，用一维的排版去装，信息密度和可比性都更好，
 * 高度还少了一半。两种排版塞进同一个组件只会变成一堆互斥的 props，改一处必崩另一处。
 */
export function GameRankCard({ game, rank, metric, className }: Props) {
  const lang = useLang()
  const t = useT()
  const platform = platformMap[game.platform]
  const genreId = game.genres[0]
  const genre = genreId ? genreMap[genreId] : undefined
  const title = gameTitle(game, lang)

  return (
    <Link
      to={`/games/${game.slug}`}
      className={cx(
        'group flex items-center gap-3 rounded-card border border-line bg-surface p-2.5 transition duration-200 hover:border-brand/60 hover:bg-surface-2',
        className,
      )}
    >
      {/*
        名次角标。尺寸固定（两位数的「10」也在同一个方块里），tabular-nums 让
        个位数和两位数宽度一致，十行的左边缘才对得齐。
      */}
      <span
        aria-hidden
        className={cx(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-black leading-none tabular-nums',
          MEDAL_TONES[rank] ?? 'bg-surface-3 text-muted',
        )}
      >
        {rank}
      </span>

      {/* 封面固定成小方块：榜要的是整齐，不是每张图各自占满 */}
      <div className="size-14 shrink-0 overflow-hidden rounded-lg">
        <GameCover game={game} ratio="square" iconSize="sm" still />
      </div>

      {/* min-w-0 不能少：没有它，flex 子项的最小宽度是内容宽度，truncate 永远不生效 */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold leading-tight group-hover:text-brand-hover" title={title}>
          {title}
        </h3>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
          {/*
            平台角标用 shortName（NES / ARCADE / HTML5），不是全名 —— 这一行很窄。
            ⚠️ 底色只能用主题变量。以前这里是 bg-white/5，**浅色主题下就是纯白配纯白**，
            等于没有底 —— 深色主题里看着好好的，切到浅色就露馅。
            surface-3 而不是 surface-2：整行 hover 时底色会变成 surface-2，
            用同一档角标就在 hover 的瞬间消失了。
          */}
          {platform && (
            <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-semibold uppercase tracking-wide">
              {platform.shortName}
            </span>
          )}
          {genreId && (
            <span className="truncate">
              {genre?.icon && <span aria-hidden>{genre.icon} </span>}
              {genreLabel(t, genreId, genre?.name)}
            </span>
          )}
        </div>
      </div>

      {/* 统计值缺省就整块不画：挂一个「0」会被读成「没人玩」，而真相是「还没统计到」 */}
      {metric !== undefined && (
        <span className="flex shrink-0 items-center gap-1 pl-1 text-xs font-semibold tabular-nums text-muted">
          {metric}
        </span>
      )}
    </Link>
  )
}
