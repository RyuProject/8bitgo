import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { ApiError, api, apiEnabled, getAdminApiToken, setAdminApiToken } from '@/services/api'
import { fetchAdminGames } from '@/services/store'

const SESSION_KEY = '8bitgo.admin.unlocked'

const TABS = [
  { to: '/admin', label: '概览', end: true },
  { to: '/admin/games', label: '游戏' },
  { to: '/admin/posts', label: '文章' },
  { to: '/admin/users', label: '用户' },
  { to: '/admin/roms', label: 'ROM 存储' },
  { to: '/admin/data', label: '数据' },
]

type GateState = 'checking' | 'locked' | 'unlocked'

/** 后台入口只信服务端对 ADMIN_TOKEN 的校验结果，密钥不会再被 Vite 打进公开的前端文件。 */
export function AdminLayout() {
  useDocumentTitle('后台管理')
  const [gate, setGate] = useState<GateState>(() => {
    try {
      return getAdminApiToken() && sessionStorage.getItem(SESSION_KEY) === '1' ? 'checking' : 'locked'
    } catch {
      return 'locked'
    }
  })

  const lock = useCallback(() => {
    setAdminApiToken(null)
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
    setGate('locked')
  }, [])

  // 刷新后台时可以沿用当前标签页的会话，但仍要回服务端重新验一次，不能只信浏览器里的标记。
  useEffect(() => {
    if (gate !== 'checking') return
    let cancelled = false
    api
      .get<{ ok: true }>('/api/admin/verify', true)
      .then(() => {
        if (!cancelled) setGate('unlocked')
      })
      .catch(() => {
        if (!cancelled) lock()
      })
    return () => {
      cancelled = true
    }
  }, [gate, lock])

  if (gate !== 'unlocked') {
    return <Gate checking={gate === 'checking'} onUnlock={() => setGate('unlocked')} />
  }

  return <AdminShell onLock={lock} />
}

/** 验证成功后才挂载后台及其子路由，未登录时不会提前请求任何管理数据。 */
function AdminShell({ onLock }: { onLock: () => void }) {
  /**
   * v1 在这里把整个游戏库和全部文章灌进一个前端 store，子页面再从里面读。
   * v2 没有那个 store 了 —— 每个子页面自己按需向后端取数（分页 / 按 slug）。
   * 所以这里只剩一件事：先探一次后端，让子页面进来之前就知道「能不能读写」，
   * 免得每一页都各自渲染一遍「连不上」的空状态。
   */
  const [data, setData] = useState<DataState>(() => (apiEnabled() ? 'loading' : 'local'))
  const [dataError, setDataError] = useState('')

  const load = useCallback(() => {
    if (!apiEnabled()) return
    setData('loading')
    setDataError('')
    // 两步都要探：/api/health 只说明进程活着、数据库通着，
    // 但后台的读写还要过管理员口令那一关。只探 health 的话，口令没配对
    // 徽章仍然显示「数据库」，要点进任意一页才会看到 403。
    void (async () => {
      try {
        const h = await api.get<{ db?: boolean }>('/api/health')
        if (!h.db) throw new Error('后端在线，但数据库连接异常')
        await fetchAdminGames({ pageSize: 1 })
        setData('db')
      } catch (e: unknown) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          onLock()
          return
        }
        setData('error')
        setDataError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [onLock])

  useEffect(load, [load])

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
 * 数据来源徽章：一眼看清后台此刻能不能读写。
 * - 数据库：后端与数据库都通，管理员口令也有效，增删改直接写 MySQL
 * - 连接失败：后端不通 / 数据库异常 / 口令不对，后台**读也读不到、写也写不了**
 * - 未配置后端：没填 VITE_API_URL。v2 的后台没有本地兜底，此时是个空壳
 */
function DataBadge({ state, error, onRetry }: { state: DataState; error: string; onRetry: () => void }) {
  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="hidden items-center gap-1.5 rounded-md bg-[color:var(--color-coin-soft)] px-2 py-1 text-[color:var(--color-live)] transition hover:brightness-95 sm:inline-flex"
        title={`连不上后端、数据库异常，或管理员口令无效 —— 后台现在读不到也写不了。点一下重试。\n${error}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-live)]" />
        后端不可用
      </button>
    )
  }

  if (state === 'loading') {
    return (
      <span className="hidden items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-muted sm:inline-flex">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-dim" />
        正在连接后端…
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
      className="hidden items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-muted sm:inline-flex"
      title="未配置 VITE_API_URL。后台的数据全部来自后端，没有后端时列表是空的，也保存不了任何修改。"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-dim" />
      未配置后端
    </span>
  )
}

function Gate({ checking, onUnlock }: { checking: boolean; onUnlock: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const key = value.trim()
    if (!key || submitting || checking) return
    setSubmitting(true)
    setError(false)
    setAdminApiToken(key)
    try {
      await api.get<{ ok: true }>('/api/admin/verify', true)
      try {
        sessionStorage.setItem(SESSION_KEY, '1')
      } catch {
        /* ignore */
      }
      onUnlock()
    } catch {
      setAdminApiToken(null)
      setError(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <form onSubmit={submit} aria-label="后台登录" className="w-full max-w-sm space-y-3">
        <input
          type="password"
          autoFocus
          required
          disabled={checking || submitting}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(false)
          }}
          aria-invalid={error}
          aria-label="管理员密钥"
          placeholder={error ? '密钥不正确' : '管理员密钥'}
          className={cx(
            'h-11 w-full rounded-lg border bg-surface px-3 text-sm shadow-sm focus:outline-none disabled:cursor-wait disabled:opacity-60',
            error ? 'border-live focus:border-live' : 'border-line focus:border-brand',
          )}
        />
        <button
          type="submit"
          disabled={checking || submitting}
          className="h-11 w-full rounded-lg bg-brand text-sm font-semibold text-white transition hover:bg-brand-hover disabled:cursor-wait disabled:opacity-60"
        >
          {checking || submitting ? '确认中…' : '确认'}
        </button>
      </form>
    </div>
  )
}
