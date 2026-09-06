import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { CollectionDetail } from '@/types'
import { deleteCollection, getCollection, removeGameFromCollection, setCollectionHidden } from '@/services/collections'
import { CollectionFormDialog } from '@/components/game/CollectionFormDialog'
import { GameCard } from '@/components/game/GameCard'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { GameGridSkeleton } from '@/components/ui/PageSkeleton'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { NotFoundPage } from './NotFoundPage'

/** /collections/:id —— 一个合集里的全部游戏 */
export function CollectionDetailPage() {
  const { id = '' } = useParams()
  const t = useT()
  const navigate = useNavigate()
  const [data, setData] = useState<CollectionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getCollection(id)
      .then((d) => {
        setData(d)
        setMissing(false)
      })
      .catch(() => setMissing(true))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(load, [load])

  const c = data?.collection
  useSeo({
    title: c ? c.title : t.collections.title,
    description: c?.description || t.collections.subtitle,
    canonicalPath: `/collections/${id}`,
    // 下架的合集不该被收录
    noindex: Boolean(c?.hidden),
  })

  if (missing) return <NotFoundPage />

  if (loading || !c) {
    return (
      <div className="container-x py-6 sm:py-8">
        <div className="mb-4 h-8 w-1/3 animate-pulse rounded bg-surface-2" />
        <GameGridSkeleton />
      </div>
    )
  }

  const mine = Boolean(c.mine)

  const removeGame = async (slug: string) => {
    if (!window.confirm(t.collections.removeConfirm)) return
    setBusy(true)
    try {
      await removeGameFromCollection(c.id, slug)
      load()
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (!window.confirm(t.collections.deleteConfirm)) return
    setBusy(true)
    try {
      await deleteCollection(c.id)
      navigate('/collections')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container-x py-6 sm:py-8">
      <nav className="mb-4 text-xs text-muted" aria-label={t.common.breadcrumb}>
        <Link to="/" className="hover:text-fg">
          {t.common.home}
        </Link>
        <span className="mx-1.5">/</span>
        <Link to="/collections" className="hover:text-fg">
          {t.collections.title}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-fg">{c.title}</span>
      </nav>

      {c.hidden && (
        <p className="mb-4 rounded-card border border-coin/50 bg-coin/10 px-4 py-2 text-xs text-fg">
          {t.collections.hiddenNotice}
        </p>
      )}

      <SectionHeader
        title={c.title}
        as="h1"
        icon="📚"
        subtitle={c.description || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {mine && (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={busy}>
                {t.collections.editTitle}
              </Button>
            )}
            {/* 删除：作者本人，或有审核权的管理员（服务端会再校验一次） */}
            {(mine || data.canReview) && (
              <Button variant="danger" size="sm" onClick={() => void doDelete()} disabled={busy}>
                {t.collections.delete}
              </Button>
            )}
            {data.canReview && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await setCollectionHidden(c.id, !c.hidden)
                    load()
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {c.hidden ? t.collections.unhide : t.collections.hide}
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full bg-surface-2">
            {c.author.avatar}
          </span>
          {c.author.nickname}
        </span>
        {c.kind && <Badge tone="brand">{c.kind}</Badge>}
        <span>{fmt(t.collections.gameCount, { n: String(c.gameCount) })}</span>
      </div>

      {data.games.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          {t.collections.detailEmpty}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data.games.map((g) => (
            <div key={g.slug} className="relative">
              <GameCard game={g} />
              {/* 只有作者能移除。按钮压在卡片右上角，别挤进卡片内部把布局撑歪 */}
              {mine && (
                <button
                  type="button"
                  onClick={() => void removeGame(g.slug)}
                  disabled={busy}
                  title={t.collections.removeGame}
                  aria-label={t.collections.removeGame}
                  className="absolute right-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-full border border-white/25 bg-black/60 text-white/90 backdrop-blur transition hover:bg-live disabled:opacity-40"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CollectionFormDialog
          collection={c}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            load()
          }}
        />
      )}
    </div>
  )
}
