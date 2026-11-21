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
