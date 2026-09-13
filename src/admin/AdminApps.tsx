/**
 * 应用中心后台。官方 SDK / APP 下载 / 社区上架共用一张表，
 * 靠 `kind` 区分；这里不分开，统一增删改，由列表里的类型标签告诉管理员是哪一类。
 *
 * 下载地址两种录入方式（二选一）：
 *   · 直接在「下载链接」里贴外链；
 *   · 点「上传安装包」把文件传 R2，组件把返回的 key 存进 downloadUrl，
 *     前台会拼成可下载地址。两种方式都进同一列。
 *
 * 结构照搬 AdminFriendLinks：加载 → 列表 → 弹窗表单 → 保存 / 删除。
 */
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/services/i18n'
import { apiEnabled } from '@/services/api'
import { getRomConfig, romUrlForKey, uploadRom } from '@/services/roms'
import { deleteApp, fetchAdminApps, saveApp, type AppInput, type AppItem, type AppKind } from '@/services/apps'
import { Field, inputClass } from './ui'

const KINDS: { value: AppKind; label: string }[] = [
  { value: 'sdk', label: '官方 SDK' },
  { value: 'app', label: 'APP 下载' },
  { value: 'community', label: '社区上架' },
]

export function AdminApps() {
  const t = useT()
  const [items, setItems] = useState<AppItem[] | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<AppItem | null>(null)
  const [form, setForm] = useState<AppInput>(blankForm())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = () => {
    if (!apiEnabled()) return setItems([])
    setError('')
    fetchAdminApps()
      .then((d) => setItems(d.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'))
  }

  useEffect(reload, [])

  const openCreate = () => {
    setEditing(null)
    setForm(blankForm())
    setShowForm(true)
  }

  const openEdit = (app: AppItem) => {
    setEditing(app)
    setForm({
      kind: app.kind as AppKind,
      name: app.name,
      platform: app.platform,
      version: app.version ?? '',
      description: app.description ?? '',
      downloadUrl: app.downloadUrl ?? '',
      icon: app.icon ?? '',
      sortOrder: 0,
      published: true,
      submitterName: app.submitterName ?? '',
    })
    setShowForm(true)
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await saveApp(editing ? editing.id : null, form)
      setShowForm(false)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (app: AppItem) => {
    if (!confirm(`删除「${app.name}」？`)) return
    setError('')
    try {
      await deleteApp(app.id)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!getRomConfig()) {
      setError('站点未配置 ROM 存储，无法上传安装包（可改用下载链接）')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await uploadRom(file, `apps/${Date.now()}/${file.name}`)
      setForm((f) => ({ ...f, downloadUrl: res.key }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  const previewUrl = form.downloadUrl ? (/^https?:\/\//i.test(form.downloadUrl) ? form.downloadUrl : romUrlForKey(form.downloadUrl)) : ''

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{t.apps.adminTitle}</h1>
        <button className="btn-primary" onClick={openCreate}>
          {t.apps.add}
        </button>
      </div>

      {error && <p className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-live">{error}</p>}

      {items === null ? (
        <p className="text-sm text-muted">…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t.apps.empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-3 py-2">{t.apps.kind}</th>
                <th className="px-3 py-2">{t.apps.name}</th>
                <th className="px-3 py-2">{t.apps.platform}</th>
                <th className="px-3 py-2">{t.apps.download}</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((app) => (
                <tr key={app.id} className="border-t border-line">
                  <td className="px-3 py-2">{KINDS.find((k) => k.value === app.kind)?.label ?? app.kind}</td>
                  <td className="px-3 py-2">{app.name}</td>
                  <td className="px-3 py-2 text-muted">{app.platform || '—'}</td>
                  <td className="px-3 py-2 text-muted">
                    {app.downloadUrl ? (
                      <a className="text-accent underline" href={/^https?:\/\//i.test(app.downloadUrl) ? app.downloadUrl : romUrlForKey(app.downloadUrl) || '#'} target="_blank" rel="noreferrer noopener">
                        {t.apps.download}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="text-accent underline" onClick={() => openEdit(app)} disabled={busy}>
                      编辑
                    </button>{' '}
                    <button className="text-live underline" onClick={() => remove(app)} disabled={busy}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal>
          <div className="max-h-[90dvh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-lg font-bold">{editing ? '编辑应用' : t.apps.add}</h2>

            <Field label={t.apps.kind}>
              <select
                className={inputClass}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as AppKind })}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t.apps.name}>
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
            </Field>

            <Field label={t.apps.platform}>
              <input
                className={inputClass}
                value={form.platform ?? ''}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
                maxLength={40}
                placeholder="Linux / ESP32 / Windows …"
              />
            </Field>

            <Field label={t.apps.version}>
              <input className={inputClass} value={form.version ?? ''} onChange={(e) => setForm({ ...form, version: e.target.value })} maxLength={40} placeholder="v1.0.0（可选）" />
            </Field>

            <Field label={t.apps.descLabel}>
              <textarea className={inputClass} rows={3} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={4000} />
            </Field>

            <Field label={t.apps.linkOrPackage}>
              <div className="space-y-2">
                <input className={inputClass} value={form.downloadUrl ?? ''} onChange={(e) => setForm({ ...form, downloadUrl: e.target.value })} placeholder="https://…（外链）" />
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy || !getRomConfig()}>
                    {t.apps.uploadPackage}
                  </button>
                  <input ref={fileRef} type="file" className="hidden" onChange={onPickFile} />
                  {previewUrl && (
                    <a className="truncate text-xs text-accent underline" href={previewUrl} target="_blank" rel="noreferrer noopener">
                      {previewUrl}
                    </a>
                  )}
                </div>
              </div>
            </Field>

            <Field label={t.apps.sortOrder}>
              <input
                type="number"
                className={inputClass}
                value={form.sortOrder ?? 0}
                onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!form.published} onChange={(e) => setForm({ ...form, published: e.target.checked })} />
              {t.apps.published}
            </label>

            {form.kind === 'community' && (
              <Field label="提交人（可选）">
                <input className={inputClass} value={form.submitterName ?? ''} onChange={(e) => setForm({ ...form, submitterName: e.target.value })} maxLength={80} />
              </Field>
            )}

            {error && <p className="text-sm text-live">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button className="btn-secondary" onClick={() => setShowForm(false)} disabled={busy}>
                关闭
              </button>
              <button className="btn-primary" onClick={save} disabled={busy}>
                {busy ? '…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function blankForm(): AppInput {
  return { kind: 'sdk', name: '', platform: '', version: '', description: '', downloadUrl: '', icon: '', sortOrder: 0, published: true }
}
