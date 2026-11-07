import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useSeo } from '@/services/seo'
import { Button, buttonClasses } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { ApiError } from '@/services/api'
import { fetchApps, type AppItem } from '@/services/apps'
import { romUrlForKey } from '@/services/roms'
import { copyText as writeClipboardText } from '@/lib/clipboard'
import {
  addTester,
  createMyApp,
  deleteMyApp,
  myApp,
  myApps,
  patchMyApp,
  removeTester,
  revokeSecret,
  rotateSecret,
  sandboxRomSamples,
  SCOPE_LABELS,
  SELF_SERVE,
  statusLabel,
  submitForReview,
  withdrawReview,
  type OpenApp,
  type OpenAppDetail,
  type SecretIssued,
  type SandboxRomSample,
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

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
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

          <SandboxSampleList />

          <p className="mt-8 text-[11px] leading-relaxed text-dim">
            本页 API 文档包含接入说明与全部端点；<a href="/.well-known/openapi.json" target="_blank" rel="noreferrer" className="underline underline-offset-2">OpenAPI 机器规格</a>可供代码生成器导入。
            遇到问题把 AppID（不是 AppKey！）连同报错一起发给我们。
          </p>

          <SdkDownloads />
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
    { icon: '📺', title: '嵌入、直播与联机', desc: 'Linux / 掌机开播、观看与 P2P 联机房间' },
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

/* ---------------- 官方 SDK（从 /api/apps 的 sdk 分组拉） ---------------- */

/** 把存储的下载地址（外链或 R2 key）拼成可点击的 URL */
function sdkHref(item: AppItem): string | null {
  const raw = item.downloadUrl
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  return romUrlForKey(raw) || null
}

function SdkDownloads() {
  const [items, setItems] = useState<AppItem[] | null>(null)

  useEffect(() => {
    let alive = true
    fetchApps()
      .then((g) => alive && setItems(g.sdk))
      .catch((e) => {
        console.error('[open] 官方 SDK 加载失败', e)
        if (alive) setItems([])
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-bold">官方 SDK</h2>
      {items === null ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface-2" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">暂无官方 SDK。</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {items.map((s) => (
            <SdkCard key={s.id} item={s} />
          ))}
        </div>
      )}
    </section>
  )
}

function SdkCard({ item }: { item: AppItem }) {
  const href = sdkHref(item)
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-soft text-2xl" aria-hidden>
          {item.icon || '📦'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-bold">{item.name}</h3>
            {item.version && (
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                v{item.version}
              </span>
            )}
          </div>
          {item.platform && (
            <span className="mt-1 inline-block rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand-hover">
              {item.platform}
            </span>
          )}
        </div>
      </div>
      {item.description && <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-muted">{item.description}</p>}
      <div className="mt-auto pt-1">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClasses('primary', 'sm')}
          >
            下载
          </a>
        ) : (
          <span className="inline-flex h-8 items-center rounded-lg border border-line bg-surface-2 px-3 text-xs font-semibold text-muted">
            暂无下载
          </span>
        )}
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

function SandboxSampleList() {
  const [samples, setSamples] = useState<SandboxRomSample[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    void sandboxRomSamples().then((r) => setSamples(r.items)).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface p-4 text-xs">
      <h3 className="text-sm font-semibold">沙箱 ROM 测试游戏</h3>
      <p className="mt-1 text-dim">申请 games.rom 后，无需审核即可用 AppKey 领取下列游戏的下载凭据；上产审批通过后才可访问全库。</p>
      {error ? <p className="mt-2 text-live">样本目录暂时不可用：{error}</p> : samples.length ? (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {samples.map((s) => <li key={s.platform}><code>{s.platform}</code> · {s.title} <code className="text-dim">({s.slug})</code></li>)}
        </ul>
      ) : <p className="mt-2 text-dim">站长尚未配置测试样本。</p>}
    </section>
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

  const remove = async () => {
    const warning =
      app.status === 'live'
        ? `「${app.name}」已上产，删除会让所有用户掉线、所有 AppKey 立刻失效。确定继续吗？`
        : `确定删除「${app.name}」吗？应用和所有 AppKey、授权、审核记录都会被清除，不可恢复。`
    if (!confirm(warning)) return
    setBusy('delete')
    setErr('')
    try {
      await deleteMyApp(app.id)
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
        <Stat label="已审核权限" value={String(app.approvedScopes.length)} />
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
            <Info label="已审核通过的权限">
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
          {app.status === 'sandbox' && app.requestedScopes.includes('games.rom') && (
            <p className="rounded-lg bg-brand-soft px-3 py-2 text-xs leading-relaxed">
              沙箱可用 <code>games.rom</code> 测试上方列出的逐机型样本；全库 ROM 仍需审核。修改权限后请重新获取访问令牌。
            </p>
          )}

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

          {/*
            回调地址。位置刻意放在「上产申请」正上方 —— 它是提交审核的前置条件，
            以前控制台上**根本没有这个字段**，于是提交时报一句「必须先登记回调地址」，
            而界面上哪儿都找不到能登记的地方（2026-09-12 补）。
          */}
          <RedirectUris
            app={app}
            busy={busy === 'redirect'}
            disabled={busy !== '' || app.reviewState === 'pending'}
            onSave={(uris) => void run('redirect', () => patchMyApp(app.id, { redirectUris: uris }))}
          />

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
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={busy !== '' || note.trim().length < 30} onClick={() => void run('submit', () => submitForReview(app.id, note.trim()))}>
                    {busy === 'submit' ? '提交中…' : '提交审核'}
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy !== ''} onClick={() => void remove()}>
                    {busy === 'delete' ? '删除中…' : '删除应用'}
                  </Button>
                </div>
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

/**
 * 回调地址（redirect_uri）的登记框。
 *
 * 后端从第一天就支持（POST / PATCH 都收 redirectUris，校验在 open-apps.js 的 cleanList），
 * 但控制台一直没把它画出来 —— 申请了 library.* / saves.* 这类用户级 scope 的人，
 * 提交审核时会撞上「申请登录类权限必须先登记回调地址」，然后在界面上遍寻不着。
 *
 * 一行一条。**不做任何规整**（不补末尾斜杠、不小写化）—— OAuth 的精确匹配就是拿这个串去比的，
 * 这里顺手「修」一下，线上换来的就是一个 redirect_uri_mismatch。
 */
function RedirectUris({
  app,
  busy,
  disabled,
  onSave,
}: {
  app: OpenApp
  busy: boolean
  disabled: boolean
  onSave: (uris: string[]) => void
}) {
  const saved = app.redirectUris.join('\n')
  const [text, setText] = useState(saved)
  // 保存成功后父组件会换一份新的 app，把编辑框同步过去（否则显示的还是刚才那一版）
  useEffect(() => setText(saved), [saved])
  const list = text.split(/\s+/).filter(Boolean)
  const dirty = list.join('\n') !== saved
  const missing = app.needsRedirect && !app.redirectUris.length

  return (
    <section>
      <h3 className="font-semibold">
        回调地址
        {app.needsRedirect && <span className="ml-2 text-xs font-normal text-live">必填</span>}
      </h3>
      <p className="mt-1.5 leading-relaxed text-dim">
        授权完成后我们把授权码送回的地址，一行一条，最多 {app.limits.redirectUris} 条。
        <strong className="text-muted">精确匹配</strong>：大小写、末尾斜杠、端口都算数，和你代码里写的那一串必须一模一样。
        地址里不能带 <code className="font-mono">#</code>；沙箱可以用 <code className="font-mono">http://localhost</code>，上产必须是 https。
      </p>
      {missing && (
        <p className="mt-1.5 text-live">
          你申请的权限里有用户授权类的（library.* / saves.* / openid 这些），不登记回调地址提交不了审核。
        </p>
      )}
      {app.reviewState === 'pending' ? (
        <p className="mt-2 text-muted">审核中，回调地址暂时改不了 —— 要改先撤回申请。</p>
      ) : (
        <div className="mt-2 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs outline-none focus:border-brand"
            placeholder={'https://example.com/oauth/callback\nhttp://localhost:5173/callback'}
          />
          <Button size="sm" disabled={disabled || !dirty} onClick={() => onSave(list)}>
            {busy ? '保存中…' : '保存回调地址'}
          </Button>
        </div>
      )}
    </section>
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
          打勾的会写进申请单。<b>games.read</b> 立即可用；勾选 <b>games.rom</b> 后，
          沙箱可下载逐机型测试样本，访问全库仍需审核。其余权限等申请上产时审核。
        </p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-xs hover:border-brand">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-0.5" />
              <span className="min-w-0">
                <code className="font-semibold">{s}</code>
                {!SELF_SERVE.includes(s) && <span className="ml-1 rounded bg-coin-soft px-1 text-[10px] text-coin">{s === 'games.rom' ? '全库需审核' : '需审核'}</span>}
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

/* ---------------- 开放平台 API 文档（可滚动的内容面板） ---------------- */

/**
 * 文档以实际 Express 路由和 server/openapi.json 为准。测试会核对这里列出的
 * /v1 方法与路径是否覆盖机器规格；OAuth 和站内授权确认流程在下方单独解释。
 */

type DocEndpoint = { method: 'GET' | 'POST' | 'HEAD'; path: string; access: string; desc: string; detail: string }

const DOC_ENDPOINT_GROUPS: { title: string; items: DocEndpoint[] }[] = [
  {
    title: '公开目录 · 无需令牌',
    items: [
      { method: 'GET', path: '/v1/games', access: '公开', desc: '分页查游戏', detail: '查询参数：platform、genre、q、sort、lang、page、page_size、requires_windows。page 从 1 起，page_size 默认 24、最大 50；sort 支持 popular/newest/name/rating/home。返回 {items,page,page_size,total,total_pages}，筛选先于计数和分页。成人、下架内容不对外返回。' },
      { method: 'GET', path: '/v1/games/:slug', access: '公开', desc: '游戏详情', detail: '路径参数 slug；可选 lang。成功直接返回 Game 对象（字段表见「数据 & 错误码」）；不存在、下架或成人内容统一返回 404 not_found。' },
      { method: 'GET', path: '/v1/platforms', access: '公开', desc: '平台与本地模拟器建议', detail: '返回 {items:[Platform]}，字段含 id/name/nameZh/manufacturer/year/runtime/core/romExtensions/enabled/native。native.runnable 表示本机建议是否可运行；enabled=false 表示本站当前未开放该平台。' },
      { method: 'GET', path: '/v1/rom-samples', access: '公开', desc: '沙箱 ROM 测试游戏', detail: '返回 {items:[{platform,slug,title}]}，只露站长配置的沙箱样本，不含存储 key。申请 games.rom 的沙箱应用只能为这些 slug 领取 ROM 下载凭据。' },
      { method: 'GET', path: '/v1/genres', access: '公开', desc: '类型枚举', detail: '返回 {items:[{id,name}]}。id 可直接传给游戏列表的 genre；这是筛选用的展示目录，不保证每种类型当前都有游戏。' },
      { method: 'GET', path: '/v1/languages', access: '公开', desc: '语言枚举', detail: '返回 {items:[{code,label,english}]}。code 可用于 lang 查询参数；未知语言码会回退到默认语言，而不是报错。' },
      { method: 'GET', path: '/v1/collections', access: '公开', desc: '合集列表', detail: '查询参数 page（默认 1）和 page_size（默认 24、最大 48）。返回 {items,page,page_size,total,total_pages}；列表只带合集摘要。' },
      { method: 'GET', path: '/v1/collections/:id', access: '公开', desc: '合集详情及游戏', detail: '路径参数 id 为合集编号，可选 lang。返回 {collection,games}；games 是完整 Game 对象数组，按公开字段白名单映射，不包含 ROM 地址。不存在返回 404。' },
      { method: 'GET', path: '/v1/live/rooms', access: '公开', desc: '在播房间', detail: '可选 game=<slug> 筛选单款游戏；返回 {items:[LiveRoom]}，每个条目含可直接打开的 watchUrl。房间列表是实时快照，不做边缘缓存。' },
      { method: 'GET', path: '/v1/live/rooms/:roomId', access: '公开', desc: '单个直播房间', detail: '路径参数 roomId；返回一个已脱敏 LiveRoom 快照及 watchUrl。房间不存在返回 404 not_found；不会暴露主播 IP、续播凭证或 socket id。' },
      { method: 'GET', path: '/v1/live/capacity', access: '公开', desc: '直播容量预检', detail: '返回 {used,max,remaining,available}，不缓存也不预留席位。available=true 仅代表查询瞬间有容量，真正开播仍可能因并发占满而失败。' },
      { method: 'GET', path: '/v1/netplay/rooms', access: '公开', desc: 'P2P 联机房间', detail: '可选 game=<slug>；返回 {items:[NetplayRoom]}。带 game 时按本站游戏 id 筛选，并额外返回 gameSlug 与 joinUrl；不带时保留协议原生 gameId。这里只发现房间，实时输入与媒体仍走 WebRTC/Socket.IO。' },
      { method: 'GET', path: '/v1/netplay/rooms/:roomId', access: '公开', desc: '单个联机房间', detail: '路径参数 roomId；可选 game=<slug> 校验房间游戏并取得 joinUrl。房主迁移后旧 roomId 仍可查；房间不存在或游戏不匹配返回 404。' },
      { method: 'GET', path: '/v1/health', access: '公开', desc: '服务与数据库健康状态', detail: '返回 {service,db,timestamp}；数据库不可用时 HTTP 503。这条探针不受目录限流。' },
    ],
  },
  {
    title: '应用令牌 · AppID + AppKey',
    items: [
      { method: 'POST', path: '/v1/token', access: 'AppID + AppKey', desc: '换 15 分钟访问令牌', detail: 'JSON 或 application/x-www-form-urlencoded；凭据可放 HTTP Basic，也可放 client_id/client_secret 字段。grant_type=client_credentials 取应用令牌，响应含 access_token/token_type/expires_in/scope/rom_access；用户数据不能用此流。它也承接 device_code 的轮询换令牌。' },
      { method: 'GET', path: '/v1/me', access: '有效令牌', desc: '自查令牌和权限', detail: '成功返回 {client_id,kind,user_id,scope,expires_at}。应用令牌的 kind=app、user_id=null；用户令牌的 kind=user。遇其他接口 401/403 时可先确认拿的是哪类令牌、是否有需要的 scope。' },
      { method: 'GET', path: '/v1/games/:slug/rom', access: 'games.rom', desc: '领取 ROM 下载凭据', detail: '沙箱只允许 /v1/rom-samples 所列游戏，其余返回 403 sandbox_resource_only；审核通过可访问全库。可传 lang 和 delivery=redirect|plain；plain 会直接返回服务端解密 / 解压后的 ROM 流，不需要客户端改写 URL。响应含 requires_network；null 表示尚未核实。' },
      { method: 'GET', path: '/v1/rom/:grant', access: '下载凭据', desc: '兑现 ROM 凭据（302）', detail: '上一步返回的 url 就是此端点；不再带 Bearer，跟随 302 跳转到对象存储下载。凭据 5 分钟过期，每张票最多兑现 10 次，并受每 IP 60 次/分钟限制。' },
      { method: 'GET', path: '/v1/rom-plain/:grant', access: '下载凭据', desc: '兑现并流式返回明文 ROM', detail: 'delivery=plain 领到的凭据专用于此端点；旧版未选择 delivery 的凭据仍兼容两种路径。不需 Bearer。8BG 包由服务端按需解密、解压后流式返回；普通 ROM 直接透传。支持 HEAD 与单段 Range/If-Range 断点续传。存在单文件大小、并发数与超时限制；过载会返回 503 server_busy，超限 413 payload_too_large。' },
      { method: 'HEAD', path: '/v1/rom-plain/:grant', access: '下载凭据', desc: '查询明文 ROM 元信息', detail: '与明文 GET 共用凭据和限流，不返回 ROM 正文；用于先读取 Content-Length、Accept-Ranges、ETag 等响应头。Express 由同一路由处理 HEAD。' },
      { method: 'GET', path: '/v1/games/:slug/embed', access: 'games.read', desc: '获取嵌入播放器地址', detail: '路径参数 slug，可选 lang；返回 {url,expires_in,allow}，签名地址默认有效 1 小时。当前嵌入页未强制验证签名，因此该地址不是安全边界，也不应当作访问控制。' },
    ],
  },
  {
    title: '用户令牌 · 设备码授权',
    items: [
      { method: 'POST', path: '/v1/device/code', access: 'AppID + AppKey', desc: '申请设备授权码', detail: 'JSON 或表单请求体含 client_id/client_secret，可选 scope。仅机密客户端可用；返回 device_code（机器轮询）、user_code（展示给用户）、verification_uri、verification_uri_complete、expires_in=900、interval=5。用户确认后用完整 device grant 值向 /v1/token 轮询。' },
      { method: 'GET', path: '/v1/library', access: '用户令牌 · library.read', desc: '收藏与最近在玩', detail: '可选 lang；返回 {favorites,recent,favorites_total}。favorites 是最多 100 款的完整 Game 对象；recent 最多 12 款。favorites_total 是实际收藏总量，可判断列表是否被截断。' },
      { method: 'POST', path: '/v1/games/:slug/play', access: '用户令牌 · library.write', desc: '上报真实开玩', detail: '只在模拟器真正可玩后调用；同时刷新最近游玩。同一账号跨设备、换网络或重试都只增加一次，counted 表示本次是否实际计数。' },
      { method: 'POST', path: '/v1/live/publish-token', access: '用户令牌 · live.write', desc: '外部设备领取开播凭证', detail: 'POST 无需额外 body。返回 publisher_token、token_type=LivePublisher、expires_in（默认 12 小时，可由服务器配置）、protocol、signaling_url、socket_path、namespace、auth_field、capacity_url、ice_url。publisher_token 只能放 Socket.IO /live 握手认证中作为主播，不能用于 REST API。' },
      { method: 'GET', path: '/v1/saves', access: '用户令牌 · saves.read', desc: '存档清单', detail: '返回 {items:[SaveMeta]}，每项含 runtime、game_slug、slot、size（字节）、created_at、updated_at。只列元信息，不含存档内容；用户的数据只对当前用户令牌可见。' },
      { method: 'GET', path: '/v1/saves/:runtime/:slug', access: '用户令牌 · saves.read', desc: '下载单份存档', detail: 'runtime 是引擎标识、slug 是游戏标识；可传 slot=0…9，默认 0。返回 application/octet-stream 二进制，x-save-updated-at 是 Unix 毫秒时间戳；坐标不合法 400，存档不存在 404。' },
    ],
  },
  {
    title: '浏览器 OAuth 2.0 · 授权码 + PKCE',
    items: [
      { method: 'GET', path: '/api/oauth/authorize', access: '站内登录令牌', desc: '发起或读取授权请求', detail: 'query 必需：client_id、redirect_uri（必须与控制台登记值完全一致）、response_type=code、code_challenge（43 位 Base64URL SHA-256）、code_challenge_method=S256；可选 scope（空格分隔）和 state。请求需携带 8BitGo 站内登录 Bearer。Accept: application/json 返回应用信息、权限、allowed；否则返回授权确认 HTML。浏览器客户端通常跳到 /open/authorize 页面进入此流程。' },
      { method: 'POST', path: '/api/oauth/authorize', access: '站内登录令牌', desc: '同意或拒绝授权', detail: '重复校验 GET 的所有参数，并要求登录。表单或 JSON 提交 decision=approve/deny。成功默认 302 回登记的 redirect_uri，并带一次性 code 与原 state；Accept: application/json 时返回 {redirect_uri,state,code,error}。拒绝返回 error=access_denied。' },
      { method: 'POST', path: '/api/oauth/token', access: '授权码 + PKCE', desc: '授权码换用户令牌', detail: '仅收 application/x-www-form-urlencoded。必需 grant_type=authorization_code、client_id、code、redirect_uri、code_verifier；机密客户端还要 client_secret，公开客户端不发 secret。code_verifier 为 43–128 个允许字符；授权码 60 秒有效、一次性，并绑定应用和 redirect_uri。成功返回 15 分钟 Bearer 用户令牌。' },
      { method: 'GET', path: '/api/open-device/:code', access: '站内登录令牌', desc: '读取设备授权确认页信息', detail: '这是 /open/device 页面使用的站内接口，不是第三方服务端的公开 API。返回应用信息、申请权限及是否允许当前账号授权；需要 8BitGo 站内登录 Bearer。' },
      { method: 'POST', path: '/api/open-device/:code', access: '站内登录令牌', desc: '确认或拒绝设备码授权', detail: '这是 /open/device 页面使用的站内接口。JSON 请求体 {"approve":true} 表示同意，false 表示拒绝；成功返回 {ok,approved}。无效或过期代码 404，重复处理 409。' },
    ],
  },
  {
    title: '协议发现 · 站点根路径',
    items: [
      { method: 'GET', path: '/.well-known/oauth-authorization-server', access: '公开', desc: 'OAuth 2.0 授权服务器元数据', detail: 'RFC 8414 元数据，列出 issuer、授权/令牌/设备码/JWKS 地址、支持的 grant、scope 和 PKCE S256。它描述 OAuth 2.0，不代表支持 OpenID Connect。' },
      { method: 'GET', path: '/.well-known/jwks.json', access: '公开', desc: '令牌验签公钥', detail: '开放平台 access token 使用 RS256。服务端验令牌通常直接调用 API 即可；只有需要在自己服务端本地验签时才读取 JWKS，并按 kid 选择密钥。未配置密钥时返回 503。' },
      { method: 'GET', path: '/.well-known/openapi.json', access: '公开', desc: '机器可读 OpenAPI 规格', detail: '返回 OpenAPI 3.1 JSON，覆盖当前 /api/open/v1 下的全部接口。代码生成器可直接导入；它不包含站内控制台管理 API。' },
    ],
  },
]

const DOC_GAME_QUERIES: [string, string][] = [
  ['platform', '平台 id，见 /v1/platforms；可与 genre 组合'],
  ['requires_windows', 'false 排除 Windows 3.x / 95 / 98 客体；true 只看这类游戏；默认不筛选'],
  ['genre', '类型 id，见 /v1/genres'],
  ['q', '关键词；未指定 sort 时按相关度排序'],
  ['sort', 'popular / newest / name / rating / home'],
  ['page · page_size', '页码从 1 开始；每页默认 24，最多 50'],
  ['lang', '语言码，默认 en；中文传 zh-Hans'],
]

const DOC_ERRORS: [string, string, string][] = [
  ['400', 'invalid_request', '参数格式不正确；requires_windows 只接受 true / false'],
  ['400', 'unsupported_grant_type', '/api/open/v1/token 支持 client_credentials 与完整 device_code grant；/api/oauth/token 只支持 authorization_code'],
  ['400', 'unauthorized_client', 'public 客户端不能用 client_credentials 或设备码流程'],
  ['400', 'invalid_scope', 'scope 不认识 / 未获批 / 要了用户级'],
  ['400', 'authorization_pending', '用户尚未同意设备码，按 interval 继续轮询'],
  ['400', 'slow_down', '设备码轮询过快，按返回的 interval 放慢'],
  ['400', 'invalid_grant', '设备码 / 授权码无效、已使用或 PKCE 校验失败'],
  ['400', 'expired_token', '设备码或 OAuth 授权码已过期；重新发起授权'],
  ['400', 'invalid_redirect_uri', '回调地址未精确登记在应用设置中'],
  ['400', 'unsupported_response_type', '浏览器授权只支持 response_type=code'],
  ['401', 'invalid_client', 'AppID / key 不匹配，或应用已停用；服务端不区分账号是否存在'],
  ['401', 'invalid_token', '令牌无效或过期；应用令牌重新取，用户令牌重新走授权流程'],
  ['403', 'insufficient_scope', '差哪个 scope（响应带 scope 字段）'],
  ['403', 'invalid_grant', 'ROM 下载凭据无效或签名校验失败'],
  ['403', 'app_not_authorized', '应用已停用，或当前没有对应 ROM / 嵌入权限'],
  ['403', 'sandbox_resource_only', '沙箱 ROM 权限仅限 /v1/rom-samples 列出的样本'],
  ['403', 'access_denied', '用户拒绝授权，或沙箱应用不能请求当前账号授权'],
  ['404', 'not_found', '资源不存在或不可见；游戏下架/成人/不存在对外不区分'],
  ['404', 'rom_unavailable', '这款游戏没有可下载 ROM'],
  ['410', 'grant_expired', 'ROM 凭据过期 → 回第一步重换'],
  ['413', 'payload_too_large', '明文 ROM 超过服务端允许上限'],
  ['415', 'unsupported_codec', '服务端暂不支持该 8BG 压缩算法'],
  ['429', 'rate_limited', '看 Retry-After 退避'],
  ['502', 'bad_gateway', 'ROM 源站读取或转码失败；稍后重试'],
  ['503', 'server_busy', 'ROM 明文转码并发已满；稍后重试'],
  ['504', 'upstream_timeout', 'ROM 源站读取或转码超时；稍后重试'],
  ['500', 'server_error', '服务端问题，重试或联系我们'],
  ['501', 'temporarily_unavailable', '服务端未启用开放平台'],
]

const DOC_RATES: [string, string][] = [
  ['匿名目录 · 单 IP', '300 / 分钟'],
  ['匿名目录 · 全站', '3000 / 分钟'],
  ['带令牌接口 · 单 AppID', '3600 / 小时'],
  ['取令牌 · 单 IP / AppID', '120 / 60 每小时（含 OAuth 授权码兑换）'],
  ['申请设备码 · 单 IP / AppID', '各 60 / 小时'],
  ['领取 ROM 凭据 · 沙箱 AppID / 上产 AppID', '10 / 600 每小时'],
  ['兑现 ROM 凭据 · 单凭据 / IP', '10 / 5 分钟；60 / 分钟'],
]

const DOC_GAME_FIELDS: [string, string, string][] = [
  ['slug', 'string', '对外唯一标识，所有端点都用它'],
  ['title / description', 'string', '已按 lang 取好的单语言文本'],
  ['lang_requested', 'string', '你要求的语言'],
  ['lang_actual', '{title,description}', '实际是哪门；und=原名'],
  ['platform', 'string', '平台 id，如 nes / dos'],
  ['requires_windows', 'bool', 'DOS 游戏是否需要 Windows 3.x / 95 / 98 客体；其他平台为 false'],
  ['requires_network', 'bool|null', '是否依赖外部网络；null = 尚未核实，不等于离线可玩'],
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

const DOC_OTHER_FIELDS: [string, string][] = [
  ['TokenResponse', 'access_token, token_type=Bearer, expires_in（秒）, scope；仅 client_credentials 另有 rom_access=none/samples/full'],
  ['DeviceCodeResponse', 'device_code（机器轮询）, user_code（给用户）, verification_uri, verification_uri_complete, expires_in, interval（秒）'],
  ['RomGrantResponse', 'url（5 分钟凭据）, delivery, requires_network, expires_in, lang_requested, lang_actual, filename；不返回对象存储 key'],
  ['EmbedResponse', 'url, expires_in, allow（iframe 功能策略字符串）'],
  ['LibraryResponse', 'favorites（最多 100 款）, recent（最多 12 款）, favorites_total（未截断总数）'],
  ['SaveMeta', 'runtime, game_slug, slot, size（字节）, created_at, updated_at；不含存档内容'],
  ['LiveCapacity', 'used, max, remaining, available；只是瞬时预检，不代表占位成功'],
  ['LiveRoom', 'roomId, title, gameSlug, gameName, platform, hostName, viewers, maxViewers, startedAt, hostAway, hostFrozen, netplayRoomId, coopOpen, coopTaken, presence, watchUrl'],
  ['NetplayRoom', 'roomId, gameId, roomName, createdAt, host, presence, players/max, spectators/maxSpectators, hasPassword, members, kind, awaitingHost, claimed, hasState, migratedTo；带 game 查询时另有 gameSlug/joinUrl'],
  ['CollectionSummary', 'id, title, kind, description, gameCount, viewCount, covers, author, hidden, createdAt, updatedAt'],
  ['LivePublisherGrant', 'publisher_token, token_type, expires_in, protocol, signaling_url, socket_path, namespace, auth_field, capacity_url, ice_url'],
  ['Error', 'error, error_description, error_uri；部分错误另带 scope、retry_after、interval。/api/open-device 是站内页面接口，使用简化的中文 error，不是同一种错误封套'],
]

const DOC_TABS: { id: 'auth' | 'endpoints' | 'ref'; label: string }[] = [
  { id: 'auth', label: '接入与鉴权' },
  { id: 'endpoints', label: '接口' },
  { id: 'ref', label: '数据 & 错误码' },
]

function MethodBadge({ method }: { method: 'GET' | 'POST' | 'HEAD' }) {
  return (
    <span
      className={cx(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold',
        method === 'GET' ? 'bg-brand-soft text-brand-hover' : method === 'POST' ? 'bg-coin/20 text-coin' : 'bg-surface-2 text-muted',
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

function DocCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative rounded-lg border border-line bg-surface-2">
      <button
        type="button"
        className="absolute right-2 top-2 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
        onClick={() => void writeClipboardText(code).then(setCopied)}
        aria-label="复制代码示例"
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre className="overflow-x-auto whitespace-pre px-3 py-3 pr-12 font-mono text-[11px] leading-5 text-fg">{code}</pre>
    </div>
  )
}

function DocsPanel() {
  const [tab, setTab] = useState<'auth' | 'endpoints' | 'ref'>('auth')
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface" aria-label="开放平台 API 文档">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <strong className="text-sm">API 文档</strong>
        <a href="/.well-known/openapi.json" target="_blank" rel="noreferrer" className="text-xs text-brand-hover underline underline-offset-2">机器可读规格 ↗</a>
      </div>
      <div className="flex border-b border-line bg-surface/95" role="tablist" aria-label="文档章节">
        {DOC_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`open-doc-tab-${t.id}`}
            aria-controls="open-doc-panel"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'flex-1 px-2 py-3 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-brand',
              tab === t.id ? 'border-b-2 border-brand text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        key={tab}
        role="tabpanel"
        id="open-doc-panel"
        aria-labelledby={`open-doc-tab-${tab}`}
        className="max-h-[calc(100vh-10rem)] space-y-5 overflow-y-auto p-4 text-xs leading-5"
      >
        {tab === 'auth' && (
          <>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-dim">Base URL</p>
              <code className="mt-1 block break-all rounded-lg border border-line bg-surface-2 px-3 py-2 text-fg">https://8bitgo.com/api/open/v1</code>
            </div>
            <DocSection title="第一步 · 读取公开目录">
              <p className="text-muted">游戏、平台、类型和语言目录可以直接 GET，无需创建应用或携带令牌。低性能设备查询普通 DOS 游戏：</p>
              <DocCode code="curl 'https://8bitgo.com/api/open/v1/games?platform=dos&requires_windows=false&page_size=10&lang=zh-Hans'" />
              <p className="text-dim">不传 <code className="text-fg">requires_windows</code> 时，DOS 和 Windows 客体游戏都会返回。<code className="text-fg">false</code> 排除需要 Windows 3.x / 95 / 98 的游戏。</p>
            </DocSection>
            <DocSection title="第二步 · 需要授权时取令牌">
              <p className="text-muted">ROM 下载凭据、嵌入地址、令牌自查和用户数据需要令牌。先在左侧创建应用，保存只显示一次的 AppKey：</p>
              <DocCode code="curl -u 'APP_ID:APP_KEY' -d grant_type=client_credentials 'https://8bitgo.com/api/open/v1/token'" />
              <p className="text-muted">令牌有效期 15 分钟。后续请求带 <code className="text-fg">Authorization: Bearer &lt;access_token&gt;</code>。沙箱申请 <code className="text-fg">games.rom</code> 即可下载 <code>/v1/rom-samples</code> 中的样本；全库需审核通过。</p>
              <p className="text-dim">AppKey 是机密：不要放进网页前端、公开仓库或会发给用户的固件。纯前端应用使用授权码 + PKCE，不需要也不应保存 AppKey。</p>
              <p className="text-dim">公开接口不带 Authorization 就能读；带了无效或过期令牌会返回 <code className="text-fg">401 invalid_token</code>。设备码授权在同一个 token 接口轮询，grant 值必须是 <code className="text-fg">urn:ietf:params:oauth:grant-type:device_code</code>。</p>
            </DocSection>
            <DocSection title="下载 ROM · 两步，凭据短时有效">
              <p className="text-muted">第一步用带 <code className="text-fg">games.rom</code> 的 Bearer 领取凭据；沙箱 slug 必须来自 <code className="text-fg">/v1/rom-samples</code>。</p>
              <DocCode code='curl -H "Authorization: Bearer ACCESS_TOKEN" "https://8bitgo.com/api/open/v1/games/contra/rom?lang=ja&delivery=plain"' />
              <p className="text-muted">默认 <code className="text-fg">delivery=redirect</code>，第二步会 302 到原对象；不支持 8BG 解码的客户端传 <code className="text-fg">delivery=plain</code>，返回的 <code className="text-fg">url</code> 会直接指向服务端解密 / 解压后的 ROM 流，支持 HEAD 和 Range 续传。<code className="text-fg">requires_network</code> 是站点核实过的游戏依赖提示；<code className="text-fg">null</code> 表示未知，不代表已打包所有资源。</p>
            </DocSection>
            <DocSection title="第三步 · 读取玩家数据">
              <p className="text-muted">应用级令牌没有玩家身份。设备先向 <code className="text-fg">POST /v1/device/code</code> 申请码，玩家在 <code className="text-fg">/open/device</code> 同意后，设备轮询 <code className="text-fg">POST /v1/token</code> 换用户令牌。</p>
              <p className="text-dim"><code className="text-fg">authorization_pending</code> 与 <code className="text-fg">slow_down</code> 表示继续等待；轮询间隔以接口返回的 <code className="text-fg">interval</code> 为准。</p>
            </DocSection>
            <DocSection title="浏览器应用 · OAuth 授权码 + PKCE">
              <p className="text-muted">有浏览器的 Web 应用应跳转至 <code className="text-fg">/open/authorize</code>，使用 <code className="text-fg">response_type=code</code>、登记过的 <code className="text-fg">redirect_uri</code> 和 <code className="text-fg">S256</code> PKCE。用户登录并同意后，回调收到短时一次性 code，再用 <code className="text-fg">POST /api/oauth/token</code> 兑换用户令牌。</p>
              <p className="text-dim">兑换 body 为 <code className="text-fg">application/x-www-form-urlencoded</code>，包括 <code className="text-fg">grant_type=authorization_code</code>、client_id、code、redirect_uri 和 code_verifier。公开客户端不发送 AppKey；机密客户端还要 AppKey。授权码仅 60 秒有效且不能重放。</p>
            </DocSection>
            <DocSection title="发现与边界">
              <p className="text-muted">OAuth 元数据位于 <code className="text-fg">/.well-known/oauth-authorization-server</code>，验签公钥位于 <code className="text-fg">/.well-known/jwks.json</code>；完整机器规格见 <code className="text-fg">/.well-known/openapi.json</code>。</p>
              <p className="text-dim">当前是 OAuth 2.0，不是 OIDC：不签 id_token，也没有 userinfo、refresh_token、revoke。站内应用管理 API 不是第三方开放 API，不要从浏览器控制台调用。</p>
            </DocSection>
            <DocSection title="接入约定">
              <p className="text-muted">响应中的 <code className="text-fg">error</code> 是稳定错误码；429 按 <code className="text-fg">Retry-After</code>（秒）退避。第三方开放 API 和 OAuth token 请求使用 Bearer/客户端凭据，不靠 cookie；设备授权确认页的 <code className="text-fg">/api/open-device</code> 是站内登录接口，不属于任意来源可调用的开放 API。</p>
              <p className="text-dim">本地运行前先查 <code className="text-fg">/v1/platforms</code> 的 <code className="text-fg">native</code> 和 <code className="text-fg">enabled</code>，再看游戏的 <code className="text-fg">requires_windows</code>。Windows 客体需要 DOSBox-X；普通 DOS 与它不能仅凭 <code className="text-fg">platform=dos</code> 区分。</p>
            </DocSection>
          </>
        )}

        {tab === 'endpoints' && (
          <>
            <DocSection title="游戏列表 · 查询参数">
              <p className="text-muted">所有条件先求交集，再计算 <code className="text-fg">total</code> 和分页；未传筛选条件时返回全部可公开游戏。</p>
              <div className="space-y-1.5">
                {DOC_GAME_QUERIES.map(([name, desc]) => (
                  <div key={name} className="border-b border-line/60 pb-1.5 last:border-b-0">
                    <code className="font-semibold text-fg">{name}</code> <span className="text-muted">{desc}</span>
                  </div>
                ))}
              </div>
              <DocCode code="GET /v1/games?platform=dos&requires_windows=false&page_size=10" />
            </DocSection>
            <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-muted">以下列出可供第三方接入的 API。<code className="text-fg">/v1</code> 使用上方 Base URL；OAuth 与 <code className="text-fg">/.well-known</code> 使用站点根路径。站内应用管理接口仅供 8BitGo 页面自身使用。</p>
            {DOC_ENDPOINT_GROUPS.map((group) => (
              <DocSection key={group.title} title={group.title}>
                <div className="space-y-2">
                  {group.items.map((e) => (
                    <details key={e.path} className="group rounded-lg border border-line bg-surface-2/50">
                      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                        <MethodBadge method={e.method} />
                        <span className="min-w-0 flex-1">
                          <code className="break-all font-semibold text-fg">{e.path}</code>
                          <span className="mt-0.5 block text-[11px] text-muted">{e.desc} · {e.access}</span>
                        </span>
                        <span aria-hidden className="text-muted group-open:rotate-180">⌄</span>
                      </summary>
                      <p className="border-t border-line px-3 py-2.5 text-muted">{e.detail}</p>
                    </details>
                  ))}
                </div>
              </DocSection>
            ))}
          </>
        )}

        {tab === 'ref' && (
          <>
            <DocSection title="游戏对象字段">
              <p className="text-muted">列表元素、详情、合集与用户收藏中的游戏共用这套字段。普通 DOS 游戏的 <code className="text-fg">requires_windows</code> 为 false；需要 Windows 客体的游戏为 true。</p>
              <DocCode code={'{"slug":"…","platform":"dos","requires_windows":false,"rom_langs":["*"]}'} />
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
              <p className="text-dim">不会返回 ROM 存储地址、后台运行参数或隐藏状态；请只依赖上表列出的对外字段。</p>
            </DocSection>

            <DocSection title="其他响应对象字段">
              <p className="text-muted">端点成功响应的完整 JSON schema 可从 OpenAPI 规格导入；下表列出最常用的对象结构和字段语义。</p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[10px]">
                  <thead>
                    <tr className="text-left text-dim">
                      <th className="border-b border-line py-1 pr-2 font-medium">对象</th>
                      <th className="border-b border-line py-1 font-medium">字段 / 说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOC_OTHER_FIELDS.map(([name, fields]) => (
                      <tr key={name}>
                        <td className="border-b border-line/60 py-1 pr-2 align-top"><code className="text-fg">{name}</code></td>
                        <td className="border-b border-line/60 py-1 align-top text-muted">{fields}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DocSection>

            <DocSection title="错误码">
              <p className="text-muted">开放 API 与 OAuth 错误采用 JSON：<code className="text-fg">error</code> 是程序判断用的稳定码，<code className="text-fg">error_description</code> 是说明，<code className="text-fg">error_uri</code> 指向说明页。不要根据中文说明文本写分支。</p>
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
                      <tr key={`${http}-${err}`}>
                        <td className="border-b border-line/60 py-1 pr-2 align-top text-dim">{http}</td>
                        <td className="border-b border-line/60 py-1 pr-2 align-top"><code className="text-fg">{err}</code></td>
                        <td className="border-b border-line/60 py-1 align-top text-muted">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DocSection>

            <DocSection title="限流">
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
              <p className="text-dim">429 响应带 <code className="text-fg">Retry-After</code> 头，单位秒。匿名目录同时受单 IP 和全站配额限制；带令牌调用按 AppID 计数。</p>
            </DocSection>

            <DocSection title="本页接口使用的 Scope">
              <ul className="space-y-1">
                <li><code className="text-fg">games.read</code> <span className="rounded bg-brand-soft px-1 text-brand-hover">自助</span> <span className="text-dim">嵌入地址需要；公开游戏目录不需要</span></li>
                <li><code className="text-fg">games.rom</code> <span className="rounded bg-coin/20 px-1 text-coin">全库需审核</span> <span className="text-dim">沙箱可领逐机型样本的 ROM 下载凭据</span></li>
                <li><code className="text-fg">library.read</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">用户级，需设备码流程</span></li>
                <li><code className="text-fg">library.write</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">用户级；目前仅用于真实开玩上报，不提供收藏写入</span></li>
                <li><code className="text-fg">live.write</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">用户级；换取外部设备专用直播发布凭证</span></li>
                <li><code className="text-fg">saves.read</code> <span className="rounded bg-coin/20 px-1 text-coin">需审核</span> <span className="text-dim">用户级，需设备码流程</span></li>
              </ul>
              <p className="text-dim">当前没有收藏写入、云存档写入、用户资料、OIDC id_token 或 userinfo 接口；权限目录里即使出现 <code className="text-fg">openid</code>、<code className="text-fg">profile</code>、<code className="text-fg">email</code>、<code className="text-fg">saves.write</code>，也不要据此假设这些功能已经可用。</p>
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
  await writeClipboardText(text)
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
