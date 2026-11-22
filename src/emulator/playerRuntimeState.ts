import type { Capability, ScreenLayoutState } from './types'

export interface RuntimeGeometry {
  width: number
  height: number
}

/** 运行时可重复报告同一状态；先按值比较，避免无意义的新引用推动播放器再次渲染。 */
export function sameRuntimeCaps(a: ReadonlySet<Capability>, b: ReadonlySet<Capability>): boolean {
  if (a.size !== b.size) return false
  for (const cap of a) if (!b.has(cap)) return false
  return true
}

export function sameRuntimeGeometry(a: RuntimeGeometry | null, b: RuntimeGeometry | null): boolean {
  return a === b || Boolean(a && b && a.width === b.width && a.height === b.height)
}

export function sameRuntimeScreenLayout(a: ScreenLayoutState | null, b: ScreenLayoutState | null): boolean {
  if (a === b) return true
  if (!a || !b || a.key !== b.key || a.current !== b.current || a.values.length !== b.values.length) return false
  return a.values.every((value, index) => value === b.values[index])
}

type LiveControlsLike = {
  phase: string
  on: boolean
  viewers: number
  label: string
  hint: string
  toggle: () => void
  quality: unknown
  coop?: object | null
}

/**
 * LiveControls 每次把开关交上来都是新对象。内容没变时保留旧引用：
 * 子组件 effect 依赖里只要混进一个不稳定的值，「交上来 → 父组件 setState → 子组件重渲染 → 再交」
 * 就是一条死循环，同步优先级下 React 会抛 #185。这里在父组件这一侧再挡一道。
 */
export function sameLiveControls<T extends LiveControlsLike>(a: T | null, b: T | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.phase !== b.phase || a.on !== b.on || a.viewers !== b.viewers || a.label !== b.label ||
    a.hint !== b.hint || a.toggle !== b.toggle || a.quality !== b.quality) return false
  const ca = (a.coop ?? null) as Record<string, unknown> | null
  const cb = (b.coop ?? null) as Record<string, unknown> | null
  if (ca === cb) return true
  if (!ca || !cb) return false
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)])
  for (const key of keys) if (ca[key] !== cb[key]) return false
  return true
}
