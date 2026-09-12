import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useSeo } from '@/services/seo'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { ApiError } from '@/services/api'
import {
  addTester,
  createMyApp,
  myApp,
  myApps,
  removeTester,
  revokeSecret,
  rotateSecret,
  SCOPE_LABELS,
  SELF_SERVE,
  statusLabel,
  submitForReview,
  withdrawReview,
  type OpenApp,
  type OpenAppDetail,
  type SecretIssued,
} from '@/services/openApps'

/**
 * 开发者控制台 `/open` —— 申请应用、拿 AppID / AppKey、申请上产。
 *
 * ## 为什么路径是 /open 而不是设计稿里的 /developers/apps
 *
 * `/developers` 这个路径**已经被占了** —— 它是站内的「开发商」浏览页
 * （游戏的发行商列表，见 pages/BrowsePages.tsx）。两个「developer」意思完全不同：
 * 一个是科乐美，一个是接入我们 API 的人。挂在同一棵路径下只会让两边都难认。
 *
 * ## 这一页刻意是中文的
 *
 * 和 /admin 一样不走 i18n。它管理的东西本身只有中文一份：docs/open-platform.md、
 * scope 的语义说明、服务端的 OAuth 错误体。给这一页翻八种语言，而开发者点进文档
 * 又是中文，那是一种更糟的体验。等有了对外文档站再一起做（记在设计稿的待办里）。
 *
 * ## 一条产品上的硬规矩：AppKey 只显示一次
 *
 * 库里只存 bcrypt 哈希，所以「再给我看一眼」在技术上就办不到。界面必须把这件事
 * 在**给出 key 的那一刻**说清楚，而不是等他关掉弹窗之后才发现。
 */
export function OpenPlatformPage() {
  const user = useCurrentUser()
  const authReady = useAuthReady()
  useSeo({ title: '开放平台 · 开发者控制台', description: '申请接入 8BitGo 开放平台：游戏元数据、ROM 凭据、账号登录。', noindex: true })

  const [items, setItems] = useState<OpenApp[]>([])
  const [maxApps, setMaxApps] = useState(10)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState('')
  const [creating, setCreating] = useState(false)
  /** 刚发出来的 key。**只在内存里**，刷新就没 —— 这正是我们想传达的语义 */
  const [issued, setIssued] = useState<(SecretIssued & { appName: string }) | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await myApps()
      setItems(r.items)
      setMaxApps(r.maxApps || 10)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) void load()
    else setLoading(false)
  }, [user, load])

  if (!authReady) return <div className="mx-auto max-w-4xl px-4 py-10 text-sm text-muted">正在检查登录状态…</div>

  if (!user) return <Landing onLogin={() => openAuthModal()} />

  const atLimit = items.length >= maxApps

  return (
    <div className="container-x py-8 sm:py-10">
      {/* 头部 */}
      <header className="overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-brand-soft/70 to-surface p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-xs font-semibold text-brand-hover">
              <span aria-hidden>📡</span> 开放平台 · 开发者控制台
            </span>
            <h1 className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">用 8BitGo 的游戏库做你自己的东西</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              创建应用即可拿到一对<strong className="text-fg">沙箱</strong> AppID / AppKey，立刻就能调。
              想对真实用户开放时再申请上产，我们人工看一眼。
            </p>
          </div>
          <Button
            size="lg"
            className="shrink-0"
            disabled={creating || atLimit}
            onClick={() => setCreating(true)}
            title={atLimit ? `最多 ${maxApps} 个应用` : undefined}
          >
            ＋ 创建应用
          </Button>
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* 左：应用控制台 */}
        <section className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold">
              我的应用 <span className="text-muted">({items.length}{atLimit ? '' : ` / ${maxApps}`})</span>
            </h2>
            {!atLimit && (
              <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
                ＋ 新建
              </Button>
            )}
          </div>

          {creating && (
            <Modal open={creating} title="创建应用" onClose={() => setCreating(false)}>
              <CreateForm
                onCancel={() => setCreating(false)}
                onDone={(r) => {
                  setCreating(false)
                  setIssued({ ...r, appName: r.app?.name ?? '' })
                  void load()
                }}
              />
            </Modal>
          )}

          {issued && (
            <Modal
              open={!!issued}
              title={`AppKey 已生成${issued.appName ? `：${issued.appName}` : ''}`}
              onClose={() => setIssued(null)}
            >
              <SecretOnce data={issued} onClose={() => setIssued(null)} />
            </Modal>
          )}

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl bg-surface-2" />
              ))}
            </div>
          ) : error ? (
            <p className="rounded-xl border border-live/30 bg-live/5 px-4 py-3 text-sm text-live">{error}</p>
          ) : !items.length ? (
            <EmptyApps onCreate={() => setCreating(true)} />
          ) : (
            <ul className="space-y-3">
              {items.map((a) => (
                <AppCard
                  key={a.id}
                  app={a}
                  open={openId === a.id}
                  onToggle={() => setOpenId(openId === a.id ? '' : a.id)}
                  onChanged={load}
                />
              ))}
            </ul>
          )}

          <p className="mt-8 text-[11px] leading-relaxed text-dim">
            接口文档见 <Link to="/about" className="underline underline-offset-2">关于页</Link> 里的开放平台一节。
            遇到问题把 AppID（不是 AppKey！）连同报错一起发给我们。
          </p>
        </section>

        {/* 右：API 参考 */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <DocsPanel />
        </aside>
      </div>
    </div>
  )
}

/* ---------------- 未登录落地页 ---------------- */

function Landing({ onLogin }: { onLogin: () => void }) {
  const FEATURES = [
    { icon: '🎮', title: '游戏元数据', desc: '按语言取标题、封面、平台目录、ROM 扩展名' },
    { icon: '🔑', title: '账号与授权', desc: 'OAuth 2.0 设备码流程，读收藏与云存档' },
    { icon: '📺', title: '嵌入与直播', desc: '带签名的嵌入播放器地址、在播房间列表' },
  ]
  return (
    <div className="container-x py-10">
      <header className="overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-brand-soft/70 to-surface p-8 sm:p-12">
        <span className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-xs font-semibold text-brand-hover">
          <span aria-hidden>📡</span> 开发者 API
        </span>
        <h1 className="mt-4 max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">
          把 8BitGo 的游戏库接进你自己的产品
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          用我们的游戏元数据、ROM 凭据和账号体系，做导航站、聚合器、嵌入式播放器，
          或任何你想得到的复古游戏玩法。登录后即可创建应用，当场拿到一对沙箱 AppID / AppKey。
        </p>
        <div className="mt-6">
          <Button size="lg" onClick={onLogin}>登录后创建应用</Button>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-line bg-surface/70 p-4">
              <div className="text-2xl" aria-hidden>{f.icon}</div>
              <p className="mt-2 font-bold">{f.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{f.desc}</p>
            </div>
          ))}
        </div>
      </header>

      <div className="mt-8">
        <DocsPanel />
      </div>
    </div>
  )
}

/* ---------------- 空状态 ---------------- */

function EmptyApps({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-line p-10 text-center">
      <div className="text-4xl" aria-hidden>🧩</div>
      <p className="mt-3 text-base font-semibold">还没有应用</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
        先建一个沙箱应用跑通，再来申请上产 —— 这样我们审的是「做出来的东西」，
        你也不用为了拿 key 先写一份说明书。
      </p>
      <Button className="mt-5" onClick={onCreate}>＋ 创建第一个应用</Button>
    </div>
  )
}

/* ---------------- 一个应用（卡片） ---------------- */

function AppCard({ app, open, onToggle, onChanged }: { app: OpenApp; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const badge = statusLabel(app)
  const [detail, setDetail] = useState<OpenAppDetail | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [issued, setIssued] = useState<SecretIssued | null>(null)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const initial = (app.name.trim().charAt(0) || '🎮').toUpperCase()

  const reload = useCallback(async () => {
    try {
      setDetail(await myApp(app.id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [app.id])

  useEffect(() => {
    if (open && !detail) void reload()
  }, [open, detail, reload])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setErr('')
    try {
      await fn()
      await reload()
      onChanged()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <li className="overflow-hidden rounded-2xl border border-line bg-surface transition hover:border-line-strong">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-lg font-bold text-brand-hover" aria-hidden>
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-base font-bold">{app.name}</span>
            <Badge tone={badge.tone === 'ok' ? 'brand' : badge.tone === 'warn' ? 'coin' : badge.tone === 'bad' ? 'live' : 'neutral'}>
              {badge.text}
            </Badge>
          </span>
          <code className="mt-0.5 block truncate font-mono text-[11px] text-dim">{app.id}</code>
        </span>
        <span className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {/* 速览统计 */}
      <div className="flex flex-wrap gap-2 px-4 pb-3">
        <Stat label="已生效权限" value={String(app.approvedScopes.length)} />
        <Stat label="限流" value={`${app.limits.qps} QPS`} />
        <Stat label="类型" value={app.clientType === 'public' ? '公开' : '机密'} />
      </div>

      {open && (
        <div className="space-y-5 border-t border-line px-4 py-4">
          {app.reviewReason && (
            <p className="rounded-lg bg-live/10 px-3 py-2 text-xs leading-relaxed text-live">
              <b>{app.reviewState === 'rejected' ? '审核未通过：' : '处置说明：'}</b>
              {app.reviewReason}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Info label="已生效的权限">
              {app.approvedScopes.length ? app.approvedScopes.map((s) => <code key={s} className="mr-1.5">{s}</code>) : <span className="text-dim">无</span>}
            </Info>
            <Info label="申请中的权限">
              {app.requestedScopes.filter((s) => !app.approvedScopes.includes(s)).length ? (
                app.requestedScopes.filter((s) => !app.approvedScopes.includes(s)).map((s) => <code key={s} className="mr-1.5">{s}</code>)
              ) : (
                <span className="text-dim">无</span>
              )}
            </Info>
            <Info label="配额">
              {app.limits.qps} QPS · {app.limits.callsPerDay.toLocaleString()} 次/日
            </Info>
            <Info label="客户端类型">{app.clientType === 'public' ? '公开（无 Key）' : '机密（有 Key）'}</Info>
          </div>

          {/* AppID 复制 */}
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-dim">{app.id}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copyText(app.id).then(() => setCopied(true))}
            >
              {copied ? '已复制' : '复制 AppID'}
            </Button>
          </div>

          {/* 密钥 */}
          <section>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">AppKey</h3>
              {app.clientType !== 'public' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== ''}
                  onClick={() => void run('rotate', async () => setIssued(await rotateSecret(app.id)))}
                >
                  {busy === 'rotate' ? '生成中…' : '新建一把（轮换）'}
                </Button>
              )}
            </div>
            {issued && (
              <div className="mt-2 rounded-xl border-2 border-live/40 bg-live/5 p-3">
                <p className="flex items-start gap-2 text-xs font-semibold text-live">
                  <span aria-hidden>⚠️</span>
                  <span>{issued.secretNotice}</span>
                </p>
                <code className="mt-2 block overflow-x-auto rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs">{issued.secret}</code>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setIssued(null)}>
                  已保存
                </Button>
              </div>
            )}
            <ul className="mt-2 space-y-1">
              {(detail?.secrets ?? []).map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-xs">
                  <code className={cx('rounded bg-surface-2 px-1.5 py-0.5', !s.active && 'line-through opacity-50')}>…{s.hint}</code>
                  <span className="text-dim">
                    {s.active ? (s.lastUsedAt ? `最近使用 ${fmtDate(s.lastUsedAt)}` : '还没用过') : '已撤销'}
                  </span>
                  {s.active && (
                    <button
                      type="button"
                      className="ml-auto text-live underline underline-offset-2 disabled:opacity-50"
                      disabled={busy !== ''}
                      onClick={() => void run('revoke', () => revokeSecret(app.id, s.id))}
                    >
                      撤销
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 leading-relaxed text-dim">
              轮换的做法：新建一把 → 线上换成新的 → 回来撤销旧的。<strong>两把可以同时有效</strong>，所以不会有断服的窗口。
            </p>
          </section>

          {/* 沙箱测试账号 */}
          {app.status === 'sandbox' && <Testers app={app} detail={detail} onChanged={reload} />}

          {/* 上产申请 */}
          <section>
            <h3 className="font-semibold">上产申请</h3>
            {app.reviewState === 'pending' ? (
              <div className="mt-2">
                <p className="text-muted">已提交，等我们看一眼。审核期间<strong>沙箱照常可用</strong>，但权限和回调地址改不了。</p>
                <Button size="sm" variant="ghost" className="mt-2" disabled={busy !== ''} onClick={() => void run('withdraw', () => withdrawReview(app.id))}>
                  撤回申请
                </Button>
              </div>
            ) : app.status === 'live' ? (
              <p className="mt-2 text-muted">已经在生产环境了。</p>
            ) : app.status === 'suspended' ? (
              <p className="mt-2 text-live">应用已停用，请联系我们。</p>
            ) : (
              <div className="mt-2 space-y-2">
                <p className="leading-relaxed text-dim">
                  说清楚三件事：你做的是什么、我们的东西用在哪一屏、为什么需要你勾的那几个权限。
                  至少 30 字 —— 太短的没法审。
                </p>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                  placeholder="例：我在做一个红白机游戏的聚合导航站，游戏详情页用嵌入播放器让访客直接玩…"
                />
                <Button size="sm" disabled={busy !== '' || note.trim().length < 30} onClick={() => void run('submit', () => submitForReview(app.id, note.trim()))}>
                  {busy === 'submit' ? '提交中…' : '提交审核'}
                </Button>
              </div>
            )}
          </section>

          {/* 审核记录 */}
          {!!detail?.reviews.length && (
            <section>
              <h3 className="font-semibold">记录</h3>
              <ul className="mt-1.5 space-y-1 text-xs text-dim">
                {detail.reviews.map((r) => (
                  <li key={r.id}>
                    {fmtDate(r.at)} · {ACTION_LABELS[r.action] ?? r.action}
                    {r.detail && <span className="text-muted"> —— {r.detail.slice(0, 120)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {err && <p className="text-live">{err}</p>}
        </div>
      )}
    </li>
  )
}

function Testers({ app, detail, onChanged }: { app: OpenApp; detail: OpenAppDetail | null; onChanged: () => void }) {
  const [email, setEmail] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const list = detail?.testers ?? []

  const add = async () => {
    setBusy(true)
    setErr('')
    try {
      await addTester(app.id, email.trim())
      setEmail('')
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h3 className="font-semibold">测试账号（沙箱）</h3>
      <p className="mt-1 leading-relaxed text-dim">
        ⚠️ 沙箱应用<strong>只能</strong>向你自己和这里的账号请求授权，最多 {app.limits.testers} 个。
        上产之后这张名单就不再限制谁能授权。
      </p>
      <ul className="mt-2 space-y-1">
        {list.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm">
            <span>{t.nickname || t.id}</span>
            <span className="text-dim">{t.email}</span>
            <button
              type="button"
              className="ml-auto text-live underline underline-offset-2"
              onClick={() => void removeTester(app.id, t.id).then(onChanged)}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      {list.length < app.limits.testers && (
        <div className="mt-2 flex gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="测试账号的注册邮箱"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus:border-brand"
          />
          <Button size="sm" variant="ghost" disabled={busy || !email.trim()} onClick={() => void add()}>
            添加
          </Button>
        </div>
      )}
      {err && <p className="mt-1 text-live">{err}</p>}
    </section>
  )
}

/* ---------------- 创建 ---------------- */

const ALL_SCOPES = Object.keys(SCOPE_LABELS)

function CreateForm({ onCancel, onDone }: { onCancel: () => void; onDone: (r: SecretIssued) => void }) {
  const [name, setName] = useState('')
  const [homepage, setHomepage] = useState('')
  const [scopes, setScopes] = useState<string[]>(['games.read'])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const toggle = (s: string) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      onDone(await createMyApp({ name: name.trim(), homepage: homepage.trim() || undefined, scopes: scopes.join(' ') }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Field label="应用名" hint="用户在授权页上看到的就是它">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={INPUT} placeholder="例如：小霸王游戏站" />
      </Field>
      <Field label="主页" hint="选填。申请上产时我们会打开看一眼">
        <input value={homepage} onChange={(e) => setHomepage(e.target.value)} className={INPUT} placeholder="https://…" />
      </Field>
      <div>
        <p className="text-xs font-semibold">要用到的权限</p>
        <p className="mt-1 text-[11px] leading-relaxed text-dim">
          打勾的会写进申请单。其中 <b>games.read</b> 现在就给你，
          其余的等申请上产时一起审 —— 勾上不影响你先把沙箱跑起来。
        </p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-xs hover:border-brand">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-0.5" />
              <span className="min-w-0">
                <code className="font-semibold">{s}</code>
                {!SELF_SERVE.includes(s) && <span className="ml-1 rounded bg-coin-soft px-1 text-[10px] text-coin">需审核</span>}
                <span className="block text-dim">{SCOPE_LABELS[s]}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {err && <p className="text-xs text-live">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || name.trim().length < 2} onClick={() => void submit()}>
          {busy ? '创建中…' : '创建并拿 Key'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  )
}

/**
 * 只出现一次的 AppKey。
 *
 * 设计上刻意做得「碍事」：在模态里、要手动关、关之前有一行红字。
 * 因为一旦关掉，这串东西就**真的没有了** —— 库里只有 bcrypt 哈希。
 */
function SecretOnce({ data, onClose }: { data: SecretIssued & { appName: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="rounded-xl border-2 border-live/40 bg-live/5 p-3">
        <p className="flex items-start gap-2 text-sm font-semibold text-live">
          <span aria-hidden>⚠️</span>
          <span>{data.secretNotice}</span>
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">{data.secret}</code>
        <Button
          size="sm"
          onClick={() => void copyText(data.secret).then(() => setCopied(true))}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <Button size="sm" variant="ghost" className="mt-4" onClick={onClose}>
        我已经保存好了
      </Button>
    </div>
  )
}

/* ---------------- 右侧：API 参考（可滚动的内容面板） ---------------- */

/**
 * `/open` 右栏的**完整**开发文档，像阿里云控制台那样：左栏是操作台，右栏是可滚动的
 * API 参考，含鉴权、每个端点的字段、错误码、限流。内容对齐 `server/src/routes/open.js`
 * 与 `docs/esp-open-api.md`，改了接口记得同步这里。
 *
 * 这一版用标签页把原先一整面墙的小字拆开（鉴权 / 接口 / 参考），读起来不再压迫。
 * 外层 `<aside>` 是 `sticky top-6`，所以右栏只滚自己、不带着整页走。
 */

const DOC_ENDPOINTS: { method: 'GET' | 'POST'; path: string; scope: string; desc: string; detail?: string }[] = [
  { method: 'POST', path: '/v1/token', scope: '—', desc: 'AppID + Key 换应用级令牌', detail: '请求体 JSON 或 x-www-form-urlencoded。grant_type=client_credentials。回 {access_token, token_type:"Bearer", expires_in:900, scope}。scope 不传=已获批应用级全部，传了必须是子集、不静默降级。' },
  { method: 'POST', path: '/v1/device/code', scope: '—', desc: '设备码流程：要一串 user_code / device_code', detail: '回 {device_code, user_code, verification_uri:"/open/device", verification_uri_complete, expires_in:900, interval:5}。只有 confidential 客户端能用。' },
  { method: 'GET', path: '/v1/me', scope: '无', desc: '自查令牌：client_id / kind / scope / expires_at', detail: '排错第一站。「为什么我调那个接口 403」先看这里的 scope。' },
  { method: 'GET', path: '/v1/platforms', scope: '无', desc: '平台目录：每平台的模拟器 / ROM 扩展名 / 能否本地跑', detail: '返回 items：id / name / runtime / core / romExtensions / native{runnable,emulator,note}。本地客户端拿到游戏 platform 后查这张表挑模拟器。注意 dos(flash 包需解包)、flash、java 能本地跑但有格式坑；html5 是网页、ps2 仅串流，runnable:false。' },
  { method: 'GET', path: '/v1/health', scope: '无（公开）', desc: '健康检查：服务存活 + 数据库连通', detail: '公开匿名端点，返回 {service:"8bitgo-open", db, timestamp}。监控和第三方可直接探，不会被令牌限流挡住。完整的机器可读 OpenAPI 挂在 /.well-known/openapi.json。' },
  { method: 'GET', path: '/v1/genres', scope: '无', desc: '游戏类型枚举', detail: '返回 items：{id, name}。客户端画「按类型筛选」用，别把类型集合硬编码进固件——它会变。' },
  { method: 'GET', path: '/v1/languages', scope: '无', desc: '游戏语言枚举', detail: '返回 items：{code, label, english}（如 zh-Hans / en / ja）。和 ?lang= 的合法取值一致。' },
  { method: 'GET', path: '/v1/live/rooms', scope: '无', desc: '在播直播房间列表', detail: '返回 items：{roomId, title, gameSlug, gameName, platform, hostName, viewers, startedAt, hostAway, hostFrozen, netplayRoomId, coopOpen, coopTaken, presence}。?game=<slug> 只筛某一款。已脱敏：无主播 IP / 续播 token / 观众 socket.id。' },
  { method: 'GET', path: '/v1/live/rooms/:roomId', scope: '无', desc: '单个直播房间快照', detail: '直链也能查到，不受「切后台下榜」影响。不存在回 404 not_found。' },
  { method: 'GET', path: '/v1/collections', scope: '无', desc: '公开合集列表（分页）', detail: '返回 {items, page, page_size, total, total_pages}。items 是合集元信息（id/title/author/covers/gameCount…），封面走瘦身 Game，不含 ROM 地址。' },
  { method: 'GET', path: '/v1/collections/:id', scope: '无', desc: '单个合集 + 里面的游戏', detail: '返回 {collection, games}。games 走开放平台白名单映射（和 /v1/games 同形状），不含 ROM 真实地址——和站内 /:id 那条（用 attachRelations）不同，那条会漏内部字段。下架/不存在回 404。' },
  { method: 'GET', path: '/v1/games', scope: 'games.read', desc: '游戏列表（分页）', detail: '参数：page(默认1)、page_size(默认24,≤50)、platform、genre、q、sort(popular/newest/name/rating/home)、lang(默认 en)。回 {items,page,page_size,total,total_pages}。' },
  { method: 'GET', path: '/v1/games/:slug', scope: 'games.read', desc: '游戏详情，返回单个游戏对象', detail: '下架 / 成人 / 不存在对外一律 404 not_found。' },
  { method: 'GET', path: '/v1/games/:slug/rom', scope: 'games.rom', desc: '换 ROM 短期下载凭据', detail: '参数 lang（精确→通用件*，不做跨语言回退）。回 {url, expires_in:300, lang_actual, filename}。第二跳 GET /v1/rom/:grant 是 302 不带 Authorization，跟随到 assets 主机；凭据 5 分钟过期。' },
  { method: 'GET', path: '/v1/games/:slug/embed', scope: 'games.read', desc: '换带签名、会过期的嵌入播放器地址', detail: '回 {url, expires_in, allow:"fullscreen; gamepad; autoplay; clipboard-write"}。' },
  { method: 'GET', path: '/v1/library', scope: 'library.read', desc: '用户收藏与最近在玩（用户级令牌）', detail: '回 {favorites:[游戏对象], recent:[…]最多12条, favorites_total}。设备码流程换来的用户级令牌才能调。' },
  { method: 'GET', path: '/v1/saves', scope: 'saves.read', desc: '用户存档清单（只元信息，不带内容）', detail: '回 {items:[{runtime, game_slug, slot, size, created_at, updated_at}]}。' },
  { method: 'GET', path: '/v1/saves/:runtime/:slug', scope: 'saves.read', desc: '取一份存档的二进制（用户级令牌）', detail: '参数 slot(0–9)。回 application/octet-stream + x-save-updated-at。runtime 白名单：emulatorjs / jsdos / cloudgame / jsnes / ruffle / webretro / j2me。' },
]

const DOC_ERRORS: [string, string, string][] = [
  ['400', 'invalid_request', '请求体畸形 / 超 16KB（413 同码）'],
  ['400', 'unsupported_grant_type', '只支持 client_credentials / device_code'],
  ['400', 'unauthorized_client', 'public 客户端不能用此端点'],
  ['400', 'invalid_scope', 'scope 不认识 / 未获批 / 要了用户级'],
  ['401', 'invalid_client', 'AppID 或 key 不对（不区分）'],
  ['401', 'invalid_token', '令牌无效或过期 → 续一次、重试一次'],
  ['403', 'insufficient_scope', '差哪个 scope（响应带 scope 字段）'],
  ['403', 'invalid_grant', 'ROM 凭据签名不对'],
  ['404', 'not_found', '没这款游戏（下架/成人/不存在不区分）'],
  ['404', 'rom_unavailable', '这款游戏没有可下载 ROM'],
  ['410', 'grant_expired', 'ROM 凭据过期 → 回第一步重换'],
  ['429', 'rate_limited', '看 Retry-After 退避'],
  ['500', 'server_error', '服务端问题，重试或联系我们'],
  ['501', 'temporarily_unavailable', '服务端未启用开放平台'],
]

const DOC_RATES: [string, string][] = [
  ['取令牌 · 按 IP', '120 / 小时'],
  ['取令牌 · 按 AppID', '60 / 小时'],
  ['普通接口 · 按 AppID', '3600 / 小时'],
  ['ROM 换凭据 · 按 AppID', '600 / 小时'],
]

const DOC_GAME_FIELDS: [string, string, string][] = [
  ['slug', 'string', '对外唯一标识，所有端点都用它'],
  ['title / description', 'string', '已按 lang 取好的单语言文本'],
  ['lang_requested', 'string', '你要求的语言'],
  ['lang_actual', '{title,description}', '实际是哪门；und=原名'],
  ['platform', 'string', '平台 id，如 nes / dos'],
  ['genres / tags', 'string[]', '类型 / 标签'],
  ['year', 'number', '0=没填'],
  ['developer', 'string', '开发商'],
  ['players / multiplayer', 'number / bool', '人数 / 是否多人'],
  ['icon', 'string', 'emoji 兜底封面'],
  ['cover', 'string|null', '绝对地址，没有时给 null 而非 404 URL'],
  ['rating / rating_count', 'number', '一位小数；0=还没人评'],
  ['plays', 'number', '游玩次数'],
  ['added_at / updated_at', 'string|null', '日期 / ISO 时间'],
  ['adult', 'bool', '列表里恒为 false'],
  ['rom_langs', 'string[]', '可选 ROM 语言，* = 通用件'],
]

const DOC_TABS: { id: 'auth' | 'endpoints' | 'ref'; label: string }[] = [
  { id: 'auth', label: '鉴权' },
  { id: 'endpoints', label: '接口' },
  { id: 'ref', label: '数据 & 错误码' },
]

function MethodBadge({ method }: { method: 'GET' | 'POST' }) {
  return (
    <span
      className={cx(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold',
        method === 'GET' ? 'bg-brand-soft text-brand-hover' : 'bg-coin/20 text-coin',
      )}
    >
      {method}
    </span>
  )
}

function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-dim">{title}</h3>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  )
}

function DocsPanel() {
  const [tab, setTab] = useState<'auth' | 'endpoints' | 'ref'>('auth')
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="sticky top-0 z-10 flex border-b border-line bg-surface/95 backdrop-blur">
        {DOC_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cx(
              'flex-1 px-3 py-2.5 text-xs font-bold transition',
              tab === t.id ? 'border-b-2 border-brand text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="max-h-[calc(100vh-10rem)] space-y-5 overflow-y-auto p-4 text-[11px] leading-relaxed">
        {tab === 'auth' && (
          <>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-dim">Base URL</p>
              <code className="mt-1 block break-all rounded-lg border border-line bg-surface-2 px-2 py-1.5">https://8bitgo.com/api/open/v1</code>
            </div>
            <DocSection title="鉴权">
              <p className="text-muted">所有接口除 <code className="text-fg">GET /v1/rom/:grant</code> 外都要带：</p>
              <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[10px] text-fg">Authorization: Bearer &lt;access_token&gt;</pre>
              <p className="text-muted">
                应用级令牌（client_credentials）背后没有用户，拿不到 <code className="text-fg">library.* / saves.*</code>。
                读用户数据要走设备码流程（RFC 8628）：先 <code className="text-fg">POST /v1/device/code</code> 拿码，
                人在 <code className="text-fg">/open/device</code> 点同意，设备再 <code className="text-fg">POST /v1/token</code>
                轮询 grant_type=device_code。注意 <code className="text-fg">authorization_pending</code> /{' '}
                <code className="text-fg">slow_down</code> 是「接着等」，不是失败。
              </p>
              <p className="text-muted">CORS 放开到任意 Origin 且不带 cookie；认 <code className="text-fg">error</code> 字段而非中文的 error_description。</p>
              <p className="text-dim">
                本地客户端挑平台：<code className="text-fg">runtime=emulatorjs</code> 那 11 个与{' '}
                <code className="text-fg">java</code> 是「下载即跑」（见 <code className="text-fg">/v1/platforms</code> 的 native 建议）；
                <code className="text-fg">dos</code> 的 jsdos 包、<code className="text-fg">flash</code> 的 swf 要按 note 处理格式；
                <code className="text-fg">html5</code> 不是 ROM 而是网页，<code className="text-fg">ps2</code> 是 1~4.7GB 的 DVD 镜像、
                站上只按扇区串读不提供整份下载 —— 这两个本地拿不到可用的 ROM。
              </p>
              <p className="text-dim">
                ⚠️ 每一行还带 <code className="text-fg">enabled</code>：站上并不是每个平台都开着，
                <code className="text-fg">false</code> 的在前台是 404、列表里也查不到东西，客户端应当整个隐藏。这个名单会变，别写死。
              </p>
            </DocSection>
          </>
        )}

        {tab === 'endpoints' && (
          <DocSection title="接口">
            {DOC_ENDPOINTS.map((e) => (
              <div key={e.path} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="flex items-center gap-2">
                  <MethodBadge method={e.method} />
                  <code className="text-[11px] font-semibold text-fg">{e.path}</code>
                </div>
                <p className="mt-1 text-muted">需要 <code className="text-fg">{e.scope}</code> · {e.desc}</p>
                {e.detail && <p className="mt-1 text-dim">{e.detail}</p>}
              </div>
            ))}
          </DocSection>
        )}

        {tab === 'ref' && (
          <>
            <DocSection title="游戏对象字段">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[10px]">
                  <thead>
                    <tr className="text-left text-dim">
                      <th className="border-b border-line py-1 pr-2 font-medium">字段</th>
                      <th className="border-b border-line py-1 pr-2 font-medium">类型</th>
                      <th className="border-b border-line py-1 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOC_GAME_FIELDS.map(([f, t, d]) => (
                      <tr key={f}>
                        <td className="border-b border-line/60 py-1 pr-2 align-top"><code className="text-fg">{f}</code></td>
                        <td className="border-b border-line/60 py-1 pr-2 align-top text-dim">{t}</td>
                        <td className="border-b border-line/60 py-1 align-top text-muted">{d}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-dim">绝不会出现（内部字段）：id、rom / roms / object_key、hidden、core、dos_*、coin_reward、video 等。</p>
            </DocSection>

            <DocSection title="错误码">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[10px]">
                  <thead>
                    <tr className="text-left text-dim">
                      <th className="border-b border-line py-1 pr-2 font-medium">HTTP</th>
                      <th className="border-b border-line py-1 pr-2 font-medium">error</th>
                      <th className="border-b border-line py-1 font-medium">含义</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOC_ERRORS.map(([http, err, desc]) => (
                      <tr key={err}>
                        <td className="border-b border-line/60 py-1 pr-2 align-top text-dim">{http}</td>
                        <td className="border-b border-line/60 py-1 pr-2 align-top"><code className="text-fg">{err}</code></td>
                        <td className="border-b border-line/60 py-1 align-top text-muted">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DocSection>

            <DocSection title="限流（窗口均为 1 小时）">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[10px]">
                  <thead>
                    <tr className="text-left text-dim">
                      <th className="border-b border-line py-1 pr-2 font-medium">桶</th>
                      <th className="border-b border-line py-1 font-medium">上限</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOC_RATES.map(([bucket, limit]) => (
                      <tr key={bucket}>
                        <td className="border-b border-line/60 py-1 pr-2 align-top text-muted">{bucket}</td>
                        <td className="border-b border-line/60 py-1 pr-2 align-top"><code className="text-fg">{limit}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-dim">429 带 Retry-After 头（秒），照它退避。普通接口平均约 1 QPS。</p>
            </DocSection>

            <DocSection title="Scope">
              <ul className="space-y-1">
                <li><code className="text-fg">games.read</code> <span className="rounded bg-brand-soft px-1 text-brand-hover">自助</span> <span className="text-dim">创建即给</span></li>
                <li><code className="text-fg">games.rom</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">assets 当前公开可读，凭据只是不主动给</span></li>
                <li><code className="text-fg">library.read</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">用户级，需设备码流程</span></li>
                <li><code className="text-fg">saves.read</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">用户级，需设备码流程</span></li>
                <li><code className="text-fg line-through">saves.write</code> <span className="text-dim">待上线（敏感，要连配额/覆盖保护/审计一起做）</span></li>
              </ul>
            </DocSection>

            <DocSection title="语言码">
              <p className="text-muted">
                只认 <code className="text-fg">zh-Hans zh-Hant en es fr it de ja</code>；不报错退到默认 <code className="text-fg">en</code>。
                库内译文残缺，设备上靠 <code className="text-fg">lang_actual</code> 判断有没有译文，别靠 lang_requested。
              </p>
            </DocSection>
          </>
        )}
      </div>
    </div>
  )
}

/* ---------------- 小部件 ---------------- */

const ACTION_LABELS: Record<string, string> = {
  submit: '提交审核',
  withdraw: '撤回申请',
  approve: '审核通过',
  reject: '审核未通过',
  suspend: '被停用',
  restore: '已恢复',
}

const INPUT = 'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand'

async function copyText(text: string) {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    /* 剪贴板不可用时忽略，文本框/代码块本身可手选复制 */
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold">{label}</span>
      {hint && <span className="ml-1.5 text-[11px] text-dim">{hint}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] text-dim">{label}</p>
      <p className="mt-0.5 break-words">{children}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-dim">{label}</div>
      <div className="text-xs font-semibold">{value}</div>
    </div>
  )
}

function fmtDate(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}
