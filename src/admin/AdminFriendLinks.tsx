import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { apiEnabled } from '@/services/api'
import {
  deleteFriendLink,
  fetchFriendLinks,
  type FriendLinkAdmin,
  saveFriendLink,
  type FriendLink,
  type FriendLinkInput,
} from '@/services/friendLinks'
import { defaultMediaKey, getRomConfig, romUrlForKey, uploadRom } from '@/services/roms'
import { confirmUpload, human } from './uploadGuards'
import { Field, btnClass, inputClass } from './ui'

const EMPTY: FriendLinkInput = { name: '', url: '', image: '', sortOrder: 0, enabled: true }

export function AdminFriendLinks() {
  const [links, setLinks] = useState<FriendLinkAdmin[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<FriendLink | null | 'new'>(null)
  const [toast, setToast] = useState('')

  /** 列表上那两个数字统计的是最近多少天。0 = 后端还没给（旧版后端），那就不画这两列 */
  const [statsDays, setStatsDays] = useState(0)

  const reload = useCallback(() => {
    if (!apiEnabled()) return
    setLoading(true)
    setError('')
    fetchFriendLinks()
      .then((r) => {
        setLinks(r.links)
        setStatsDays(r.statsDays)
      })
      .catch((e: unknown) => {
        setLinks([])
        setStatsDays(0)
        setError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2500)
    return () => window.clearTimeout(timer)
  }, [toast])

  const remove = async (link: FriendLink) => {
    if (!window.confirm(`删除友情链接「${link.name}」？\n\n只删除这条记录，已上传的图片会保留在 R2。`)) return
    try {
      await deleteFriendLink(link.id)
      setToast('已删除')
      reload()
    } catch (e) {
      setToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">友情链接</h1>
          <p className="mt-1 text-sm text-muted">
            首页“特别鸣谢”会按排序号展示已启用的条目；图片统一以 88×31 像素为展示基准。
          </p>
          {error && <p className="mt-1 text-xs text-live">读取失败：{error}</p>}
        </div>
        <button type="button" className={btnClass.primary} onClick={() => setEditing('new')} disabled={!apiEnabled()}>
          新增友情链接
        </button>
      </div>

      {loading && <p className="text-sm text-muted">读取中…</p>}
      {!loading && !links.length && (
        <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          {apiEnabled() ? '还没有友情链接。新增第一条后，“特别鸣谢”才会出现在首页。' : '未配置后端，暂时无法管理友情链接。'}
        </p>
      )}

      <div className="grid gap-2">
        {links.map((link) => (
          <div key={link.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
            <LinkPreview link={link} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                <span className="truncate">{link.name}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{link.image ? '图片' : '文字'}</span>
                {!link.enabled && <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-dim">已停用</span>}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted" title={link.url}>
                排序 {link.sortOrder} · {link.url}
              </p>
            </div>
            {statsDays > 0 && <HitStats hits={link.hits} days={statsDays} />}
            <button type="button" className={btnClass.secondary} onClick={() => setEditing(link)}>编辑</button>
            <button type="button" className={btnClass.danger} onClick={() => void remove(link)}>删除</button>
          </div>
        ))}
      </div>

      {editing && (
        <EditDialog
          link={editing === 'new' ? null : editing}
          nextOrder={links.length ? Math.max(...links.map((item) => item.sortOrder)) + 10 : 0}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null)
            setToast(created ? '已新增' : '已保存')
            reload()
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-fg px-4 py-2 text-sm text-bg shadow-lg">{toast}</div>
      )}
    </div>
  )
}

/**
 * 两个方向的人数。**必须把「最近 N 天」写出来**：光写「带出 12」的话，
 * 12 是今天的、这个月的、还是开站以来的，看的人无从判断 —— 那种数字比没有更糟。
 *
 * 「带出 / 带入」而不是「点击 / 访问」：记的是**人**不是次
 * （每人每天每条链接每个方向只算一次，见 server/src/friend-link-hits.js），
 * 用「点击」这个词会让人以为是原始点击量。
 */
function HitStats({ hits, days }: { hits: FriendLinkAdmin['hits']; days: number }) {
  return (
    <div className="shrink-0 text-right text-xs leading-tight" title={`最近 ${days} 天，按人去重（同一个人一天只算一次）`}>
      <p className="text-muted">带出 <b className="text-fg">{hits.out}</b></p>
      <p className="text-muted">带入 <b className="text-fg">{hits.in}</b></p>
      <p className="mt-0.5 text-[10px] text-dim">近 {days} 天 · 按人</p>
    </div>
  )
}

function LinkPreview({ link }: { link: Pick<FriendLink, 'name' | 'image'> }) {
  // romUrlForKey('') 在配置了资源域名时会得到资源根地址，空图片必须先拦住，
  // 否则文字友链会误把 assets.8bitgo.com 首页当图片加载。
  const src = link.image ? romUrlForKey(link.image) : ''
  return (
    <div className={cx('grid h-[31px] w-[88px] shrink-0 place-items-center overflow-hidden rounded-[3px]', !src && 'border border-line bg-surface-2')}>
      {src ? (
        <img src={src} alt="" className="h-[31px] w-[88px] object-contain" loading="lazy" decoding="async" />
      ) : (
        <span className="w-full truncate px-2 text-center text-[11px] font-semibold">{link.name || '文字预览'}</span>
      )}
    </div>
  )
}

function EditDialog({
  link,
  nextOrder,
  onClose,
  onSaved,
}: {
  link: FriendLink | null
  nextOrder: number
  onClose: () => void
  onSaved: (created: boolean) => void
}) {
  const [value, setValue] = useState<FriendLinkInput>(() =>
    link
      ? { name: link.name, url: link.url, image: link.image, sortOrder: link.sortOrder, enabled: link.enabled }
      : { ...EMPTY, sortOrder: nextOrder },
  )
  const [mode, setMode] = useState<'image' | 'text'>(() => (link?.image ? 'image' : 'text'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const update = <K extends keyof FriendLinkInput>(key: K, next: FriendLinkInput[K]) => {
    setValue((old) => ({ ...old, [key]: next }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await saveFriendLink(link?.id ?? null, { ...value, image: mode === 'image' ? value.image.trim() : '' })
      onSaved(!link)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal aria-label={link ? `编辑 ${link.name}` : '新增友情链接'}>
      <form onSubmit={submit} className="max-h-[90dvh] w-full max-w-xl space-y-4 overflow-y-auto rounded-2xl border border-line bg-surface p-5">
        <div>
          <h2 className="text-lg font-bold">{link ? '编辑友情链接' : '新增友情链接'}</h2>
          <p className="mt-1 text-xs text-dim">图片和文字共用一个 88×31 展示位；图片建议直接使用 88×31，等比例高清图也可以。</p>
        </div>

        <Field label="名称" hint="必填。图片加载失败时也会用它作为文字回退">
          <input className={inputClass} value={value.name} onChange={(e) => update('name', e.target.value)} maxLength={80} required />
        </Field>

        <Field label="跳转链接" hint="必填，必须以 http:// 或 https:// 开头">
          <input className={inputClass} value={value.url} onChange={(e) => update('url', e.target.value)} placeholder="https://" type="url" required />
        </Field>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-muted">展示形式</legend>
          <div className="flex gap-2">
            {(['image', 'text'] as const).map((item) => (
              <label key={item} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', mode === item ? 'border-brand bg-brand-soft' : 'border-line bg-surface-2')}>
                <input type="radio" name="mode" value={item} checked={mode === item} onChange={() => setMode(item)} />
                {item === 'image' ? '图片 88×31' : '文字'}
              </label>
            ))}
          </div>
        </fieldset>

        {mode === 'image' && <ImageField name={value.name} value={value.image} onChange={(image) => update('image', image)} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="排序号" hint="数字越小越靠前；建议每次间隔 10">
            <input
              className={inputClass}
              type="number"
              min={0}
              max={65535}
              step={1}
              value={value.sortOrder}
              onChange={(e) => update('sortOrder', Number(e.target.value))}
            />
          </Field>
          <label className="flex items-center gap-2 self-center rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
            <input type="checkbox" checked={value.enabled} onChange={(e) => update('enabled', e.target.checked)} />
            在首页启用
          </label>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-muted">首页预览</p>
          <LinkPreview link={{ name: value.name, image: mode === 'image' ? value.image : '' }} />
        </div>

        {error && <p className="text-xs text-live">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnClass.secondary} onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className={btnClass.primary} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  )
}

function ImageField({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const config = getRomConfig()
  const canUpload = Boolean(config.api && config.token)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'friend-link'

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setMessage(null)
    const size = await imageSize(file)
    if (size && Math.abs(size.width / size.height - 88 / 31) > 0.02) {
      const keep = window.confirm(`这张图是 ${size.width}×${size.height}，不是 88×31 的等比例图片。\n首页会缩放进 88×31 的范围并留白，仍然上传吗？`)
      if (!keep) {
        if (inputRef.current) inputRef.current.value = ''
        return
      }
    }
    const oldKey = value.trim()
    const key = oldKey && !/^https?:/i.test(oldKey) ? oldKey : defaultMediaKey('friend-links', slug, file.name)
    if (!(await confirmUpload(key, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setProgress(0)
    try {
      const result = await uploadRom(file, key, setProgress)
      onChange(result.key)
      setMessage({ ok: true, text: `已上传：${result.key}（${human(result.size)}）。别忘了点保存。` })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : '上传失败' })
    } finally {
      setProgress(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <Field label="图片" hint="建议 88×31；也接受 176×62 等同一比例的高清图。可上传，或手填 R2 key / 完整 URL">
      <div className="flex gap-2">
        <input className={cx(inputClass, 'font-mono')} value={value} onChange={(e) => onChange(e.target.value)} placeholder={`friend-links/${slug}.gif`} />
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0')}
          disabled={!canUpload || progress !== null}
          onClick={() => inputRef.current?.click()}
          title={canUpload ? '选择图片并上传到 R2' : '需要先配置 Worker'}
        >
          {progress === null ? '上传' : `${progress}%`}
        </button>
      </div>
      {progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {message && <p className={cx('mt-2 text-xs', message.ok ? 'text-online' : 'text-live')}>{message.text}</p>}
      {!canUpload && (
        <p className="mt-1 text-[11px] text-dim">
          直接上传需先在 <Link to="/admin/roms" className="text-brand-hover hover:underline">ROM 存储</Link> 页配置 Worker；也可以手填图片 URL。
        </p>
      )}
    </Field>
  )
}

async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    // SVG 或旧浏览器可能读不到尺寸，不为了这一项预检查挡住上传；首页仍会用 object-contain 防变形。
    return null
  }
}
