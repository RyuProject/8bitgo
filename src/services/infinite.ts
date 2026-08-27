/**
 * 列表滚动续接。
 *
 * 关键取舍：**不动 URL**。
 * 往下滚时如果同步把 ?page= 改掉，usePageData 会跟着重新取数，把第一页整块换成
 * 新页的内容，而累积的后续页还挂在后面 —— 结果是同一批游戏出现两遍。
 * 所以这里只做「在当前这页后面继续接」：?page=3 进来就从第 4 页往下接，
 * 深链、分享、前进后退全都保持原来的语义。
 *
 * 自动加载有个上限（AUTO_PAGES）：屏幕够高时哨兵可能一直待在视口里，
 * 不设限的话用户站着不动都能把整库拉完。到达上限后改成必须点一下按钮。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Paged } from './pageData'

/** 连续自动加载多少页之后，改成要用户点「加载更多」 */
const AUTO_PAGES = 5

export interface InfiniteList<T> {
  /** 首页 + 已续接的所有条目 */
  items: T[]
  /** 后端报的总数 */
  total: number
  /** 还有没有下一页 */
  hasMore: boolean
  /** 是否还能自动加载（false 时哨兵不再触发，等用户点按钮） */
  autoAllowed: boolean
  loading: boolean
  error: string
  /** 用户点「加载更多」 */
  loadMore: () => void
  /** 哨兵滚进视口时触发。和 loadMore 的区别只在于它会计入自动加载次数 */
  loadMoreAuto: () => void
}

export interface InfiniteInput<T> {
  /** 当前这一页（来自 usePageData / SSR 首屏） */
  first: Paged<T> | undefined
  /**
   * first 是不是**当前这套条件**的结果。
   *
   * 这个参数不是可有可无的：usePageData 在重新取数时会刻意保留上一次的数据
   * （免得列表闪成空白），于是切换筛选之后有一小段时间，first 还是上一个条件的
   * 第 1 页 —— 它的 totalPages 可能是 2，而新条件其实只有 1 页。哨兵这时候一触发，
   * 就会拿新条件去要「第 2 页」，后端把越界页码夹回第 1 页返回，
   * 这一页又被接到列表屁股后面 —— 用户看到的是每款游戏都出现两遍。
   * 所以数据没对上条件之前，一律不许续接。
   */
  ready: boolean
  fetchPage: (page: number) => Promise<Paged<T>>
  /** 筛选条件指纹。变了就把续接的部分全部丢掉重来 */
  resetKey: string
}

export function useInfinite<T>({ first, ready, fetchPage, resetKey }: InfiniteInput<T>): InfiniteList<T> {
  const [extra, setExtra] = useState<Array<Paged<T>>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoUsed, setAutoUsed] = useState(0)
  /** 后端说「没有那一页」时置位，别再一遍遍去要 */
  const [exhausted, setExhausted] = useState(false)

  // 换筛选条件 / 换页码：把续接的部分清空
  const keyRef = useRef(resetKey)
  useEffect(() => {
    if (keyRef.current === resetKey) return
    keyRef.current = resetKey
    setExtra([])
    setError('')
    setAutoUsed(0)
    setExhausted(false)
  }, [resetKey])

  // resetKey 刚变、清空还没生效的那一帧，extra 属于上一批条件，不能拿来拼
  const stale = keyRef.current !== resetKey
  const tail = stale ? [] : extra

  const usable = ready && !stale ? first : undefined
  const loadedThrough = (usable?.page ?? 1) + tail.length
  const hasMore = Boolean(usable) && !exhausted && loadedThrough < (usable?.totalPages ?? 0)

  const load = useCallback(
    (auto: boolean) => {
      if (!usable || loading || exhausted) return
      const next = usable.page + extra.length + 1
      if (next > usable.totalPages) return
      const keyAtStart = keyRef.current
      setLoading(true)
      setError('')
      if (auto) setAutoUsed((n) => n + 1)
      fetchPage(next)
        .then((p) => {
          // 请求飞在路上时用户换了筛选条件：这批数据已经不属于当前列表了，丢掉。
          // 不判断的话会把「上一个平台的第 4 页」接到新平台的列表屁股后面
          if (keyRef.current !== keyAtStart) return
          // 后端对越界页码是「夹回合法范围」而不是报错，所以回来的可能根本不是
          // 我们要的那一页。直接接上去就是整页重复 —— 判一下页码，对不上就收工
          if (p.page !== next) {
            setExhausted(true)
            return
          }
          setExtra((e) => [...e, p])
        })
        .catch((e: unknown) => {
          if (keyRef.current !== keyAtStart) return
          setError(e instanceof Error ? e.message : '加载失败')
        })
        .finally(() => setLoading(false))
    },
    [usable, extra.length, fetchPage, loading, exhausted],
  )

  return {
    items: [...(usable?.items ?? first?.items ?? []), ...tail.flatMap((p) => p.items)],
    total: first?.total ?? 0,
    hasMore,
    autoAllowed: autoUsed < AUTO_PAGES,
    loading,
    error,
    loadMore: useCallback(() => load(false), [load]),
    loadMoreAuto: useCallback(() => load(true), [load]),
  }
}
