import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { logout, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useShell } from './ShellContext'
import { useT, fmt } from '@/services/i18n'
import { Logo } from './Logo'
import { FEATURES } from '@/config/features'

/**
 * 顶栏：移动端菜单按钮 + 搜索 + 快捷操作（玩本地 ROM / G 币 / 通知 / 登录）
 */
export function Topbar() {
  const t = useT()
  const { setMobileOpen, immersive } = useShell()
  const [searchOpen, setSearchOpen] = useState(false)
  const user = useCurrentUser()
  const location = useLocation()
  const loginTo = `/login?next=${encodeURIComponent(location.pathname + location.search)}`

  if (immersive) return null

  return (
    <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* 移动端：菜单 + Logo */}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label={t.topbar.openMenu}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-fg hover:bg-black/5 lg:hidden"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <Logo className="lg:hidden" />

        {/* 搜索 */}
        <SearchBox className="hidden flex-1 md:block md:max-w-xl" />

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            aria-label={t.topbar.search}
            aria-expanded={searchOpen}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-fg md:hidden"
          >
            <SearchIcon />
          </button>

          <Button to="/play-local" variant="secondary" size="sm" className="hidden sm:inline-flex">
            <span aria-hidden>📂</span> {t.topbar.playLocal}
          </Button>

          {FEATURES.coins && (
            <Link
              to={user ? '/me' : loginTo}
              title={user ? t.topbar.coinBalance : t.topbar.coinBalanceGuest}
              className="hidden h-9 items-center gap-1.5 rounded-lg border border-coin/30 bg-coin-soft px-3 text-xs font-semibold text-coin transition hover:border-coin/60 sm:inline-flex"
            >
              <span aria-hidden>🪙</span> {fmt(t.topbar.coinChip, { n: user ? user.coins.toLocaleString() : 0 })}
            </Link>
          )}

          {user ? (
            <UserMenu />
          ) : (
            <Button onClick={openAuthModal} size="sm">
              {t.common.login}
            </Button>
          )}
        </div>
      </div>

      {/* 移动端展开的搜索行 */}
      <div
        className={cx(
          'grid overflow-hidden transition-[grid-template-rows] duration-300 md:hidden',
          searchOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0">
          <div className="border-t border-line px-4 py-3">
            <SearchBox full onSubmitted={() => setSearchOpen(false)} />
          </div>
        </div>
      </div>
    </header>
  )
}

function UserMenu() {
  const t = useT()
  const user = useCurrentUser()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!user) return null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface pl-1 pr-2.5 text-sm transition hover:border-brand/60"
      >
        <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-soft text-base" aria-hidden>
          {user.avatar}
        </span>
        <span className="hidden max-w-[7rem] truncate font-semibold sm:block">{user.nickname}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cx('text-muted transition', open && 'rotate-180')} aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-line bg-surface p-1.5 shadow-2xl shadow-black/60">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold">{user.nickname}</p>
            <p className="truncate text-[11px] text-muted">{user.email}</p>
          </div>
          <Link to="/me" role="menuitem" onClick={() => setOpen(false)} className="block rounded-lg px-2.5 py-2 text-sm hover:bg-black/5">
            {t.topbar.menuProfile}
          </Link>
          <Link to="/me#favorites" role="menuitem" onClick={() => setOpen(false)} className="block rounded-lg px-2.5 py-2 text-sm hover:bg-black/5">
            {t.topbar.menuFavorites}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              logout()
              navigate('/')
            }}
            className="block w-full rounded-lg px-2.5 py-2 text-left text-sm text-muted hover:bg-black/5 hover:text-fg"
          >
            {t.topbar.menuLogout}
          </button>
        </div>
      )}
    </div>
  )
}

function SearchBox({ className, full, onSubmitted }: { className?: string; full?: boolean; onSubmitted?: () => void }) {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [value, setValue] = useState(params.get('q') ?? '')

  useEffect(() => {
    setValue(params.get('q') ?? '')
  }, [params])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = value.trim()
    navigate(q ? `/games?q=${encodeURIComponent(q)}` : '/games')
    onSubmitted?.()
  }

  return (
    <form onSubmit={submit} role="search" className={cx('relative', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden>
        <SearchIcon />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t.topbar.searchPlaceholder}
        aria-label={t.topbar.searchAria}
        className={cx(
          'h-10 rounded-xl border border-line bg-surface pl-10 pr-16 text-sm text-fg placeholder:text-dim transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30',
          full ? 'w-full' : 'w-full',
        )}
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1.5 py-0.5 text-[10px] text-dim md:block">
        Enter
      </kbd>
    </form>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  )
}
