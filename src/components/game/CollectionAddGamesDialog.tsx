import { useEffect, useRef, useState } from 'react'
import type { Collection, Game } from '@/types'
import { platformMap } from '@/data/platforms'
import { addGameToCollection, searchGamesForCollection } from '@/services/collections'
import { GameCover } from './GameCover'
import { Button } from '@/components/ui/Button'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { gameTitle } from '@/services/i18nData'
import { cx } from '@/lib/format'

interface Props {
  collection: Collection
  /** 已经在合集里的游戏 slug：这些卡片直接显示「已加入」，别让人加第二次再靠服务端幂等兜 */
  existing: ReadonlySet<string>
  /** 每成功加一款就叫一次。added=false 是服务端说「早就在里面了」（另一个标签页先加的）*/
  onAdded: (game: Game, added: boolean) => void
  onClose: () => void
}

/** 敲字之后等这么久再搜。太短每个字都打一次接口，太长会觉得卡；回车 / 点按钮不等 */
const DEBOUNCE_MS = 350

/**
 * 「往合集里添加游戏」——从合集这一侧出发的加法。
 *
 * 原来加游戏只有一条路：打开某款游戏的详情页 → 「加入合集」→ 选合集。整理一个「拳皇系列」
 * 要在十几个游戏页之间来回跳。参考站（ggemu）的做法是在合集页上直接开一个搜索弹窗、
 * 搜到就加，弹窗不关、数量当场涨 —— 这里照这个交互做。
 *
 * 结果卡片刻意**不是** GameCard：那个整张是 <Link>，点一下就离开合集页了。
 * 这里的卡片没有链接，只有一颗「添加」。
 */
export function CollectionAddGamesDialog({ collection, existing, onAdded, onClose }: Props) {
  const t = useT()
  const lang = useLang()
  const [q, setQ] = useState('')
  /** 当前这批结果是按哪个词搜的。「加载更多」要接着它翻页，而不是接着输入框里还没搜的新词 */
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<Game[] | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  /** 这次弹窗里加进去的。和 existing 合起来决定按钮显示「已加入」 */
  const [added, setAdded] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  /** 请求序号：慢的旧请求回来时不能盖掉新的结果（连着敲字最容易出这个） */
  const seq = useRef(0)
  const debounce = useRef(0)
  /**
   * onClose 走 ref：父组件每次重渲染都会传一个新函数进来（加一款游戏父组件就渲染一次），
   * 直接放进 effect 依赖里，每加一款就会把「卸载清理」跑一遍 —— 飞着的搜索请求被作废、
   * 防抖被清掉。这种 bug 只在「边搜边加」时冒头，很难查。
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const search = async (text: string, nextPage = 1) => {
    const term = text.trim()
    window.clearTimeout(debounce.current)
    if (!term) {
      seq.current++
      setResults(null)
      setTerm('')
      setTotal(0)
      setTotalPages(1)
      setPage(1)
      setError(null)
      setLoading(false)
      return
    }
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await searchGamesForCollection(term, nextPage)
      if (mine !== seq.current) return
      setResults((prev) => (nextPage > 1 && prev ? [...prev, ...res.items] : res.items))
      setTerm(term)
      setPage(res.page)
      setTotalPages(res.totalPages)
      setTotal(res.total)
    } catch (e) {
      if (mine !== seq.current) return
      setError(e instanceof Error ? e.message : t.collections.searchFailed)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }

  const onInput = (value: string) => {
    setQ(value)
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void search(value), DEBOUNCE_MS)
  }

  // 只在挂载 / 卸载时跑一次（见 onCloseRef 的注释）
  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(debounce.current)
      // 卸载后飞着的请求一律作废
      seq.current++
    }
  }, [])

  const add = async (game: Game) => {
    setBusySlug(game.slug)
    setError(null)
    try {
      const res = await addGameToCollection(collection.id, game.slug)
      setAdded((prev) => new Set(prev).add(game.slug))
      onAdded(game, res.added)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.collections.saveFailed)
    } finally {
      setBusySlug(null)
    }
  }

  const inCollection = (slug: string) => existing.has(slug) || added.has(slug)

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collection-add-games-title"
    >
      <div className="flex w-full max-w-3xl flex-col rounded-2xl border border-line bg-surface p-5 shadow-2xl" style={{ maxHeight: 'calc(100vh - 2rem)' }}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="collection-add-games-title" className="text-lg font-bold">
            {fmt(t.collections.addGamesTitle, { title: collection.title })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.close}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-fg"
          >
            ✕
          </button>
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void search(q)
          }}
        >
          <div className="relative flex-1">
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">
              🔍
            </span>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => onInput(e.target.value)}
              placeholder={t.collections.searchGames}
              className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-9 text-sm text-fg placeholder:text-dim transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              maxLength={60}
            />
            {q && (
              <button
                type="button"
                onClick={() => {
                  setQ('')
                  void search('')
                  inputRef.current?.focus()
                }}
                aria-label={t.common.close}
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-dim hover:bg-black/5 hover:text-fg"
              >
                ✕
              </button>
            )}
          </div>
          {/* 「搜索」两个字复用顶栏那条，不为一个词再开一个 key */}
          <Button type="submit" variant="secondary" size="sm" disabled={loading || !q.trim()}>
            {t.topbar.search}
          </Button>
        </form>

        {error && <p className="mt-3 text-xs text-live">{error}</p>}

        <div className="mt-4 min-h-[8rem] flex-1 overflow-y-auto pr-1">
          {results === null ? (
            <p className="px-2 py-10 text-center text-sm text-muted">{loading ? '…' : t.collections.searchHint}</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-muted">{fmt(t.collections.searchNoResults, { q: term })}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {results.map((g) => {
                const done = inCollection(g.slug)
                const busy = busySlug === g.slug
                const platform = platformMap[g.platform]
                return (
                  <div key={g.slug} className={cx('relative overflow-hidden rounded-card border border-line bg-surface', done && 'opacity-70')}>
                    <GameCover game={g} ratio="square" />
                    {/* 压在封面右上角，和详情页那颗「移出」放同一个位置，肌肉记忆一致 */}
                    <Button
                      size="sm"
                      variant={done ? 'secondary' : 'primary'}
                      disabled={done || busy}
                      onClick={() => void add(g)}
                      className="absolute right-2 top-2 z-10"
                    >
                      {busy ? t.collections.adding : done ? t.collections.added : t.collections.add}
                    </Button>
                    <div className="space-y-1 p-2.5">
                      <h3 className="truncate text-sm font-semibold leading-tight" title={gameTitle(g, lang)}>
                        {gameTitle(g, lang)}
                      </h3>
                      <p className="truncate text-[11px] text-muted">
                        {platform?.shortName ?? g.platform}
                        {g.year ? ` · ${g.year}` : ''}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {results && results.length > 0 && page < totalPages && (
            <div className="mt-4 flex justify-center">
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void search(term, page + 1)}>
                {loading ? '…' : `${t.common.loadMore} (${results.length}/${total})`}
              </Button>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-4">
          <span className="text-xs text-muted">{added.size > 0 ? fmt(t.collections.addedCount, { n: String(added.size) }) : ''}</span>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t.common.close}
          </Button>
        </div>
      </div>
    </div>
  )
}
