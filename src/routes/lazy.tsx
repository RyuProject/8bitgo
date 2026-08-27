import { Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { trackPageLoad } from '@/services/progress'

/**
 * 按需加载一个具名导出的组件。
 *
 * 为什么要包一层 trackPageLoad：chunk 本身也要下载，第一次进后台时
 * 这一下往往比取数还慢。不挂上去的话，点了「后台」之后顶部进度条不动、
 * 页面也不变，看起来就像点了没反应。
 */
export function lazyNamed<K extends string, P extends object>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  return lazy(() => trackPageLoad(load()).then((m) => ({ default: m[name] })))
}

/**
 * 等 chunk 下载时的占位。
 *
 * 故意留空：顶部那根进度条已经在说「在加载」，这里再放骨架屏或转圈，
 * 用户会在两百毫秒里看到两次布局跳变。只留一个撑高度的空盒子，
 * 免得页脚往上蹿一下又掉回去。
 */
export function RouteChunk({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="min-h-[60vh]" aria-hidden />}>{children}</Suspense>
}
