import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { ApiError, api, apiEnabled, getAdminApiToken, getToken, setAdminApiToken } from '@/services/api'
import { fetchAdminGames } from '@/services/store'
import { ensureRomCredential } from '@/services/romUploadCredential'
import { ABILITIES, ROLE_LABELS, type Ability, type UserRole } from '../../shared/roles.js'
import { AdminHealthProvider, hasHealthError, useAdminHealth } from './adminHealth'

const SESSION_KEY = '8bitgo.admin.unlocked'

/**
 * 每一页配一个权限点，志愿者进来时导航按它收窄。
 *
 * 藏起来只是体面 —— 真正拦人的是服务端各路由上的 requireAbility（shared/roles.js
 * 是前后端共用的那张表）。这里的作用只是别让志愿者看见一堆点了就 403 的入口。
 */
const TABS: { to: string; label: string; end?: boolean; need: Ability; group: string; adminOnly?: true }[] = [
  { to: '/admin', label: '概览', end: true, need: 'content:edit', group: '工作台' },
  // 与 /api/admin/startup-diagnostics 同一权限点（和概览里的启动统计一致）
  { to: '/admin/diagnostics', label: '错误诊断', need: 'content:edit', group: '工作台' },
  // MiniMax Key 与修补会影响所有玩家，和服务端 /api/admin/ai 一样用 site:manage
  { to: '/admin/ai', label: 'AI 修补', need: 'site:manage', group: '工作台' },
  { to: '/admin/games', label: '游戏', need: 'games:edit', group: '内容管理' },
  { to: '/admin/posts', label: '文章', need: 'posts:edit', group: '内容管理' },
  { to: '/admin/developers', label: '开发商', need: 'content:edit', group: '内容管理' },
  { to: '/admin/apps', label: '应用', need: 'content:edit', group: '内容管理' },
  { to: '/admin/comments', label: '评论', need: 'comments:review', group: '内容管理' },
  { to: '/admin/open-apps', label: '开放平台', need: 'apps:review', group: '内容管理' },
  { to: '/admin/users', label: '用户', need: 'users:manage', group: '运营管理' },
  { to: '/admin/friend-links', label: '友情链接', need: 'content:edit', group: '运营管理' },
  /*
    公告条用的不是 content:edit 而是 site:manage：它是在**替站点本身说话**
    （「站点在波动」/「抱歉，是我搞坏的」），不是某一款游戏的资料 ——
    志愿者的那一档权限是「改错了看得见也改得回来」的内容协作，
    而这一条是每个访客进门第一眼看到的东西。服务端同一权限点，两边一致。
  */
  { to: '/admin/notice', label: '公告', need: 'site:manage', group: '运营管理' },
  { to: '/admin/roms', label: 'ROM 存储', need: 'site:manage', group: '站点设置' },
  { to: '/admin/data', label: '数据', need: 'site:manage', group: '站点设置' },
  /*
    ⚠️ `adminOnly` 不是「再保险一层」，是**和服务端对齐**。

    /api/admin/config 用的是 requireAdmin（钉死 admin），不是 requireAbility('site:manage')——
    理由见 server/src/routes/admin-config.js 的文件头：那一页回的是基础设施信息和密钥指纹，
    不该跟着 ROLE_ABILITIES 那张**会被改**的表一起演化。
    只写 need: 'site:manage' 的话，哪天有人把 site:manage 放给志愿者
    （比如「让运营也能管 ROM 存储」），志愿者的导航里就会多出这个入口，
    点进去稳定 403 —— 界面陈述的事实必须成立。
  */
  { to: '/admin/config', label: '配置', need: 'site:manage', group: '站点设置', adminOnly: true },
]

const NAV_GROUPS = ['工作台', '内容管理', '运营管理', '站点设置'] as const

type GateState = 'checking' | 'locked' | 'unlocked'

/** /api/admin/verify 的回包：能不能进后台，以及进来之后能干什么 */
interface VerifyResult {
  ok: true
  role: UserRole
  abilities: Ability[]
}

/**
 * 后台入口只信服务端的校验结果（`/api/admin/verify`），任何密钥都不会被 Vite 打进前端文件。
 *
 * 进得来的有**两条路**，服务端的 roleOfRequest 本来就认这两条（见 server/src/auth.js）：
 *   1. 后台口令 ADMIN_TOKEN —— 不对应任何账号，给没有账号的人留的
 *   2. **登录用户自己的账号**（users.role 是 admin / volunteer）
 *
 * ⚠️ 第 2 条以前在前端是断的：这里一上来就要求 sessionStorage 里已经有口令，
 * 否则连问都不问直接弹密钥框 —— 管理员账号明明有权限，却被自己的界面挡在外面
 * （2026-09-12 关掉 ADMIN_AUTH_DISABLED 那个后门之后就暴露了）。
 * 现在只要手里有登录令牌就先去问一次服务端，**判断权限的仍然只有服务端**：
 * 前端不读 role、不做任何本地授权，403 就退回密钥框。
 */
export function AdminLayout() {
  useDocumentTitle('后台管理')
  const [gate, setGate] = useState<GateState>(() => {
    try {
      // 这个标签页里已经用口令进过后台
      if (getAdminApiToken() && sessionStorage.getItem(SESSION_KEY) === '1') return 'checking'
    } catch {
      /* sessionStorage 可能被隐私模式禁掉，当作没有 */
    }
    // 没口令也可能进得来：登录令牌本身就是凭据，让服务端去认
    return getToken() ? 'checking' : 'locked'
  })

  /** 服务端认下来的身份。不缓存在浏览器里 —— 那等于让前端自己给自己发权限 */
  const [me, setMe] = useState<VerifyResult | null>(null)

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
      .get<VerifyResult>('/api/admin/verify', true)
      .then((res) => {
        if (cancelled) return
        setMe(res)
        setGate('unlocked')
      })
      .catch(() => {
        if (!cancelled) lock()
      })
    return () => {
      cancelled = true
    }
  }, [gate, lock])

  if (gate !== 'unlocked') {
    return (
      <Gate
        checking={gate === 'checking'}
        onUnlock={(res) => {
          setMe(res)
          setGate('unlocked')
        }}
      />
    )
  }

  const healthEnabled = !me || (me.abilities ?? [...ABILITIES]).includes('site:manage')
  return (
    <AdminHealthProvider enabled={healthEnabled}>
      <AdminShell onLock={lock} me={me} healthEnabled={healthEnabled} />
    </AdminHealthProvider>
  )
}

/** 验证成功后才挂载后台及其子路由，未登录时不会提前请求任何管理数据。 */
function AdminShell({ onLock, me, healthEnabled }: { onLock: () => void; me: VerifyResult | null; healthEnabled: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
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

  /**
   * me 为 null 只可能是「后端还没升级、verify 回包里没有 abilities」——
   * 那时按全给处理。否则前端先上、后端后上的那一小段时间里，
   * 管理员会看见一个只剩两页的后台。少给权限在这里并不是「更安全」：
   * 真正的门在服务端，这里少给只是把人挡在自己的后台外面。
   */
  const abilities: Ability[] = me?.abilities ?? [...ABILITIES]
  const canManageSite = abilities.includes('site:manage')
  // 后台上传 / 清理 / 游戏表单都要 Worker 口令：管理员登录后自动领一张短期凭据，并在过期前续上
  useEffect(() => {
    if (!canManageSite) return
    void ensureRomCredential()
    const timer = window.setInterval(() => void ensureRomCredential(), 30 * 60_000)
    return () => window.clearInterval(timer)
  }, [canManageSite])
  const tabs = TABS.filter((t) => abilities.includes(t.need) && (!t.adminOnly || me?.role === 'admin'))
  const routeTab = TABS.find((t) => (
    t.end ? location.pathname === t.to : location.pathname === t.to || location.pathname.startsWith(`${t.to}/`)
  ))
  /*
    只隐藏导航不算权限控制：手输 /admin/roms 仍会挂载页面，页面自己的副作用甚至可能先跑。
    服务端当然还会拒绝，但这里也在 Outlet 挂载前挡住，让志愿者始终只进入获准的两个库。
  */
  const routeDenied = me?.role === 'volunteer' && (!routeTab || !tabs.includes(routeTab))
  const firstAllowed = tabs[0]?.to ?? '/'

  const visibleGroups = NAV_GROUPS.map((group) => ({ group, items: tabs.filter((tab) => tab.group === group) }))
    .filter(({ items }) => items.length > 0)

  // x 轴只裁切溢出，不创建滚动容器；否则左侧 sticky 导航会随页面一起滚走。
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg text-fg lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm text-white">⚙</span>
          <span className="text-pixel text-xs">8BitGo <span className="text-brand-hover">Admin</span></span>
        </div>
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-5" aria-label="后台导航">
          {visibleGroups.map(({ group, items }) => (
            <section key={group} aria-label={group}>
              <h2 className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">{group}</h2>
              <div className="space-y-0.5">
                {items.map((tab) => (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    end={tab.end}
                    className={({ isActive }) => cx(
                      'flex items-center rounded-lg px-3 py-2 text-sm transition',
                      isActive ? 'bg-brand-soft font-semibold text-brand-hover' : 'text-muted hover:bg-black/5 hover:text-fg',
                    )}
                  >
                    <span>{tab.label}</span>
                    {tab.to === '/admin' && <AdminTaskBadge />}
                  </NavLink>
                ))}
              </div>
            </section>
          ))}
        </nav>
        <div className="shrink-0 space-y-3 border-t border-line px-4 py-4">
          {me && me.role !== 'admin' && <span className="inline-flex rounded bg-brand-soft px-2 py-1 text-xs text-brand-hover">{ROLE_LABELS[me.role]}</span>}
          {healthEnabled && <AdminTaskCard />}
          <DataBadge state={data} error={dataError} onRetry={load} />
          <Link to="/" className="flex items-center rounded-lg border border-line px-3 py-2 text-sm text-muted transition hover:border-brand hover:text-fg">
            ← 返回网站
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur lg:hidden">
          <div className="flex min-h-14 items-center gap-3 px-4 py-2">
            <Link to="/admin" className="flex shrink-0 items-center gap-2" aria-label="8BitGo 后台概览">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-white">⚙</span>
              <span className="text-pixel text-[10px]">Admin</span>
            </Link>
            <select
              aria-label="跳转到后台页面"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-sm text-fg"
              value={routeTab?.to ?? tabs[0]?.to ?? ''}
              onChange={(event) => navigate(event.target.value)}
            >
              {visibleGroups.map(({ group, items }) => (
                <optgroup key={group} label={group}>
                  {items.map((tab) => <option key={tab.to} value={tab.to}>{tab.label}</option>)}
                </optgroup>
              ))}
            </select>
            <DataBadge state={data} error={dataError} onRetry={load} />
            <Link to="/" className="shrink-0 text-xs text-muted">网站</Link>
          </div>
        </header>

        <main className="mx-auto w-full min-w-0 max-w-[1600px] px-4 py-6 sm:px-6 xl:px-8">
          {routeDenied ? (
            <Navigate to={firstAllowed} replace />
          ) : (
            <Outlet
              context={{
                state: data,
                error: dataError,
                reload: load,
                abilities,
                role: me?.role ?? 'admin',
              } satisfies AdminData}
            />
          )}
        </main>
      </div>
    </div>
  )
}

export type DataState = 'local' | 'loading' | 'db' | 'error'

/** 后台各页共享的数据源状态（通过 Outlet context 下发） */
export interface AdminData {
  state: DataState
  error: string
  reload: () => void
  /** 当前身份能做什么（shared/roles.js）。子页面据此决定画不画某个操作 */
  abilities: Ability[]
  /** 用于把「发布 / 上架」等主库语义改成志愿者个人库语义，不承担授权。 */
  role: UserRole
}

/** 子页面读取当前数据源状态 */
export function useAdminData(): AdminData {
  return useOutletContext<AdminData>()
}

function taskMetrics(snapshot: ReturnType<typeof useAdminHealth>['snapshot']) {
  const queues = snapshot && !hasHealthError(snapshot.jobs) ? snapshot.jobs.queues : []
  const active = queues.reduce((count, queue) => count + queue.active, 0)
  const queued = queues.reduce((count, queue) => count + queue.queued, 0)
  const stalled = queues.reduce((count, queue) => count + queue.stalled, 0)
  const attention = snapshot?.alerts.filter((alert) => alert.level !== 'info').length ?? 0
  return { active, queued, stalled, attention, count: stalled || attention || active + queued }
}

/** 独立订阅健康状态，避免每分钟的任务轮询重渲染整棵后台页面。 */
function AdminTaskBadge() {
  const { snapshot } = useAdminHealth()
  if (!snapshot) return null
  const { active, queued, stalled, attention, count } = taskMetrics(snapshot)
  return (
    <span
      className={cx(
        'ml-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] tabular-nums',
        stalled || attention ? 'bg-live/10 text-live' : 'bg-surface-2 text-muted',
      )}
      title={`${active} 个处理中，${queued} 个排队，${stalled} 个停滞`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function AdminTaskCard() {
  const { snapshot, error } = useAdminHealth()
  const { active, queued, stalled, attention } = taskMetrics(snapshot)
  return (
    <Link to="/admin" className="block rounded-xl border border-line bg-surface-2 px-3 py-2 transition hover:border-brand/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">后台任务</span>
        <span className={cx('rounded-full px-1.5 py-0.5 text-[10px]', stalled || attention || error ? 'bg-live/10 text-live' : 'bg-brand-soft text-brand-hover')}>
          {error ? '状态异常' : !snapshot ? '读取中' : stalled ? `${stalled} 个停滞` : attention ? `${attention} 项需关注` : `${active + queued} 个进行中`}
        </span>
      </div>
      <p className="mt-1 truncate text-[10px] text-dim">
        {error ? '点此查看站点状态并重试' : snapshot ? `转换中 ${active} · 排队 ${queued} · 需关注 ${attention}` : '正在汇总转换、内容与启动状态'}
      </p>
    </Link>
  )
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

function Gate({ checking, onUnlock }: { checking: boolean; onUnlock: (res: VerifyResult) => void }) {
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
      const res = await api.get<VerifyResult>('/api/admin/verify', true)
      try {
        sessionStorage.setItem(SESSION_KEY, '1')
      } catch {
        /* ignore */
      }
      onUnlock(res)
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
          className="green-action h-11 w-full text-sm disabled:cursor-wait disabled:opacity-60"
        >
          {checking || submitting ? '确认中…' : '确认'}
        </button>
      </form>
    </div>
  )
}
