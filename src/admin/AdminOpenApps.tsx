import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import {
  approveApp,
  rejectApp,
  restoreApp,
  reviewApp,
  reviewQueue,
  statusLabel,
  suspendApp,
  SCOPE_LABELS,
  type OpenAppReview,
  type ReviewQueueItem,
} from '@/services/openApps'

/**
 * 后台 · 开放平台应用审核。权限点 **`apps:review`**（当下只给 admin）。
 *
 * ## 审的到底是什么
 *
 * 不是「这段说明写得好不好」，而是三件能查证的事：
 *
 *   1. **主页打得开吗** —— 一个申请上产却没有站的应用，没有可审的内容；
 *   2. **回调地址 / 嵌入域名是不是他自己的域名** —— 填别人的域名是最典型的钓鱼形状；
 *   3. **勾的权限和他说的事对得上吗** —— 一个「做游戏导航站」的应用要 `saves.write`，
 *      那就得问一句。
 *
 * 所以这一页把这三样并排摆出来，而不是只给一个「同意 / 拒绝」。
 *
 * ## 两个按钮的语义不对称
 *
 * **通过**可以只批一部分 scope（默认全批，但每一项都能取消勾选）——「元数据和登录给你，
 * ROM 先不给」是最常见的结论。**打回**必须写理由，而且理由会原样显示给申请人：
 * 一个没有理由的「已拒绝」只会换来一次一模一样的重新提交。
 */
export function AdminOpenApps() {
  const [state, setState] = useState('pending')
  const [items, setItems] = useState<ReviewQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await reviewQueue(state)
      setItems(r.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [state])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-semibold">开放平台 · 应用审核</h1>
        <div className="flex gap-1">
          {[
            { v: 'pending', label: '待审核' },
            { v: 'rejected', label: '已打回' },
            { v: '', label: '全部' },
          ].map((t) => (
            <button
              key={t.v}
              type="button"
              onClick={() => setState(t.v)}
              className={cx(
                'rounded-lg px-2.5 py-1 text-xs transition',
                state === t.v ? 'bg-brand-soft font-semibold text-fg' : 'text-muted hover:bg-black/5',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void load()}>
          刷新
        </Button>
      </header>

      {loading ? (
        <p className="text-sm text-muted">加载中…</p>
      ) : err ? (
        <p className="text-sm text-live">{err}</p>
      ) : !items.length ? (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
          {state === 'pending' ? '没有待审核的申请。' : '这一档下没有应用。'}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((app) => (
            <Row key={app.id} app={app} open={openId === app.id} onToggle={() => setOpenId(openId === app.id ? '' : app.id)} onDone={load} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Row({ app, open, onToggle, onDone }: { app: ReviewQueueItem; open: boolean; onToggle: () => void; onDone: () => void }) {
  const badge = statusLabel(app)
  const [reviews, setReviews] = useState<OpenAppReview[]>([])
  const [lastUsed, setLastUsed] = useState<string | null>(null)
  const [scopes, setScopes] = useState<string[]>(app.requestedScopes)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const d = await reviewApp(app.id)
        setReviews(d.reviews)
        setScopes(d.app.requestedScopes)
        // 「这个应用真的在跑吗」—— 密钥的最近使用时间是最直接的证据
        const used = d.secrets.map((s) => s.lastUsedAt).filter(Boolean).sort()
        setLastUsed(used.length ? used[used.length - 1]! : null)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [open, app.id])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setErr('')
    setNotice('')
    try {
      const r = (await fn()) as { notice?: string }
      if (r?.notice) setNotice(r.notice)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const toggle = (s: string) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  return (
    <li className="rounded-xl border border-line bg-surface">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{app.name}</span>
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{badge.text}</span>
            {/* 敏感项直接标在标题行：这一页最该被人看一眼的就是它 */}
            {app.sensitive.map((s) => (
              <span key={s} className="shrink-0 rounded bg-live/15 px-1.5 py-0.5 text-[10px] font-semibold text-live">
                {s}
              </span>
            ))}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-dim">
            {app.owner.nickname || app.owner.id} · {app.owner.email} · 提交于 {fmtDate(app.submittedAt) || '—'}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted">{open ? '收起' : '查看'}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4 text-xs">
          {/* 三件能查证的事 */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Info label="主页">
              {app.homepage ? (
                <a href={app.homepage} target="_blank" rel="noreferrer noopener" className="break-all underline underline-offset-2">
                  {app.homepage}
                </a>
              ) : (
                <span className="text-live">没填 —— 上产申请通常应该有</span>
              )}
            </Info>
            <Info label="回调地址">
              {app.redirectUris.length ? app.redirectUris.map((u) => <span key={u} className="block break-all">{u}</span>) : <span className="text-dim">无</span>}
            </Info>
            <Info label="嵌入域名">
              {app.embedOrigins.length ? app.embedOrigins.map((u) => <span key={u} className="block break-all">{u}</span>) : <span className="text-dim">无</span>}
            </Info>
          </div>
          <p className="rounded-lg bg-surface-2 px-3 py-2 leading-relaxed">
            <b className="block text-[11px] text-dim">用途说明</b>
            {app.reviewNote || <span className="text-dim">（空）</span>}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Info label="AppID">
              <code className="break-all">{app.id}</code>
            </Info>
            <Info label="Key 最近使用">
              {lastUsed ? fmtDate(lastUsed) : <span className="text-live">从没调用过 —— 他可能还没真的接</span>}
            </Info>
          </div>

          {app.reviewState === 'pending' ? (
            <>
              <section>
                <h3 className="font-semibold">最终批哪些权限</h3>
                <p className="mt-1 text-dim">默认全批。取消勾选就是「这一项先不给」—— 申请人会在控制台看到差别。</p>
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {app.requestedScopes.map((s) => (
                    <label key={s} className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2">
                      <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-0.5" />
                      <span className="min-w-0">
                        <code className={cx('font-semibold', app.sensitive.includes(s) && 'text-live')}>{s}</code>
                        <span className="block text-dim">{SCOPE_LABELS[s] ?? ''}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy !== '' || !scopes.length} onClick={() => void run('approve', () => approveApp(app.id, scopes.join(' ')))}>
                  {busy === 'approve' ? '处理中…' : `通过（${scopes.length} 项）`}
                </Button>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="打回理由（申请人会看到，必填）"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 outline-none focus:border-brand"
                />
                <Button size="sm" variant="ghost" disabled={busy !== '' || !reason.trim()} onClick={() => void run('reject', () => rejectApp(app.id, reason.trim()))}>
                  打回
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {app.status === 'suspended' ? (
                <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => void run('restore', () => restoreApp(app.id))}>
                  恢复（回到停用前那一档）
                </Button>
              ) : (
                <>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="停用理由（必填）"
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 outline-none focus:border-brand"
                  />
                  <Button size="sm" variant="ghost" disabled={busy !== '' || !reason.trim()} onClick={() => void run('suspend', () => suspendApp(app.id, reason.trim()))}>
                    停用
                  </Button>
                </>
              )}
            </div>
          )}

          {/* 停用之后那句「不是当场断」必须显示出来 */}
          {notice && <p className="rounded-lg bg-coin/15 px-3 py-2 leading-relaxed text-coin">{notice}</p>}
          {err && <p className="text-live">{err}</p>}

          {!!reviews.length && (
            <section>
              <h3 className="font-semibold">审核记录</h3>
              <ul className="mt-1.5 space-y-1 text-dim">
                {reviews.map((r) => (
                  <li key={r.id}>
                    {fmtDate(r.at)} · <b>{r.actor}</b> · {ACTIONS[r.action] ?? r.action}
                    {r.detail && <span className="text-muted"> —— {r.detail.slice(0, 160)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </li>
  )
}

const ACTIONS: Record<string, string> = {
  submit: '提交审核',
  withdraw: '撤回申请',
  approve: '通过',
  reject: '打回',
  suspend: '停用',
  restore: '恢复',
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-dim">{label}</p>
      <p className="mt-0.5 break-words">{children}</p>
    </div>
  )
}

function fmtDate(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}
