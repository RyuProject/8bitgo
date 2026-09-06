import { Link } from 'react-router-dom'
import type { Collection } from '@/types'
import { cx } from '@/lib/format'
import { GameCover } from './GameCover'
import { useT, fmt } from '@/services/i18n'

interface Props {
  collection: Collection
  className?: string
  /** 首屏可见的那几张给 true，封面会 eager 加载（同 GameCover 的 priority） */
  priority?: boolean
}

/**
 * 合集卡片：四宫格封面 + 标题 + 描述 + 作者 / 游戏数。
 *
 * 封面是**最新放入的四款游戏**拼的 2×2。为什么不让作者自己传一张封面图：
 * 合集是活的，作者今天加一款明天加一款，自动封面能一直反映最新内容；
 * 而让他传图意味着每次都要记得换，最后满屏都是过期封面。
 *
 * 不足四款时不留空格子 —— 一张就铺满、两张就左右各半、三张是「左边一大 + 右边两小」。
 * 留空格子会让新建的合集看起来像坏了。
 */
export function CollectionCard({ collection, className, priority }: Props) {
  const t = useT()
  const covers = collection.covers.slice(0, 4)

  return (
    <Link
      to={`/collections/${collection.id}`}
      className={cx(
        'group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60',
        className,
      )}
    >
      {/*
        整块封面是正方形；里面按张数分格。用 grid 而不是 flex：
        两行两列各占一半是 grid 一句话的事，而 flex 要靠百分比高度层层传下去。
      */}
      <div className="relative aspect-square w-full overflow-hidden bg-surface-2">
        <CoverGrid covers={covers} priority={priority} emptyLabel={t.collections.emptyCover} />
        <div className="absolute inset-0 bg-black/0 transition duration-300 group-hover:bg-black/15" />
      </div>

      <div className="space-y-1 p-3">
        <h3 className="truncate text-sm font-semibold leading-tight" title={collection.title}>
          {collection.title}
        </h3>
        {/*
          描述为空时占一行占位文字，而不是把这一行去掉 —— 一行卡片里有的有描述有的没有，
          高度参差不齐会让整排看起来是坏的（参考站也是这么处理的）
        */}
        <p className={cx('truncate text-[11px]', collection.description ? 'text-muted' : 'text-dim')}>
          {collection.description || t.collections.noDescription}
        </p>
        <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px]">
              {collection.author.avatar}
            </span>
            <span className="truncate">{collection.author.nickname}</span>
          </span>
          <span className="shrink-0" title={fmt(t.collections.gameCount, { n: String(collection.gameCount) })}>
            🎮 {collection.gameCount}
          </span>
        </div>
      </div>
    </Link>
  )
}

/**
 * 封面分格。张数不同排布不同，目的都是「把整块正方形填满，不留空洞」：
 *   4 张 → 2×2
 *   3 张 → 左边一张通高，右边上下两张
 *   2 张 → 左右各半
 *   1 张 → 铺满
 *   0 张 → 一句占位文字（新建还没加游戏的合集）
 */
function CoverGrid({ covers, priority, emptyLabel }: { covers: Collection['covers']; priority?: boolean; emptyLabel: string }) {
  if (!covers.length) {
    return (
      <div className="grid h-full w-full place-items-center px-3 text-center text-[11px] text-dim">{emptyLabel}</div>
    )
  }
  // 每一格自己是正方形的一半，所以给 GameCover 传 square，四张拼起来仍然是正方形
  const cell = (i: number, cls?: string) => (
    <div key={covers[i].slug} className={cx('relative overflow-hidden', cls)}>
      <GameCover game={covers[i]} ratio="square" showTitle={false} showBadge={false} priority={priority} className="h-full w-full" />
    </div>
  )
  if (covers.length === 1) return <div className="h-full w-full">{cell(0, 'h-full w-full')}</div>
  if (covers.length === 2) return <div className="grid h-full w-full grid-cols-2">{[cell(0), cell(1)]}</div>
  if (covers.length === 3) {
    return (
      <div className="grid h-full w-full grid-cols-2 grid-rows-2">
        {cell(0, 'row-span-2')}
        {cell(1)}
        {cell(2)}
      </div>
    )
  }
  return <div className="grid h-full w-full grid-cols-2 grid-rows-2">{[cell(0), cell(1), cell(2), cell(3)]}</div>
}
