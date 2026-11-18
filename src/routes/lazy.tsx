import { Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { trackPageLoad } from '@/services/progress'
import { PageSkeleton } from '@/components/ui/PageSkeleton'
import { failedLegacyChunkFile, importWithRetry, lazyChunkFile, tagLazyFailure } from '@/services/moduleLinkRecovery'

/**
 * 按需加载一个具名导出的组件。
 *
 * 为什么要包一层 trackPageLoad：chunk 本身也要下载，第一次进后台时
 * 这一下往往比取数还慢。不挂上去的话，点了「后台」之后顶部进度条不动、
 * 页面也不变，看起来就像点了没反应。
 *
 * 失败时把 chunk 文件名挂在错误上：Safari 的 `Importing a module script failed` 不带地址；
 * legacy 的 SystemJS 又可能把文件名藏在通用错误 URL 里（2026-11-18 诊断包 #1201）。
 * 兜底页（AppErrorBoundary）据此决定资源核对或 legacy 专用恢复路径。
 *
 * 网络层失败先就地重试两次（第二次换带查询串的地址、离线时等恢复联网），见 importWithRetry
 * （2026-11-16 诊断包 #872）。chunk 与本模块同在 /assets/ 目录，所以用 import.meta.url 当基准。
 */
export function lazyNamed<K extends string, P extends object>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  const file = lazyChunkFile(load)
  return lazy(() => trackPageLoad(importWithRetry(load, file, import.meta.url))
    .catch((error: unknown) => {
      tagLazyFailure(error, file ?? failedLegacyChunkFile(error), name)
      throw error
    })
    .then((m) => ({ default: m[name] })))
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
