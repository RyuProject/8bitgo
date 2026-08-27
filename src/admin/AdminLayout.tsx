import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { hasLocalChanges, hydrateGames, useAllGames } from '@/services/store'
import { hydratePosts } from '@/services/posts'
import { apiEnabled } from '@/services/api'

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
  /**
   * 后台要看到「全部」游戏与文章，包括已下架 / 未发布的。
   *
   * 前台走 SSR 时，服务端注入的数据是过滤过的（hidden=0 / published=1），
   * 而且客户端不会再去调 hydrateGames()，所以后台直接用那份数据会看不到下架的条目，
   * 也就没法把它重新上架。这里进后台时用管理员身份拉一次完整列表（/api/games?all=1）。
   */
  const [data, setData] = useState<DataState>(() => (apiEnabled() ? 'loading' : 'local'))
  const [dataError, setDataError] = useState('')

  const load = useCallback(() => {
    if (!apiEnabled()) return
    setData('loading')
    setDataError('')
    Promise.all([hydrateGames(true), hydratePosts(true)])
      .then(() => setData('db'))
      .catch((e: unknown) => {
        setData('error')
        setDataError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  useEffect(load, [load])

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
            <DataBadge state={data} error={dataError} onRetry={load} />
            <Link to="/" className="rounded-lg border border-line px-3 py-1.5 transition hover:border-brand hover:text-fg">
              ← 返回网站
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Outlet context={{ state: data, error: dataError, reload: load } satisfies AdminData} />
      </main>
    </div>
  )
}

export type DataState = 'local' | 'loading' | 'db' | 'error'

/** 后台各页共享的数据源状态（通过 Outlet context 下发） */
export interface AdminData {
  state: DataState
  error: string
  reload: () => void
}

/** 子页面读取当前数据源状态 */
export function useAdminData(): AdminData {
  return useOutletContext<AdminData>()
}

/**
 * 数据来源徽章：一眼看清后台改的东西究竟写到哪。
 * - 数据库：配了 VITE_API_URL 且刚才拉取成功，增删改直接写 MySQL
 * - 连接失败：配了后端但拉不动（后端没起 / 数据库不通），此时改动只会留在浏览器里
 * - 本地存储：没配 VITE_API_URL，纯浏览器模式
 */
function DataBadge({ state, error, onRetry }: { state: DataState; error: string; onRetry: () => void }) {
  useAllGames() // 订阅变化，本地模式下改完立刻刷新文案
  const local = hasLocalChanges()

  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="hidden items-center gap-1.5 rounded-md bg-[color:var(--color-coin-soft)] px-2 py-1 text-[color:var(--color-live)] transition hover:brightness-95 sm:inline-flex"
        title={`连不上后端，改动只会留在这台浏览器里。点一下重试。\n${error}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-live)]" />
        数据库连接失败
      </button>
    )
  }

  if (state === 'loading') {
    return (
      <span className="hidden items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-muted sm:inline-flex">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-dim" />
        正在读取数据库…
      </span>
    )
  }

  if (state === 'db') {
    return (
      <span
        className="hidden items-center gap-1.5 rounded-md bg-brand-soft px-2 py-1 text-brand-hover sm:inline-flex"
        title="已连接后端，后台的增删改会直接写入 MySQL"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-brand" />
        数据库
      </span>
    )
  }

  return (
    <span
      className={cx(
        'hidden items-center gap-1.5 rounded-md px-2 py-1 sm:inline-flex',
        local ? 'bg-coin-soft text-coin' : 'bg-surface-2 text-muted',
      )}
      title={
        local
          ? '未配置后端（VITE_API_URL），改动只保存在这台浏览器的 localStorage 里'
          : '未配置后端（VITE_API_URL），当前用的是内置数据'
      }
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
