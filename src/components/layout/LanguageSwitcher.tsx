import { useState } from 'react'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import { LANGUAGES } from '@/config/languages'
import { setLang, useLang } from '@/services/lang'

/** 地球图标 */
function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21C9.5 18.5 8.2 15.3 8.2 12S9.5 5.5 12 3z" />
    </svg>
  )
}

/**
 * 语言切换器（地球）。点击弹出语言列表，切换后持久化并同步到 <html lang>，
 * 同时驱动「按语言自动选 ROM」。界面文字暂未翻译。
 */
export function LanguageSwitcher({ className, align = 'right' }: { className?: string; align?: 'left' | 'right' }) {
  const t = useT()
  const lang = useLang()
  const [open, setOpen] = useState(false)
  const currentLabel = LANGUAGES.find((l) => l.code === lang)?.label ?? ''

  return (
    <div className={cx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t.language.switch}
        aria-haspopup="menu"
        aria-expanded={open}
        title={fmt(t.language.current, { label: currentLabel })}
        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-black/5 hover:text-fg"
      >
        <GlobeIcon />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" aria-hidden onClick={() => setOpen(false)} />
          <div
            role="menu"
            className={cx(
              'absolute top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-2xl shadow-black/20',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold text-dim">{t.language.heading}</p>
            {LANGUAGES.map((l) => {
              const active = l.code === lang
              return (
                <button
                  key={l.code}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    setLang(l.code)
                    setOpen(false)
                  }}
                  className={cx(
                    'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition',
                    active ? 'bg-brand-soft font-semibold text-fg' : 'text-muted hover:bg-black/5 hover:text-fg',
                  )}
                >
                  <span>{l.label}</span>
                  {active && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
