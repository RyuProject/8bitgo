import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

interface Props {
  page: number
  totalPages: number
  onChange: (page: number) => void
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

export function Pagination({ page, totalPages, onChange }: Props) {
  const t = useT()
  if (totalPages <= 1) return null
  const btn =
    'grid h-9 min-w-9 place-items-center rounded-lg border border-line px-2 text-sm transition hover:border-brand hover:text-brand-hover disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg'

  return (
    <nav className="flex flex-wrap items-center justify-center gap-2" aria-label={t.common.pagination}>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t.common.prevPage}
      </button>
      {range(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-1 text-muted">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            aria-current={p === page ? 'page' : undefined}
            className={cx(btn, p === page && 'border-brand bg-brand text-white hover:text-white')}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        className={btn}
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        {t.common.nextPage}
      </button>
    </nav>
  )
}
