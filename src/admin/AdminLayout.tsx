import { useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { hasLocalChanges } from '@/services/store'
import { useAllGames } from '@/services/store'

const ADMIN_KEY = import.meta.env.VITE_ADMIN_KEY?.trim() ?? ''
const SESSION_KEY = '8bitgo.admin.unlocked'

const TABS = [
  { to: '/admin', label: '概览', end: true },
  { to: '/admin/games', label: '游戏' },
  { to: '/admin/posts', label: '文章' },
  { to: '/admin/users', label: '用户' },
  { to: '/admin/roms', label: 'ROM 存储' },
  { to: '/admin/data', label: '数据' },
]

/**
 * 后台外壳：顶部标签导航 + 内容区。
 * 若 .env 里设置了 VITE_ADMIN_KEY，进入前需要输入一次口令（存在 sessionStorage，关掉标签页失效）。
 */
export function AdminLayout() {
  useDocumentTitle('后台管理')
  const [unlocked, setUnlocked] = useState(() => {
    if (!ADMIN_KEY) return true
    try {
      return sessionStorage.getItem(SESSION_KEY) === '1'
    } catch {
      return false
    }
  })

  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/admin" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-white">⚙</span>
            <span className="text-pixel text-xs">
              8BitGo <span className="text-brand-hover">Admin</span>
            </span>
          </Link>
          <nav className="ml-4 flex items-center gap-1" aria-label="后台导航">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  cx(
                    'rounded-lg px-3 py-1.5 text-sm transition',
                    isActive ? 'bg-brand-soft font-semibold text-fg' : 'text-muted hover:bg-black/5 hover:text-fg',
                  )
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            <DataBadge />
            <Link to="/" className="rounded-lg border border-line px-3 py-1.5 transition hover:border-brand hover:text-fg">
              ← 返回网站
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}

function DataBadge() {
  useAllGames() // 订阅变化以刷新状态
  const local = hasLocalChanges()
  return (
    <span
      className={cx(
        'hidden items-center gap-1.5 rounded-md px-2 py-1 sm:inline-flex',
        local ? 'bg-coin-soft text-coin' : 'bg-white/5 text-muted',
      )}
      title={local ? '当前使用的是后台修改过的数据（保存在浏览器 localStorage）' : '当前使用内置数据'}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', local ? 'bg-coin' : 'bg-dim')} />
      {local ? '本地修改版' : '内置数据'}
    </span>
  )
}

function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value === ADMIN_KEY) {
      try {
        sessionStorage.setItem(SESSION_KEY, '1')
      } catch {
        /* ignore */
      }
      onUnlock()
    } else {
      setError(true)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6">
        <p className="text-pixel text-xs text-brand-hover">ADMIN</p>
        <h1 className="mt-2 text-xl font-bold">进入后台</h1>
        <p className="mt-1 text-sm text-muted">请输入 .env 中设置的访问口令。</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(false)
          }}
          placeholder="访问口令"
          className="mt-4 h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm focus:border-brand focus:outline-none"
        />
        {error && <p className="mt-2 text-xs text-live">口令不正确</p>}
        <button type="submit" className="mt-4 h-10 w-full rounded-lg bg-brand text-sm font-semibold text-white hover:bg-brand-hover">
          进入
        </button>
      </form>
    </div>
  )
}
