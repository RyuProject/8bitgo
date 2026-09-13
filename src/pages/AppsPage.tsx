import { useEffect, useState, type FormEvent } from 'react'
import { useT } from '@/services/i18n'
import { useSeo } from '@/services/seo'
import { apiEnabled } from '@/services/api'
import { fetchApps, submitCommunityApp, type AppItem, type AppsGroup } from '@/services/apps'
import { romUrlForKey } from '@/services/roms'
import { Button, buttonClasses } from '@/components/ui/Button'

/** 把存储的下载地址（外链或 R2 key）拼成可点击的 URL */
function downloadHref(item: AppItem): string | null {
  const raw = item.downloadUrl
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  return romUrlForKey(raw) || null
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-sm focus:outline-none focus:border-brand'
const btnPrimary = 'inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-hover disabled:cursor-wait disabled:opacity-60'
const btnSecondary = 'inline-flex items-center justify-center rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-semibold transition hover:bg-black/5 disabled:opacity-60'

export function AppsPage() {
  const t = useT()
  const [group, setGroup] = useState<AppsGroup | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitOpen, setSubmitOpen] = useState(false)

  useSeo({ title: t.apps.title, description: t.apps.desc })

  useEffect(() => {
    if (!apiEnabled()) {
      setGroup({ sdk: [], app: [], community: [] })
      setLoading(false)
      return
    }
    setLoading(true)
    fetchApps()
      .then(setGroup)
      .catch((e) => {
        // 应用中心是「未上线功能的占位」：接口拿不到（本地没起后端 / 库里没表）时，
        // 直接渲染空区块，而不是甩一个红色 404 在脸上。
        console.error('[apps] 加载失败', e)
        setGroup({ sdk: [], app: [], community: [] })
      })
      .finally(() => setLoading(false))
  }, [])

  const appItems = group?.app ?? []
  const communityItems = group?.community ?? []

  return (
    <div className="container-x py-10">
      <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-pixel text-2xl sm:text-3xl">{t.apps.title}</h1>
          <p className="mt-2 max-w-2xl text-muted">{t.apps.desc}</p>
        </div>
        <Button to="/open" variant="secondary" size="sm" className="shrink-0 self-start">
          <span aria-hidden>🚀</span>
          {t.apps.openPlatform}
        </Button>
      </header>

      <div className="space-y-12">
        <Section title={t.apps.app} loading={loading} items={appItems} showSubmitter={false} />
        <Section
          title={t.apps.community}
          loading={loading}
          items={communityItems}
          showSubmitter
          onMore={() => setSubmitOpen(true)}
        />
      </div>

      {submitOpen && <SubmitModal onClose={() => setSubmitOpen(false)} />}
    </div>
  )
}

function Section({
  title,
  loading,
  items,
  showSubmitter,
  onMore,
}: {
  title: string
  loading: boolean
  items: AppItem[]
  showSubmitter?: boolean
  onMore?: () => void
}) {
  const t = useT()
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-line pb-2">
        <h2 className="text-lg font-bold">{title}</h2>
        {onMore && (
          <button type="button" className={btnPrimary} onClick={onMore}>
            {t.apps.submit}
          </button>
        )}
      </div>

      {loading ? (
        <SkeletonGrid />
      ) : items.length === 0 ? (
        <Empty text={t.apps.empty} />
      ) : (
        <Grid items={items} showSubmitter={showSubmitter} />
      )}
    </section>
  )
}

function Grid({ items, showSubmitter }: { items: AppItem[]; showSubmitter?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <AppCard key={item.id} item={item} showSubmitter={showSubmitter} />
      ))}
    </div>
  )
}

function AppCard({ item, showSubmitter }: { item: AppItem; showSubmitter?: boolean }) {
  const t = useT()
  const href = downloadHref(item)

  return (
    <article className="group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 transition hover:border-brand/30 hover:shadow-sm">
      <div className="flex items-start gap-3">
        <AppIcon icon={item.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
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

      {item.description && (
        <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-muted">{item.description}</p>
      )}

      {showSubmitter && item.submitterName && (
        <p className="text-xs text-dim">by {item.submitterName}</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        {item.updatedAt ? (
          <time className="text-xs text-dim" dateTime={item.updatedAt}>
            {formatDate(item.updatedAt)}
          </time>
        ) : (
          <span />
        )}

        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClasses('primary', 'sm')}
          >
            {t.apps.download}
          </a>
        ) : (
          <span className="inline-flex h-8 items-center rounded-lg border border-line bg-surface-2 px-3 text-xs font-semibold text-muted">
            {t.apps.empty}
          </span>
        )}
      </div>
    </article>
  )
}

function AppIcon({ icon }: { icon: string | null }) {
  if (!icon) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-2xl">
        📦
      </div>
    )
  }
  if (/^https?:\/\//.test(icon) || icon.startsWith('/')) {
    return (
      <img
        src={icon}
        alt=""
        loading="lazy"
        className="h-12 w-12 shrink-0 rounded-xl object-cover"
      />
    )
  }
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-2xl">
      {icon}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-line bg-surface px-4 py-14 text-center">
      <span className="mb-2 text-3xl" aria-hidden>
        📭
      </span>
      <p className="text-sm text-muted">{text}</p>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="h-12 w-12 shrink-0 animate-pulse rounded-xl bg-surface-2" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
              <div className="h-3 w-16 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
          <div className="h-3 w-full animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-surface-2" />
          <div className="mt-auto h-8 w-20 animate-pulse rounded-lg bg-surface-2" />
        </div>
      ))}
    </div>
  )
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

function SubmitModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState('')
  const [description, setDescription] = useState('')
  const [link, setLink] = useState('')
  const [contact, setContact] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setMsg(null)
    try {
      await submitCommunityApp({ name, platform, description, link, contact })
      setMsg({ ok: true, text: t.apps.submitOk })
      setName('')
      setPlatform('')
      setDescription('')
      setLink('')
      setContact('')
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : t.apps.submitFail })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal
      aria-label={t.apps.submitTitle}
    >
      <form
        onSubmit={submit}
        className="max-h-[90dvh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-line bg-surface p-5"
      >
        <h2 className="text-lg font-bold">{t.apps.submitTitle}</h2>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">{t.apps.name}</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">{t.apps.platform}</span>
          <input
            className={inputCls}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            maxLength={40}
            placeholder="Linux / ESP32 / Windows …"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">{t.apps.descLabel}</span>
          <textarea className={inputCls} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} required />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">{t.apps.link}</span>
          <input className={inputCls} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" type="url" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">{t.apps.contact}</span>
          <input className={inputCls} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} />
        </label>

        {msg && <p className={msg.ok ? 'text-sm text-online' : 'text-sm text-live'}>{msg.text}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnSecondary} onClick={onClose} disabled={saving}>
            关闭
          </button>
          <button type="submit" className={btnPrimary} disabled={saving}>
            {saving ? '…' : t.apps.submitBtn}
          </button>
        </div>
      </form>
    </div>
  )
}
