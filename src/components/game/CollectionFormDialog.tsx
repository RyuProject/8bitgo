import { useState } from 'react'
import type { Collection } from '@/types'
import { createCollection, updateCollection, KIND_SUGGESTIONS } from '@/services/collections'
import { Button } from '@/components/ui/Button'
import { useT } from '@/services/i18n'
import { cx } from '@/lib/format'

interface Props {
  /** 传了就是编辑，不传就是新建 */
  collection?: Collection
  onClose: () => void
  onSaved: (c: Collection) => void
}

const input =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand'

/**
 * 新建 / 编辑合集的弹窗。
 *
 * 「类型」是**自由输入**，下面那排只是一键填入的建议 —— 产品上这一格就叫「可自定义」，
 * 做成下拉会把「小时候的暑假」这种合理的类型挡在外面。建议的意义只是让常见写法收敛一点。
 */
export function CollectionFormDialog({ collection, onClose, onSaved }: Props) {
  const t = useT()
  const [title, setTitle] = useState(collection?.title ?? '')
  const [kind, setKind] = useState(collection?.kind ?? '')
  const [description, setDescription] = useState(collection?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const clean = title.trim()
    if (!clean) return setError(t.collections.titleRequired)
    setBusy(true)
    setError(null)
    try {
      const saved = collection
        ? await updateCollection(collection.id, { title: clean, kind, description })
        : await createCollection({ title: clean, kind, description })
      onSaved(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.collections.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    // z-[80] 和登录弹窗同层：这两个不会同时出现（没登录点新建会先弹登录）
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <h2 className="text-lg font-bold">{collection ? t.collections.editTitle : t.collections.create}</h2>

        <label className="mt-4 block">
          <span className="text-xs font-semibold text-muted">{t.collections.fieldTitle}</span>
          <input className={cx(input, 'mt-1')} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>

        <label className="mt-3 block">
          <span className="text-xs font-semibold text-muted">{t.collections.fieldKind}</span>
          <input className={cx(input, 'mt-1')} value={kind} maxLength={30} onChange={(e) => setKind(e.target.value)} />
        </label>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {KIND_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setKind(s)}
              className={cx(
                'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                kind === s ? 'border-brand bg-brand-soft text-brand-hover' : 'border-line text-muted hover:border-brand',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-dim">{t.collections.fieldKindHint}</p>

        <label className="mt-3 block">
          <span className="text-xs font-semibold text-muted">{t.collections.fieldDesc}</span>
          <textarea
            className={cx(input, 'mt-1 h-20 resize-none')}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {error && <p className="mt-3 text-xs text-live">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t.collections.cancel}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {t.collections.save}
          </Button>
        </div>
      </div>
    </div>
  )
}
