import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Collection } from '@/types'
import { deleteCollection, myCollections } from '@/services/collections'
import { CollectionCard } from '@/components/game/CollectionCard'
import { CollectionFormDialog } from '@/components/game/CollectionFormDialog'
import { Button } from '@/components/ui/Button'
import { useT } from '@/services/i18n'

/** 个人中心的「我的合集」分栏：建、改、删都在这儿 */
export function MyCollections() {
  const t = useT()
  const [items, setItems] = useState<Collection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Collection | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    myCollections()
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(load, [load])

  const remove = async (c: Collection) => {
    if (!window.confirm(t.collections.deleteConfirm)) return
    setBusy(true)
    try {
      await deleteCollection(c.id)
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{t.collections.mine}</h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          ＋ {t.collections.create}
        </Button>
      </div>

      {error && <p className="text-sm text-live">{error}</p>}

      {items === null ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-card bg-surface-2" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          {t.collections.mineEmpty}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((c) => (
            <div key={c.id} className="space-y-1.5">
              <CollectionCard collection={c} />
              {/* 管理动作放卡片外面：卡片整体是个 <Link>，把按钮塞进去会变成
                  「点编辑却跳到详情页」——嵌套可点区域是老问题了 */}
              <div className="flex items-center justify-between gap-2 px-0.5">
                <Link to={`/collections/${c.id}`} className="truncate text-[11px] text-muted hover:text-fg">
                  {c.kind || ' '}
                </Link>
                <span className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                    onClick={() => setEditing(c)}
                    disabled={busy}
                  >
                    {t.collections.editTitle}
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-muted underline-offset-2 hover:text-live hover:underline"
                    onClick={() => void remove(c)}
                    disabled={busy}
                  >
                    {t.collections.delete}
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <CollectionFormDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            load()
          }}
        />
      )}
      {editing && (
        <CollectionFormDialog
          collection={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}
