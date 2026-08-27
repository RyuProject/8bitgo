import { useEffect, useRef } from 'react'
import type { InfiniteList } from '@/services/infinite'
import { fmt, useT } from '@/services/i18n'
import { Button } from './Button'

/**
 * 列表底部：滚到附近自动接下一页，同时保留一个能点的按钮。
 *
 * 按钮不是摆设 —— 纯靠滚动触发的无限列表对键盘和读屏用户是死路，
 * 他们没有「滚到底部」这个动作可用。自动加载次数用完之后，
 * 这个按钮也是唯一的继续方式。
 *
 * 哨兵放在离底部 400px 的地方提前触发，让下一页在用户滚到之前就到位。
 */
export function InfiniteFooter({ list, pageSize }: { list: InfiniteList<unknown>; pageSize: number }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const { hasMore, autoAllowed, loading, loadMoreAuto } = list

  useEffect(() => {
    const el = ref.current
    if (!el || !hasMore || !autoAllowed || loading) return
    // 老浏览器没有 IntersectionObserver：什么都不做，按钮仍然可用
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreAuto()
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, autoAllowed, loading, loadMoreAuto])

  const shown = list.items.length
  // 一页都没满就别显示「到底了」，那属于废话
  const worthClosing = list.total > pageSize

  return (
    <div className="mt-10 flex flex-col items-center gap-3">
      <div ref={ref} aria-hidden className="h-px w-full" />

      {list.error && (
        <p className="text-sm text-live" role="alert">
          {list.error}
        </p>
      )}

      {hasMore ? (
        <>
          <Button variant="secondary" size="sm" onClick={list.loadMore} disabled={loading}>
            {loading ? t.common.loadingMore : t.common.loadMore}
          </Button>
          {/* 读屏用户靠这一句知道又接进来多少条 */}
          <p className="text-xs text-muted" aria-live="polite">
            {fmt(t.common.loadedOf, { n: shown, total: list.total })}
          </p>
        </>
      ) : (
        worthClosing && <p className="text-xs text-muted">{t.common.listEnd}</p>
      )}
    </div>
  )
}
