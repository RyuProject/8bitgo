import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Game } from '@/types'
import { GameCard } from './GameCard'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

interface Props {
  games: Game[]
  /** 作者才有手柄。false 时就是一张普通网格 */
  sortable: boolean
  disabled?: boolean
  /** 顺序变了（拖放松手 / 键盘挪了一格）。传的是新的完整顺序，父组件自己决定什么时候存 */
  onReorder: (next: Game[]) => void
  /** 压在卡片上的额外按钮（详情页那颗「移出」）。位置由调用方自己定 */
  renderActions?: (game: Game) => ReactNode
  className?: string
}

/** 手柄离视口上下边这么近时自动滚页面，不然手机上长清单拖不到底 */
const AUTOSCROLL_EDGE = 56
const AUTOSCROLL_STEP = 14

/**
 * 可拖拽排序的游戏网格。
 *
 * 用 Pointer Events 自己做，不用 HTML5 的 draggable：那套在触屏上不工作，而合集的作者
 * 一半在手机上。做法是**在流里换位**而不是拖一个浮层 —— 手柄按下后，指针每次移到另一张
 * 卡片上，就把被拖的那张换到它的位置，网格自己重排。被拖的卡片压暗 + 描边，够看出在拖谁。
 *
 * ⚠️ 手柄要 `touch-action: none`，否则触屏上第一下移动就被浏览器拿去滚页面了。
 * ⚠️ 判断「指针在哪张卡上」用 elementFromPoint 而不是算矩形：换位之后网格重排，矩形全变了；
 *    而换位后被拖的卡片正好就在指针下面，再查一次拿到的是它自己 → 不再换位 → 稳定。
 *
 * 键盘：手柄拿到焦点后方向键挪一格、Home / End 到头尾 —— 拖不了的人（读屏、开关设备）也能排。
 */
export function SortableGameGrid({ games, sortable, disabled, onReorder, renderActions, className }: Props) {
  const t = useT()
  const [dragging, setDragging] = useState<string | null>(null)
  /** 最新顺序的引用：pointermove 回调是挂在 document 上的，闭包里的 games 会过时 */
  const orderRef = useRef(games)
  orderRef.current = games
  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder
  const rootRef = useRef<HTMLDivElement>(null)

  const move = (slug: string, toIndex: number) => {
    const cur = orderRef.current
    const from = cur.findIndex((g) => g.slug === slug)
    if (from < 0 || toIndex < 0 || toIndex >= cur.length || from === toIndex) return
    const next = cur.slice()
    const [item] = next.splice(from, 1)
    next.splice(toIndex, 0, item)
    onReorderRef.current(next)
  }

  const startDrag = (slug: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !sortable) return
    // 只认主键 / 单指
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    const handle = e.currentTarget
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* 有些浏览器对已经结束的指针会抛，忽略 */
    }
    setDragging(slug)
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      // 靠边自动滚：滚动本身会让下一次 move 拿到新的 elementFromPoint 结果
      if (ev.clientY < AUTOSCROLL_EDGE) window.scrollBy(0, -AUTOSCROLL_STEP)
      else if (ev.clientY > window.innerHeight - AUTOSCROLL_EDGE) window.scrollBy(0, AUTOSCROLL_STEP)
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const card = el?.closest<HTMLElement>('[data-sortable-slug]')
      if (!card || !rootRef.current?.contains(card)) return
      const over = card.dataset.sortableSlug
      if (!over || over === slug) return
      const toIndex = orderRef.current.findIndex((g) => g.slug === over)
      move(slug, toIndex)
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      try {
        handle.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      setDragging(null)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
  }

  const onHandleKey = (slug: string) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const cur = orderRef.current
    const from = cur.findIndex((g) => g.slug === slug)
    if (from < 0) return
    let to = -1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = from - 1
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = from + 1
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = cur.length - 1
    if (to < 0 && e.key !== 'Home') return
    e.preventDefault()
    move(slug, Math.max(0, Math.min(cur.length - 1, to)))
    // 卡片换了位置，焦点要跟着那颗手柄走，不然下一次按键作用在别的卡上
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-sortable-slug="${CSS.escape(slug)}"] [data-sort-handle]`)?.focus()
    })
  }

  // 组件卸载时正在拖：把 body 上的样式还回去
  useEffect(
    () => () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    },
    [],
  )

  const canSort = sortable && games.length > 1

  return (
    <div ref={rootRef} className={cx('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', className)}>
      {games.map((g) => {
        const isDragging = dragging === g.slug
        return (
          <div
            key={g.slug}
            data-sortable-slug={g.slug}
            className={cx('relative rounded-card transition', isDragging && 'scale-[0.97] opacity-60 ring-2 ring-brand')}
          >
            <GameCard game={g} />
            {canSort && (
              <button
                type="button"
                data-sort-handle
                onPointerDown={startDrag(g.slug)}
                onKeyDown={onHandleKey(g.slug)}
                disabled={disabled}
                title={t.collections.dragToSort}
                aria-label={t.collections.dragToSort}
                // touch-action:none 是触屏能拖的前提（见文件头）
                style={{ touchAction: 'none' }}
                className="absolute left-2 top-2 z-10 grid h-7 w-7 cursor-grab place-items-center rounded-md border border-white/25 bg-black/60 text-[13px] leading-none text-white/90 backdrop-blur transition hover:bg-black/80 active:cursor-grabbing disabled:opacity-40"
              >
                ⋮⋮
              </button>
            )}
            {renderActions?.(g)}
          </div>
        )
      })}
    </div>
  )
}
