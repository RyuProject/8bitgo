import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Collection } from '@/types'
import { listCollections } from '@/services/collections'
import { CollectionCard } from '@/components/game/CollectionCard'
import { CollectionFormDialog } from '@/components/game/CollectionFormDialog'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Pagination } from '@/components/ui/Pagination'
import { Button } from '@/components/ui/Button'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'
import { useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'

const PAGE_SIZE = 24

/**
 * /collections —— 全站合集列表。
 *
 * 和平台页 / 类型页（CollectionPage.tsx，名字撞了但那是另一回事：那边是
 * 「NES 游戏」「射击游戏」这种 SEO 落地页）没有关系，这里是**用户自己建的**清单。
 */
export function CollectionsPage() {
  const t = useT()
  const user = useCurrentUser()
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number(params.get('page')) || 1)

  const [items, setItems] = useState<Collection[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    listCollections(page, PAGE_SIZE)
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [page])

  useEffect(load, [load])

  useSeo({
    title: t.collections.title,
    /*
      ⚠️ 别用 t.collections.subtitle 当描述：那句是页面上那行小标题（简体中文只有 11 个字），
      Bing Webmaster 2026-09-11 报「Meta descriptions … are too short」就是这儿。
      SEO 描述和界面文案是两件事，各写各的。
    */
    description: t.seo.collections,
    canonicalPath: page > 1 ? `/collections?page=${page}` : '/collections',
  })

  return (
    <div className="container-x py-6 sm:py-8">
      <SectionHeader
        title={t.collections.title}
        subtitle={t.collections.subtitle}
        icon="📚"
        as="h1"
        actions={
          <Button
            size="sm"
            onClick={() => (user ? setCreating(true) : openAuthModal())}
          >
            ＋ {t.collections.create}
          </Button>
        }
      />

      {error && <p className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-live">{error}</p>}

      {/* 骨架用和真卡片同样的格子，数据回来时不会整页跳动 */}
      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-card border border-line bg-surface">
              <div className="aspect-square w-full animate-pulse bg-surface-2" />
              <div className="space-y-2 p-3">
                <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          {t.collections.empty}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((c, i) => (
            <CollectionCard key={c.id} collection={c} priority={i < 4} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <Pagination
          page={page}
          totalPages={Math.ceil(total / PAGE_SIZE)}
          onChange={(next) => {
            const p = new URLSearchParams(params)
            if (next <= 1) p.delete('page')
            else p.set('page', String(next))
            setParams(p)
          }}
          hrefFor={(next) => (next > 1 ? `/collections?page=${next}` : '/collections')}
        />
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
    </div>
  )
}
