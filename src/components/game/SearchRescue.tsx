/**
 * 一个都没搜到时的补救。
 *
 * 空页面是搜索体验里最差的一环 —— 用户不知道是「站里没有」还是「我打错了」。
 * 这里给两样东西：拼写建议（编辑距离纠错，zeldaa → zelda），
 * 以及把「所有词都要命中」放宽之后捞回来的相关游戏。
 *
 * 两条查询都只在真的零结果时才发，正常搜索一次都不会打到。
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useT, fmt } from '@/services/i18n'
import { gameTitle, platformLabel } from '@/services/i18nData'
import { useLang } from '@/services/lang'
import { fetchSearchFallback, searchEnabled, type SearchFallback } from '@/services/search'

export function SearchRescue({ q, onPick }: { q: string; onPick?: (q: string) => void }) {
  const t = useT()
  const lang = useLang()
  const [data, setData] = useState<SearchFallback | null>(null)

  useEffect(() => {
    const text = q.trim()
    if (!text || !searchEnabled()) {
      setData(null)
      return
    }
    let alive = true
    setData(null)
    void fetchSearchFallback(text)
      .then((r) => alive && setData(r))
      .catch(() => alive && setData(null))
    return () => {
      alive = false
    }
  }, [q])

  if (!data || (!data.suggestion && !data.related.length)) return null

  return (
    <div className="mt-6 space-y-6">
      {data.suggestion && (
        <p className="text-sm text-muted">
          {t.games.didYouMean}{' '}
          {onPick ? (
            <button type="button" onClick={() => onPick(data.suggestion as string)} className="font-semibold text-brand-hover hover:underline">
              {data.suggestion}
            </button>
          ) : (
            <Link to={`/games?q=${encodeURIComponent(data.suggestion)}`} className="font-semibold text-brand-hover hover:underline">
              {data.suggestion}
            </Link>
          )}
        </p>
      )}

      {data.related.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-fg">{fmt(t.games.relatedTitle, { q })}</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {data.related.map((g) => (
              <Link
                key={g.slug}
                to={`/games/${encodeURIComponent(g.slug)}`}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2 transition hover:border-brand"
              >
                {g.cover ? (
                  <img src={g.cover} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-white/5 text-xl" aria-hidden>
                    {g.icon || '🎮'}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{gameTitle(g, lang)}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {platformLabel(t, g.platform, g.platform)}
                    {g.year ? ` · ${g.year}` : ''}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
