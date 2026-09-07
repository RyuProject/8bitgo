import { useEffect, useRef, useState, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import type { Collection, CoverGame } from '@/types'
import { cx } from '@/lib/format'
import { romUrlForKey } from '@/services/roms'
import { GameCover } from './GameCover'
import { useT, fmt } from '@/services/i18n'

/** 四宫格每隔多久换一格 */
const ROTATE_MS = 4_000
/** 淡入时长，和 index.css 里 --animate-cover-fade-in 的 500ms 对齐；旧图要等它淡完再撤 */
const FADE_MS = 500
/** 四宫格摆几张 */
const SHOWN = 4

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
  const pool = collection.covers

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
        <CoverGrid pool={pool} priority={priority} emptyLabel={t.collections.emptyCover} />
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
 *
 * 超过 4 款时四宫格**轮播**：每隔 ROTATE_MS 随机挑一格，换成合集里当前没露出来的另一款，
 * 让访客不点进去也看得出这个合集大概装了什么（用户 09-07 提的）。
 * 只在卡片进入视口、页面在前台、用户没开「减少动态效果」时才转 —— 首页一栏十几张卡，
 * 全在后台空转是白烧电。
 */
function CoverGrid({ pool, priority, emptyLabel }: { pool: CoverGame[]; priority?: boolean; emptyLabel: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const shown = useCoverRotation(pool, rootRef)
  const rotating = pool.length > SHOWN

  if (!pool.length) {
    return (
      <div className="grid h-full w-full place-items-center px-3 text-center text-[11px] text-dim">{emptyLabel}</div>
    )
  }
  // 每一格自己是正方形的一半，所以给 GameCover 传 square，四张拼起来仍然是正方形。
  // key 用格子的序号而不是游戏：轮播换图时格子不动、里面的图淡入淡出（见 Tile）
  const cell = (i: number, cls?: string) => (
    <div key={i} className={cx('relative overflow-hidden', cls)}>
      <Tile game={pool[shown[i]] ?? pool[i]} priority={priority} still={rotating} />
    </div>
  )
  const n = Math.min(pool.length, SHOWN)
  if (n === 1) return <div className="h-full w-full">{cell(0, 'h-full w-full')}</div>
  if (n === 2) return <div className="grid h-full w-full grid-cols-2">{[cell(0), cell(1)]}</div>
  if (n === 3) {
    return (
      <div className="grid h-full w-full grid-cols-2 grid-rows-2">
        {cell(0, 'row-span-2')}
        {cell(1)}
        {cell(2)}
      </div>
    )
  }
  return (
    <div ref={rootRef} className="grid h-full w-full grid-cols-2 grid-rows-2">
      {[cell(0), cell(1), cell(2), cell(3)]}
    </div>
  )
}

/**
 * 一格封面，换图时交叉淡入：新图带 animate-cover-fade-in 压在旧图上面，淡完再把旧图撤掉。
 * 旧图不撤早了 —— 撤早了新图淡入那 500ms 露的是底色，看着像闪了一下。
 */
function Tile({ game, priority, still }: { game: CoverGame; priority?: boolean; still: boolean }) {
  const [cur, setCur] = useState(game)
  const [prev, setPrev] = useState<CoverGame | null>(null)

  useEffect(() => {
    if (game.slug === cur.slug) return
    setPrev(cur)
    setCur(game)
    const timer = window.setTimeout(() => setPrev(null), FADE_MS + 50)
    return () => window.clearTimeout(timer)
  }, [game, cur])

  return (
    <div className="relative h-full w-full">
      {prev && (
        <div className="absolute inset-0">
          <GameCover game={prev} ratio="square" showTitle={false} showBadge={false} still className="h-full w-full" />
        </div>
      )}
      {/* key 换了才会重新挂载、动画才会重新播；首屏那一张不播（cur === 初始 game 时没有 prev） */}
      <div key={cur.slug} className={cx('absolute inset-0', prev && 'animate-cover-fade-in')}>
        <GameCover game={cur} ratio="square" showTitle={false} showBadge={false} still={still} priority={priority && !prev} className="h-full w-full" />
      </div>
    </div>
  )
}

/**
 * 轮播状态：四个格子各自摆的是 pool 里第几款。超过 4 款才转，否则就是 [0,1,2,3] 不动。
 *
 * 每一拍：随机挑一格（不挑上一拍刚换过的那格，免得同一格连着跳）、随机挑一款当前没露出来的，
 * **先把它的封面图预加载好再换** —— 不预加载的话换进来的是一格底色、图片再慢慢出现，
 * 那不是淡入，是闪屏。图加载失败这一拍就跳过。
 * 各张卡片的起拍时间随机错开：首页一栏十几张卡若同一秒一起换，看起来像整页在抽搐。
 */
function useCoverRotation(pool: CoverGame[], rootRef: RefObject<HTMLDivElement | null>): number[] {
  const [shown, setShown] = useState<number[]>(() => Array.from({ length: SHOWN }, (_, i) => i))
  /** 最新 shown 的镜像：tick 里要读它，而 tick 是定时器回调，闭包里的 state 会过时 */
  const shownRef = useRef(shown)
  shownRef.current = shown
  const inView = useInView(rootRef)
  const reduced = usePrefersReducedMotion()
  const lastTile = useRef(-1)
  /** pool 变了（列表刷新、同一张卡换了合集）就从头来。首次挂载不算「变了」 */
  const poolKey = pool.map((g) => g.slug).join('|')
  const seenKey = useRef(poolKey)
  useEffect(() => {
    if (seenKey.current === poolKey) return
    seenKey.current = poolKey
    setShown(Array.from({ length: SHOWN }, (_, i) => i))
    lastTile.current = -1
  }, [poolKey])

  useEffect(() => {
    if (pool.length <= SHOWN || !inView || reduced) return
    let timer = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      // 切到别的标签页就不换：换了也没人看，回来时再接着转
      if (document.visibilityState === 'hidden') return schedule(ROTATE_MS)
      const cur = shownRef.current
      const hidden = pool.map((_, i) => i).filter((i) => !cur.includes(i))
      if (hidden.length) {
        let tile = Math.floor(Math.random() * SHOWN)
        if (tile === lastTile.current) tile = (tile + 1) % SHOWN
        const next = hidden[Math.floor(Math.random() * hidden.length)]
        const game = pool[next]
        const swap = () => {
          if (cancelled) return
          lastTile.current = tile
          setShown((latest) => {
            // 预加载期间这一款已经在格子里了（理论上不会，守一下）：这一拍作废
            if (latest.includes(next)) return latest
            const copy = latest.slice()
            copy[tile] = next
            return copy
          })
        }
        const url = game.cover ? romUrlForKey(game.cover) : ''
        if (url) {
          const img = new Image()
          img.onload = swap
          // 加载失败就跳过这一拍（GameCover 自己会画程序化封面，但那是兜底，不值得为它换图）
          img.onerror = () => {}
          img.src = url
        } else {
          // 没有真封面的游戏：程序化封面不用加载，直接换
          swap()
        }
      }
      schedule(ROTATE_MS)
    }
    const schedule = (ms: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, ms)
    }
    // 起拍随机错开，别让一排卡片同一秒一起换
    schedule(ROTATE_MS / 2 + Math.random() * ROTATE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pool, inView, reduced])

  return shown
}

/** 元素在不在视口里（进过一次就算，卡片滚出去再滚回来不用重新等） */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setInView(e.isIntersecting)
      },
      { rootMargin: '10% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return inView
}

/** 同 HomeBanner 的那一个：用户开了「减少动态效果」就不自动换图 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}
