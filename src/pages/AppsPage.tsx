import { useEffect, useState, type FormEvent } from 'react'
import { useT } from '@/services/i18n'
import { useSeo } from '@/services/seo'
import { apiEnabled } from '@/services/api'
import { fetchApps, submitCommunityApp, type AppItem, type AppsGroup } from '@/services/apps'
import { romUrlForKey } from '@/services/roms'

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
  const [error, setError] = useState('')
  const [submitOpen, setSubmitOpen] = useState(false)

  useSeo({ title: t.apps.title, description: t.apps.desc })

  useEffect(() => {
    if (!apiEnabled()) return
    setError('')
    fetchApps()
      .then(setGroup)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'))
  }, [])

  return (
    <div className="container-x py-10">
      <header className="mb-8">
        <h1 className="text-pixel text-2xl">{t.apps.title}</h1>
        <p className="mt-2 max-w-2xl text-muted">{t.apps.desc}</p>
      </header>

      {error && <p className="mb-6 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-live">{error}</p>}

      <Section title={t.apps.sdk} desc={t.apps.desc}>
        <Grid items={group?.sdk ?? []} empty={t.apps.empty} loading={group === null} />
      </Section>

      <Section title={t.apps.app} desc={t.apps.desc}>
        <Grid items={group?.app ?? []} empty={t.apps.empty} loading={group === null} />
      </Section>

      <Section
        title={t.apps.community}
        desc={t.apps.desc}
        action={
          <button type="button" className={btnPrimary} onClick={() => setSubmitOpen(true)}>
            {t.apps.submit}
          </button>
        }
      >
        <Grid items={group?.community ?? []} empty={t.apps.empty} loading={group === null} showSubmitter />
      </Section>

      {submitOpen && <SubmitModal onClose={() => setSubmitOpen(false)} />}
    </div>
  )
}

function Section({
  title,
  desc,
  action,
  children,
}: {
  title: string
  desc: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          <p className="mt-1 text-sm text-muted">{desc}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Grid({
  items,
  empty,
  loading,
  showSubmitter,
}: {
  items: AppItem[]
  empty: string
  loading: boolean
  showSubmitter?: boolean
}) {
  const t = useT()
  if (loading) return <p className="text-sm text-muted">…</p>
  if (!items.length)
    return <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{empty}</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        const href = downloadHref(item)
        return (
          <div key={item.id} className="flex flex-col rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold">{item.name}</h3>
              {item.platform && (
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{item.platform}</span>
              )}
            </div>
            {item.version && <p className="mt-0.5 text-xs text-muted">v{item.version}</p>}
            {item.description && <p className="mt-2 flex-1 text-sm text-muted">{item.description}</p>}
            {showSubmitter && item.submitterName && <p className="mt-2 text-xs text-dim">by {item.submitterName}</p>}
            {href ? (
              <a href={href} target="_blank" rel="noreferrer noopener" className={`${btnPrimary} mt-3`}>
                {t.apps.download}
              </a>
            ) : (
              <span className="mt-3 text-xs text-dim">{t.apps.empty}</span>
            )}
          </div>
        )
      })}
    </div>
  )
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
