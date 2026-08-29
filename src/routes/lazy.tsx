import { Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { trackPageLoad } from '@/services/progress'
import { PageSkeleton } from '@/components/ui/PageSkeleton'

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
 * 后台 chunk 第一次下载时也用全站统一骨架。顶部细条负责说明“整个跳转还没结束”，
 * 骨架负责占住正文布局；两者信息层级不同，不再让内容区空白得像没响应。
 */
export function RouteChunk({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
}
