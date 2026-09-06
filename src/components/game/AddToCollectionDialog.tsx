import { useEffect, useState } from 'react'
import type { Collection } from '@/types'
import { addGameToCollection, myCollections } from '@/services/collections'
import { CollectionFormDialog } from './CollectionFormDialog'
import { Button } from '@/components/ui/Button'
import { useT, fmt } from '@/services/i18n'
import { cx } from '@/lib/format'

interface Props {
  gameSlug: string
  onClose: () => void
}

/**
 * 「把这款游戏加进哪个合集」。
 *
 * 一个合集都没有时直接显示新建表单 —— 让玩家先关掉这个弹窗、去别处建一个再回来加，
 * 是把我们的数据结构当成他的操作步骤。
 */
export function AddToCollectionDialog({ gameSlug, onClose }: Props) {
  const t = useT()
  const [list, setList] = useState<Collection[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  /** 这一次弹窗里已经加进去的合集，用来把按钮换成「已加入」 */
  const [done, setDone] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    myCollections()
      .then((r) => setList(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    void load()
  }, [])

  // 一个都没有：直接进新建，省掉一次「先关掉再去建」的往返
  useEffect(() => {
    if (list && list.length === 0) setCreating(true)
  }, [list])

  const add = async (c: Collection) => {
    setBusyId(c.id)
    setError(null)
    try {
      await addGameToCollection(c.id, gameSlug)
      setDone((prev) => new Set(prev).add(c.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : t.collections.saveFailed)
    } finally {
      setBusyId(null)
    }
  }

  if (creating) {
    return (
      <CollectionFormDialog
        onClose={() => (list && list.length === 0 ? onClose() : setCreating(false))}
        onSaved={async (c) => {
          setCreating(false)
          // 新建之后顺手把这款游戏放进去 —— 玩家点「加入合集」的意图就是这个
          await add(c)
          await load()
        }}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <h2 className="text-lg font-bold">{t.collections.addToTitle}</h2>

        {error && <p className="mt-3 text-xs text-live">{error}</p>}

        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
          {list === null ? (
            <div className="h-10 animate-pulse rounded-lg bg-surface-2" />
          ) : (
            list.map((c) => {
              const added = done.has(c.id)
              return (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{c.title}</span>
                    <span className="block text-[11px] text-muted">
                      {fmt(t.collections.gameCount, { n: String(c.gameCount) })}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant={added ? 'primary' : 'secondary'}
                    disabled={added || busyId === c.id}
                    onClick={() => void add(c)}
                    className={cx('shrink-0')}
                  >
                    {added ? t.collections.added : t.collections.addTo}
                  </Button>
                </div>
              )
            })
          )}
        </div>

        <div className="mt-5 flex justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            ＋ {t.collections.create}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t.collections.cancel}
          </Button>
        </div>
      </div>
    </div>
  )
}
