import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { CollectionDetail, Game } from '@/types'
import {
  deleteCollection,
  getCollection,
  removeGameFromCollection,
  reorderCollectionGames,
  reportCollectionView,
  setCollectionHidden,
} from '@/services/collections'
import { CollectionFormDialog } from '@/components/game/CollectionFormDialog'
import { CollectionAddGamesDialog } from '@/components/game/CollectionAddGamesDialog'
import { SortableGameGrid } from '@/components/game/SortableGameGrid'
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
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 排序没存上时给一句话；存上了就静默 */
  const [sortError, setSortError] = useState<string | null>(null)
  const saveOrderTimer = useRef(0)

  /**
   * silent=true 时不切骨架屏：已经有数据、只是要和服务端对一下账（关掉「添加游戏」弹窗之后）。
   * 每次都走骨架的话，加完几款一关弹窗整页闪一下，像是把刚加的又弄丢了。
   */
  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true)
      getCollection(id)
        .then((d) => {
          setData(d)
          setMissing(false)
        })
        .catch(() => {
          if (!silent) setMissing(true)
        })
        .finally(() => {
          if (!silent) setLoading(false)
        })
    },
    [id],
  )

  useEffect(() => load(), [load])

  /**
   * 记一次浏览。**每个合集只发一次**，不跟着 `load(true)` 那些静默刷新走 ——
   * 服务端本来就按人去重（重复发也不会多算），这里只是别为「关个弹窗」白发一次请求。
   *
   * 刻意**不**等 load 成功：不存在 / 已下架的合集服务端自己回 404；
   * 挂在数据后面反而多一层依赖，容易在静默刷新时重复触发。
   * 失败一律咽掉 —— 这个数字是装饰性的，不该让页面看起来出了问题。
   */
  const reportedRef = useRef('')
  useEffect(() => {
    if (!id || reportedRef.current === id) return
    reportedRef.current = id
    void reportCollectionView(id).catch(() => {})
  }, [id])

  /**
   * 拖一下 / 按一下方向键就叫一次。本地顺序立刻生效（不然拖起来像卡住），
   * 存盘等 600ms —— 连着挪好几格只发最后那一次，而不是每一格都打一次接口。
   * 存失败就从服务端把真顺序拉回来（silent），并说一句。
   */
  const SAVE_ORDER_DELAY_MS = 600
  const onReorder = (next: Game[]) => {
    setData((prev) => (prev ? { ...prev, games: next } : prev))
    setSortError(null)
    window.clearTimeout(saveOrderTimer.current)
    saveOrderTimer.current = window.setTimeout(() => {
      if (!data) return
      reorderCollectionGames(data.collection.id, next.map((g) => g.slug)).catch(() => {
        setSortError(t.collections.sortFailed)
        load(true)
      })
    }, SAVE_ORDER_DELAY_MS)
  }
  // 离开页面时别让飞着的定时器往一个已经卸载的组件上 setState
  useEffect(() => () => window.clearTimeout(saveOrderTimer.current), [])

  /** 已在合集里的 slug，给「添加游戏」弹窗把那些卡片标成「已加入」 */
  const existingSlugs = useMemo(() => new Set((data?.games ?? []).map((g) => g.slug)), [data?.games])

  /**
   * 弹窗里加了一款：**当场**把它插到最前面、数量 +1，不等接口回来重拉。
   * 弹窗不关、数字在涨，这是参考站那套交互的核心手感；关弹窗时再 silent 拉一次和服务端对齐。
   * added=false 是服务端说「早就在里面了」（另一个标签页先加的）—— 数量别重复加。
   */
  const onAdded = (game: Game, added: boolean) => {
    setData((prev) => {
      if (!prev) return prev
      const rest = prev.games.filter((g) => g.slug !== game.slug)
      const already = rest.length !== prev.games.length
      return {
        ...prev,
        games: [game, ...rest],
        collection: {
          ...prev.collection,
          gameCount: prev.collection.gameCount + (added && !already ? 1 : 0),
        },
      }
    })
  }

  const c = data?.collection
  useSeo({
    title: c ? c.title : t.collections.title,
    /*
      合集自己写了简介就用它；没写就按标题和数量拼一句。
      ⚠️ 以前这里回退到 t.collections.subtitle —— 简体中文只有 11 个字，
      而**大多数合集都没写简介**，于是几乎每个合集详情页都挂着同一句过短的描述
      （Bing Webmaster 2026-09-11 报的「描述过短」）。拼出来的这句既够长也各不相同。
    */
    description:
      c?.description || (c ? fmt(t.seo.collectionDesc, { title: c.title, n: c.gameCount }) : t.seo.collections),
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
      // 已经有数据了，悄悄对账就行，不用整页闪一次骨架
      load(true)
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
              <Button variant="primary" size="sm" onClick={() => setAdding(true)} disabled={busy}>
                ＋ {t.collections.addGames}
              </Button>
            )}
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
        {/*
          浏览量在详情页**即使是 0 也显示** —— 作者会来看自己的合集有没有人光顾，
          「0 人看过」对他是有效信息。卡片上那处相反（0 就不画，见 CollectionCard）。
        */}
        <span title={t.collections.viewCountHint}>{fmt(t.collections.viewCount, { n: String(c.viewCount) })}</span>
      </div>

      {data.games.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          <p>{t.collections.detailEmpty}</p>
          {mine && (
            <Button variant="primary" size="sm" className="mt-4" onClick={() => setAdding(true)} disabled={busy}>
              ＋ {t.collections.addGames}
            </Button>
          )}
        </div>
      ) : (
        <>
          {sortError && <p className="mb-3 text-xs text-live">{sortError}</p>}
          {/* 作者：左上角手柄拖着排（触屏也行、方向键也行），右上角「移出」。别人：普通网格 */}
          <SortableGameGrid
            games={data.games}
            sortable={mine}
            disabled={busy}
            onReorder={onReorder}
            renderActions={(g) =>
              mine ? (
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
              ) : null
            }
          />
        </>
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

      {adding && (
        <CollectionAddGamesDialog
          collection={c}
          existing={existingSlugs}
          onAdded={onAdded}
          onClose={() => {
            setAdding(false)
            // 乐观更新过了，这里只是悄悄和服务端对一下顺序 / 封面，不闪骨架
            load(true)
          }}
        />
      )}
    </div>
  )
}
