/**
 * 顶栏搜索框（带联想下拉）。
 *
 * 几个不太显眼但很要命的点：
 *   - 防抖：不防抖的话「塞尔达」三个字会打出三次请求，而且中文输入法每个候选字都算一次
 *   - 竞态：先发的请求可能后到。只认最后一次输入的结果，否则用户会看到自己两个字前的联想
 *   - 输入法：合成中（compositionstart ~ end）不发请求，拼音打到一半的 "s"、"se" 没有意义
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { gameTitle, platformLabel } from '@/services/i18nData'
import { useLang } from '@/services/lang'
import { fetchSuggest, rememberSearch, recentSearches, clearRecentSearches, searchEnabled, type SuggestItem } from '@/services/search'

const DEBOUNCE_MS = 200

interface Props {
  className?: string
  full?: boolean
  onSubmitted?: () => void
}

export function SearchBox({ className, full, onSubmitted }: Props) {
  const t = useT()
  const lang = useLang()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [value, setValue] = useState(params.get('q') ?? '')
  const [items, setItems] = useState<SuggestItem[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 最后一次真正发出去的查询，用来丢掉迟到的响应 */
  const latest = useRef('')
  const composing = useRef(false)

  useEffect(() => {
    setValue(params.get('q') ?? '')
  }, [params])

  // 点外面关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 防抖查询
  useEffect(() => {
    const q = value.trim()
    latest.current = q
    if (!q || !searchEnabled()) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = window.setTimeout(() => {
      if (composing.current) return
      void fetchSuggest(q)
        .then((list) => {
          // 迟到的响应直接丢：用户可能已经又打了两个字
          if (latest.current !== q) return
          setItems(list)
          setActive(-1)
        })
        .catch(() => {
          if (latest.current === q) setItems([])
        })
        .finally(() => {
          if (latest.current === q) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [value])

  const go = useCallback(
    (q: string) => {
      const text = q.trim()
      if (text) rememberSearch(text)
      setOpen(false)
      navigate(text ? `/games?q=${encodeURIComponent(text)}` : '/games')
      onSubmitted?.()
    },
    [navigate, onSubmitted],
  )

  const openGame = (item: SuggestItem) => {
    rememberSearch(value.trim())
    setOpen(false)
    navigate(`/games/${encodeURIComponent(item.slug)}`)
    onSubmitted?.()
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // 高亮着某一条时回车直达那款游戏，否则走搜索结果页
    if (active >= 0 && items[active]) openGame(items[active])
    else go(value)
  }

  const showRecent = !value.trim() && recent.length > 0
  const list = showRecent ? recent : items
  const count = list.length

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open || !count) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? count - 1 : i - 1))
    }
  }

  const onFocus = () => {
    setRecent(recentSearches())
    setOpen(true)
  }

  return (
    <div ref={boxRef} className={cx('relative', className)}>
      <form onSubmit={submit} role="search">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden>
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setOpen(true)
          }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false
            // 合成结束时 value 已经是最终的字了，手动再触发一次查询
            setValue(e.currentTarget.value)
          }}
          placeholder={t.topbar.searchPlaceholder}
          aria-label={t.topbar.searchAria}
          aria-expanded={open && count > 0}
          aria-autocomplete="list"
          role="combobox"
          autoComplete="off"
          className={cx(
            'h-10 w-full rounded-xl border border-line bg-surface pl-10 pr-16 text-sm text-fg placeholder:text-dim transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30',
            full && 'w-full',
          )}
        />
        <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1.5 py-0.5 text-[10px] text-dim md:block">
          Enter
        </kbd>
      </form>

      {open && (count > 0 || (Boolean(value.trim()) && !loading)) && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        >
          {showRecent && (
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[11px] text-muted">
              <span>{t.topbar.searchRecent}</span>
              <button
                type="button"
                className="hover:text-fg"
                onClick={() => {
                  clearRecentSearches()
                  setRecent([])
                }}
              >
                {t.topbar.searchClear}
              </button>
            </div>
          )}

          {showRecent
            ? recent.map((q, i) => (
                <button
                  key={q}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(q)}
                  className={cx(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                    i === active ? 'bg-brand-soft text-fg' : 'text-muted hover:bg-white/5',
                  )}
                >
                  <span className="text-dim" aria-hidden>
                    ↺
                  </span>
                  <span className="truncate">{q}</span>
                </button>
              ))
            : items.map((item, i) => (
                <button
                  key={item.slug}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openGame(item)}
                  className={cx(
                    'flex w-full items-center gap-3 px-3 py-2 text-left',
                    i === active ? 'bg-brand-soft' : 'hover:bg-white/5',
                  )}
                >
                  {item.cover ? (
                    <img src={item.cover} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white/5 text-lg" aria-hidden>
                      {item.icon || '🎮'}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{gameTitle(item, lang)}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {platformLabel(t, item.platform, item.platform)}
                      {item.year ? ` · ${item.year}` : ''}
                      {gameTitle(item, lang) !== item.title ? ` · ${item.title}` : ''}
                    </span>
                  </span>
                </button>
              ))}

          {!showRecent && !count && !loading && (
            <p className="px-3 py-3 text-sm text-muted">{t.topbar.searchNoHint}</p>
          )}

          {!showRecent && count > 0 && (
            <button
              type="button"
              onClick={() => go(value)}
              className="w-full border-t border-line px-3 py-2 text-left text-xs text-brand-hover hover:bg-white/5"
            >
              {t.topbar.searchViewAll}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  )
}
