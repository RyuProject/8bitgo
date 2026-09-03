import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { apiEnabled } from '@/services/api'
import { defaultMediaKey, getRomConfig, romUrlForKey, uploadRom } from '@/services/roms'
import { fetchAdminDevelopers, saveDeveloper, deleteDeveloper, type AdminDeveloper } from '@/services/developers'
import { confirmUpload, deleteRomObjects, human, isDeletableKey } from './uploadGuards'
import { Field, btnClass, inputClass } from './ui'

/**
 * 开发商管理。
 *
 * 这一页管的**不是**开发商名单 —— 名单是从 games.developer 那一列 GROUP BY 出来的，
 * 想加一家就去给某款游戏填上它的名字。这里只负责往名单上贴人工资料：
 * 自定义 logo、简介、官网。
 *
 * 所以没有「新建」按钮，也不能改名：名字就是主键，改了就跟游戏里写的对不上，
 * 资料会挂在一个没有任何作品的空名字下面。
 *
 * 默认只显示已经填过资料的那几家 + 搜索结果 —— 一个站几十上百家开发商，
 * 全量铺开的话真正要改的那两行反而找不到。
 */
export function AdminDevelopers() {
  const [list, setList] = useState<AdminDeveloper[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState<AdminDeveloper | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!apiEnabled()) return
    setLoading(true)
    setError('')
    fetchAdminDevelopers()
      .then(setList)
      .catch((e: unknown) => {
        setList([])
        setError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(t)
  }, [toast])

  const customized = useMemo(() => list.filter((d) => d.logo || d.description || d.descriptionEn || d.homepage), [list])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle) return list.filter((d) => d.name.toLowerCase().includes(needle))
    if (showAll) return list
    return customized
  }, [list, q, showAll, customized])

  const remove = async (d: AdminDeveloper) => {
    if (!window.confirm(`清空「${d.name}」的自定义资料？\n\n开发商本身不会消失，列表页会回到用代表作封面。`)) return
    try {
      await deleteDeveloper(d.name)
      setToast('已清空')
      reload()
    } catch (err) {
      setToast(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">开发商管理</h1>
          <p className="mt-1 text-sm text-muted">
            {!apiEnabled()
              ? '未配置后端（VITE_API_URL），后台读不到开发商，也保存不了修改。'
              : error
                ? `⚠️ 取不到开发商列表：${error}`
                : `共 ${list.length} 家，其中 ${customized.length} 家填了自定义资料。`}
          </p>
          <p className="mt-1 text-xs text-dim">
            名单来自游戏的「开发商」字段，这里只贴资料。想新增一家，去
            <Link to="/admin/games" className="mx-1 text-brand-hover hover:underline">
              游戏管理
            </Link>
            给某款游戏填上它的名字。
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索开发商…"
            className={cx(inputClass, 'w-56')}
          />
          <button type="button" className={btnClass.secondary} onClick={() => setShowAll((v) => !v)} disabled={Boolean(q.trim())}>
            {showAll ? '只看已自定义' : `显示全部 ${list.length} 家`}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted">读取中…</p>}

      {!loading && !visible.length && (
        <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          {q.trim() ? '没有匹配的开发商。' : '还没有哪家填过资料。点「显示全部」挑一家开始。'}
        </p>
      )}

      <div className="grid gap-2">
        {visible.map((d) => (
          <Row key={d.name} dev={d} onEdit={() => setEditing(d)} onRemove={() => void remove(d)} />
        ))}
      </div>

      {editing && (
        <EditDialog
          dev={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null)
            setToast(msg)
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

/** 列表里的一行。左边那张图就是前台列表页会看到的那张，所以回退顺序要一模一样 */
function Row({ dev, onEdit, onRemove }: { dev: AdminDeveloper; onEdit: () => void; onRemove: () => void }) {
  const custom = Boolean(dev.logo || dev.description || dev.descriptionEn || dev.homepage)
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
      <Thumb logo={dev.logo} cover={dev.topGame?.cover} icon={dev.topGame?.icon} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate font-semibold">
          {dev.name}
          {dev.logo && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand-hover">自定义 logo</span>}
          {dev.count === 0 && (
            <span
              className="rounded bg-[color:var(--color-coin-soft)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-live)]"
              title="名下已经没有游戏了 —— 多半是游戏里的开发商改了拼写，这行资料成了孤儿，可以清空"
            >
              没有作品
            </span>
          )}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted">
          {dev.count} 款
          {dev.topGame ? ` · 代表作 ${dev.topGame.titleZh || dev.topGame.title}` : ''}
          {dev.description ? ` · ${dev.description}` : ''}
        </p>
      </div>
      <button type="button" className={btnClass.secondary} onClick={onEdit}>
        编辑
      </button>
      {custom && (
        <button type="button" className={btnClass.danger} onClick={onRemove}>
          清空
        </button>
      )}
    </div>
  )
}

/** 前台开发商列表页的显示顺序：自定义 logo → 代表作封面 → emoji 占位 */
function Thumb({ logo, cover, icon }: { logo?: string; cover?: string; icon?: string }) {
  const src = romUrlForKey(logo || cover || '')
  const [broken, setBroken] = useState(false)
  if (!src || broken) {
    return (
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-brand-soft text-xl" aria-hidden>
        {icon || '🏢'}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="h-12 w-12 shrink-0 rounded-lg bg-brand-soft object-cover"
    />
  )
}

function EditDialog({ dev, onClose, onSaved }: { dev: AdminDeveloper; onClose: () => void; onSaved: (msg: string) => void }) {
  const [logo, setLogo] = useState(dev.logo)
  const [description, setDescription] = useState(dev.description)
  const [descriptionEn, setDescriptionEn] = useState(dev.descriptionEn)
  const [homepage, setHomepage] = useState(dev.homepage)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setErr('')
    try {
      await saveDeveloper(dev.name, { logo, description, descriptionEn, homepage })
      onSaved('已保存')
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '保存失败')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal aria-label={`编辑 ${dev.name}`}>
      <form onSubmit={submit} className="max-h-[90dvh] w-full max-w-xl space-y-3 overflow-y-auto rounded-2xl border border-line bg-surface p-5">
        <div>
          <h2 className="text-lg font-bold">{dev.name}</h2>
          <p className="mt-1 text-xs text-dim">
            名字是主键，和游戏里的「开发商」字段一字不差才能对上，所以这里不能改名。
            要改名字请去游戏管理改完，再回来清空这行旧资料。
          </p>
        </div>

        <LogoField name={dev.name} value={logo} fallbackCover={dev.topGame?.cover} onChange={setLogo} />

        <Field label="简介（中文）" hint="选填。填了会显示在开发商列表页">
          <textarea
            className={cx(inputClass, 'h-20 resize-y py-2')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一两句话介绍这家公司"
          />
        </Field>

        <Field label="简介（English）" hint="留空的话，所有非中文语种都会看到上面那段中文">
          <textarea
            className={cx(inputClass, 'h-20 resize-y py-2')}
            value={descriptionEn}
            onChange={(e) => setDescriptionEn(e.target.value)}
            placeholder="One or two sentences about this studio"
          />
        </Field>

        <Field label="官网" hint="选填。必须以 http:// 或 https:// 开头">
          <input className={inputClass} value={homepage} onChange={(e) => setHomepage(e.target.value)} placeholder="https://" />
        </Field>

        {err && <p className="text-xs text-live">{err}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnClass.secondary} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="submit" className={btnClass.primary} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * logo 字段：可手填 key / URL，也可以直接传文件到 R2（走 Worker，同 GameForm 的封面）。
 *
 * key 用开发商名字生成（logos/<名字>.<ext>），换图时复用同一个 key ——
 * 不复用的话 logos/snk.png 和 logos/snk.jpg 会一起留在桶里，谁也不知道哪张在用。
 */
function LogoField({
  name,
  value,
  fallbackCover,
  onChange,
}: {
  name: string
  value: string
  fallbackCover?: string
  onChange: (key: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const cfg = getRomConfig()
  const canUpload = Boolean(cfg.api && cfg.token)
  // 名字里可能有空格、点、中文，直接当文件名会得到很难看也很难查的 key
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'developer'
  const previewUrl = romUrlForKey(value || fallbackCover || '')

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const oldKey = value.trim()
    const key = oldKey && !/^https?:/i.test(oldKey) ? oldKey : defaultMediaKey('logos', slug, file.name)
    setMsg(null)
    if (!(await confirmUpload(key, file))) {
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setProgress(0)
    try {
      const result = await uploadRom(file, key, setProgress)
      onChange(result.key)
      setMsg({ ok: true, text: `已上传：${result.key}（${human(result.size)}）。别忘了点保存。` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '上传失败' })
    } finally {
      setProgress(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const removeLogo = async () => {
    const key = value.trim()
    if (!key) return
    setMsg(null)
    if (!isDeletableKey(key) || !canUpload) {
      onChange('')
      setMsg({ ok: true, text: '已清空，原文件保留' })
      return
    }
    if (!window.confirm(`${key}\n\n从 R2 删除这张 logo？此操作不可恢复。`)) return
    try {
      const { failed } = await deleteRomObjects([key])
      onChange('')
      setMsg({ ok: failed.length === 0, text: failed.length ? '已清空，但 R2 文件删除失败' : '已删除文件并清空' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '删除失败' })
    }
  }

  return (
    <Field label="自定义 logo" hint="1:1 正方形最佳。留空就用代表作封面，可上传或手填 key / URL">
      <div className="flex gap-2">
        <input
          className={cx(inputClass, 'font-mono')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`logos/${slug}.png`}
        />
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <button
          type="button"
          className={cx(btnClass.secondary, 'shrink-0 whitespace-nowrap')}
          disabled={!canUpload || progress !== null}
          onClick={() => inputRef.current?.click()}
          title={canUpload ? '选择图片并上传到 R2' : '需要先配置 Worker'}
        >
          {progress === null ? '☁️ 上传' : `上传中 ${progress}%`}
        </button>
        {value && progress === null && (
          <button type="button" className={cx(btnClass.danger, 'shrink-0')} onClick={() => void removeLogo()}>
            清空
          </button>
        )}
      </div>
      {progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {previewUrl && (
        <div className="mt-2 flex items-center gap-2">
          <div className="aspect-square w-24 overflow-hidden rounded-lg border border-line bg-black">
            <img src={previewUrl} alt="预览" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </div>
          {!value && <span className="text-[11px] text-dim">当前显示的是代表作封面</span>}
        </div>
      )}
      {msg && <p className={cx('mt-2 text-xs', msg.ok ? 'text-online' : 'text-live')}>{msg.text}</p>}
      {!canUpload && (
        <p className="mt-1 text-[11px] text-dim">
          直接上传需先在{' '}
          <Link to="/admin/roms" className="text-brand-hover hover:underline">
            ROM 存储
          </Link>{' '}
          页配置 Worker 地址与口令；也可以手填图片的完整 URL。
        </p>
      )}
    </Field>
  )
}
