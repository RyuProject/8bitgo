import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { pickInDirection, type Direction, type FocusRect } from '@/lib/spatialFocus'

/** 电视安全边距（overscan）：焦点元素至少离视口边缘这么远，避免被扫描线/圆角切掉 */
const DEFAULT_OVERSCAN = 120

interface FocusContextValue {
  focusedId: string | null
  setFocusedId: (id: string) => void
  overscan: number
}
const FocusContext = createContext<FocusContextValue | null>(null)

/**
 * 方向键焦点导航的作用域。把需要被遥控器/方向键走的元素都放进它里面，
 * 每个可聚焦元素用 `useFocusable(id)` 拿 `focused` / `setFocus`，
 * 并打上 `data-focus-id={id}`。
 *
 * 它负责三件事（正是「焦点引擎」要的）：
 *   1. 方向键 → 用 spatialFocus 的 pickInDirection 在**屏幕上**挑下一个，而不是按 DOM 顺序
 *   2. 焦点自动滚入可视区，且留 overscan 安全边距（window 纵向 + 各可滚动祖先横向都管）
 *   3. 粗焦点框：focused 时由调用方自己加样式（通常是 ring-4 + scale）
 *
 * Enter 等价于点一下当前焦点元素（我们这里都是 <Link>，直接跳详情/播放）。
 *
 * 没有环绕：到边就停。电视上环绕是灾难（见 spatialFocus.ts 顶部注释）。
 */
export function FocusScope({
  children,
  initialId,
  overscan = DEFAULT_OVERSCAN,
  autoFocus = true,
  className,
}: {
  children: ReactNode
  initialId?: string
  overscan?: number
  autoFocus?: boolean
  className?: string
}) {
  const [focusedId, setFocusedId] = useState<string | null>(initialId ?? null)
  const scopeRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(focusedId)
  focusedRef.current = focusedId
  const overscanRef = useRef(overscan)
  overscanRef.current = overscan

  const scrollTo = useCallback((id: string) => {
    const el = scopeRef.current?.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`)
    if (el) ensureVisible(el, overscanRef.current)
  }, [])

  const focus = useCallback(
    (id: string) => {
      setFocusedId(id)
      requestAnimationFrame(() => scrollTo(id))
    },
    [scrollTo],
  )

  // 焦点变化 → 滚到可视区（含初始）
  useEffect(() => {
    if (focusedId) scrollTo(focusedId)
  }, [focusedId, scrollTo])

  // 内容动态变化（磁贴陆续加载）时，若当前焦点已不在 DOM 上就退回第一个
  useEffect(() => {
    if (!autoFocus) return
    const scope = scopeRef.current
    if (!scope) return
    const hasCurrent = focusedId && scope.querySelector(`[data-focus-id="${CSS.escape(focusedId)}"]`)
    if (hasCurrent) return
    const first = scope.querySelector<HTMLElement>('[data-focus-id]')
    if (first?.dataset.focusId) setFocusedId(first.dataset.focusId)
  })

  // 方向键 / 回车
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const dirMap: Record<string, Direction> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        // 遥控器/手柄/ Vim 键位兜底
        KeyW: 'up',
        KeyS: 'down',
        KeyA: 'left',
        KeyD: 'right',
      }
      const dir = dirMap[e.key]
      const scope = scopeRef.current
      if (!scope) return

      if (dir) {
        const els = Array.from(scope.querySelectorAll<HTMLElement>('[data-focus-id]'))
        if (!els.length) return
        const rects: FocusRect[] = els.map((el) => {
          const r = el.getBoundingClientRect()
          return { id: el.dataset.focusId!, x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const current = focusedRef.current ?? rects[0].id
        const next = pickInDirection(rects, current, dir)
        if (next) {
          e.preventDefault()
          focus(next)
        }
        return
      }

      if (e.key === 'Enter') {
        const id = focusedRef.current
        if (!id) return
        const el = scope.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`)
        el?.click()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focus])

  return (
    <FocusContext.Provider value={{ focusedId, setFocusedId, overscan }}>
      <div ref={scopeRef} className={className}>
        {children}
      </div>
    </FocusContext.Provider>
  )
}

export function useFocusable(id: string) {
  const ctx = useContext(FocusContext)
  if (!ctx) throw new Error('useFocusable 必须在 <FocusScope> 内使用')
  return {
    focused: ctx.focusedId === id,
    setFocus: () => ctx.setFocusedId(id),
  }
}

/** 把元素滚到可视区，四周留 overscan 安全边距。纵向滚 window，横向滚最近的可滚动祖先。 */
function ensureVisible(el: HTMLElement, overscan: number) {
  const rect = el.getBoundingClientRect()
  const vh = window.innerHeight

  // 纵向：交给 window
  if (rect.top < overscan) window.scrollBy(0, rect.top - overscan)
  else if (rect.bottom > vh - overscan) window.scrollBy(0, rect.bottom - (vh - overscan))

  // 横向（以及非 window 的纵向容器）：从父级往上找可滚动祖先
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.documentElement && node !== document.body) {
    const style = getComputedStyle(node)
    const scrollableX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1
    const scrollableY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1
    const r = node.getBoundingClientRect()
    if (scrollableX) {
      if (rect.left < r.left + overscan) node.scrollLeft += rect.left - (r.left + overscan)
      else if (rect.right > r.right - overscan) node.scrollLeft += rect.right - (r.right - overscan)
    }
    if (scrollableY) {
      if (rect.top < r.top + overscan) node.scrollTop += rect.top - (r.top + overscan)
      else if (rect.bottom > r.bottom - overscan) node.scrollTop += rect.bottom - (r.bottom - overscan)
    }
    node = node.parentElement
  }
}
