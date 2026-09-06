import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

interface Props {
  page: number
  totalPages: number
  onChange: (page: number) => void
  /**
   * 第 n 页的站内路径，**不带语言前缀**（前缀由 router 的 basename 补上，
   * 和站里其他 <Link> 一致）。传了才会渲染成真链接。
   */
  hrefFor?: (page: number) => string
}

function range(page: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set<number>([1, total, page - 1, page, page + 1])
  const list = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && list[i] - list[i - 1] > 1) out.push('…')
    out.push(list[i])
  }
  return out
}

/**
 * 分页。
 *
 * ⚠️ 页码必须是真的 `<a href>`，别改回纯 `<button onClick>`。
 *
 * 以前这里三种控件全是 button：浏览器点得动，但页面 HTML 里**一条指向第 2 页的
 * 链接都没有**。后果是第 2 页往后的游戏在站内没有任何入口 —— 只能靠 sitemap 被发现，
 * 拿不到一点内链权重，收录也慢。平台页/类型页那边 canonical 早就按 `?page=N` 指向
 * 自己了（见 CollectionPage.tsx），可没有链接可循，那份 canonical 是空转的。
 *
 * 现在的写法两头都顾上：
 *  - 普通左键点击 → preventDefault 后交回 onChange，前端路由、滚动位置、
 *    「加载更多」的状态全部和改动前一样；
 *  - Ctrl / ⌘ / Shift / 中键 → 不拦，按真链接开新标签（顺手补上了原来缺的这个交互）；
 *  - 爬虫 → 看到的是 href，能顺着翻下去。
 *
 * hrefFor 不传时退回按钮，行为与改动前完全一致。
 */
export function Pagination({ page, totalPages, onChange, hrefFor }: Props) {
  const t = useT()
  if (totalPages <= 1) return null
  const btn =
    'grid h-9 min-w-9 place-items-center rounded-lg border border-line px-2 text-sm transition hover:border-brand hover:text-brand-hover disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg'

  /** 左键单击走前端路由；带修饰键或中键的点击留给浏览器 */
  const go = (e: MouseEvent<HTMLAnchorElement>, p: number) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onChange(p)
  }

  const item = (p: number, label: ReactNode, key: string, current = false) => {
    const cls = cx(btn, current && 'border-brand bg-brand text-white hover:text-white')
    const aria = current ? ('page' as const) : undefined
    return hrefFor ? (
      <Link key={key} to={hrefFor(p)} aria-current={aria} className={cls} onClick={(e) => go(e, p)}>
        {label}
      </Link>
    ) : (
      <button key={key} type="button" aria-current={aria} className={cls} onClick={() => onChange(p)}>
        {label}
      </button>
    )
  }

  /** 到头的「上一页 / 下一页」保持不可点的按钮形态，不输出死链接 */
  const edge = (label: ReactNode, key: string) => (
    <button key={key} type="button" className={btn} disabled>
      {label}
    </button>
  )

  return (
    <nav className="flex flex-wrap items-center justify-center gap-2" aria-label={t.common.pagination}>
      {page <= 1 ? edge(t.common.prevPage, 'prev') : item(page - 1, t.common.prevPage, 'prev')}
      {range(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-1 text-muted">
            …
          </span>
        ) : (
          item(p, p, `p${p}`, p === page)
        ),
      )}
      {page >= totalPages ? edge(t.common.nextPage, 'next') : item(page + 1, t.common.nextPage, 'next')}
    </nav>
  )
}
