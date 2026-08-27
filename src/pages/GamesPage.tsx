import { useCallback, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SearchRescue } from '@/components/game/SearchRescue'
import type { Game, GenreId, PlatformId, SortKey } from '@/types'
import type { Translation } from '@/locales'
import { fetchPageData, usePageData, type Facets, type GamesData, type Paged } from '@/services/pageData'
import { useInfinite } from '@/services/infinite'
import { InfiniteFooter } from '@/components/ui/InfiniteFooter'
import { platforms, platformMap } from '@/data/platforms'
import { genres, genreMap } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { useSeo, breadcrumbSchema, itemListSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { genreDesc, genreLabel, platformDesc, platformLabel } from '@/services/i18nData'
import { GameCard } from '@/components/game/GameCard'
import { Pagination } from '@/components/ui/Pagination'
import { Button, chipClasses } from '@/components/ui/Button'
import { FEATURES } from '@/config/features'

function sortsFor(t: Translation): Array<{ key: SortKey; label: string }> {
  return [
    { key: 'popular', label: t.games.sortPopular },
    { key: 'newest', label: t.games.sortNewest },
    { key: 'name', label: t.games.sortName },
  ]
}

const SORT_KEYS: SortKey[] = ['popular', 'newest', 'name']

/**
 * facets 只回「id → 数量」，平台和类型的名称、图标、描述仍然是代码里的配置。
 * 查不到就是 undefined 而不是 0 —— 数据还没到位时宁可不显示数字，
 * 也好过给每个筛选项挂一个假的「0」。
 */
function countsOf(rows: Array<{ id: string; count: number }> | undefined): Map<string, number> {
  return new Map(rows?.map((r) => [r.id, r.count]))
}

/**
 * 游戏库页面。所有筛选条件都保存在 URL 查询参数里，方便分享与前进后退：
 *   /games?platform=gba&genre=rpg&q=zelda&sort=rating&multiplayer=1&coin=1&page=2
 *
 * 数据由后端按这些条件查好、分好页再回来（见 services/pageData）：
 * 前端不再持有整个游戏库，页面上的总数、页数、筛选项数量全部以后端返回的为准。
 */
export function GamesPage() {
  const [params, setParams] = useSearchParams()
  const t = useT()
  const SORTS = sortsFor(t)

  const q = params.get('q') ?? ''
  const platformId = (params.get('platform') as PlatformId | null) ?? undefined
  const genreId = (params.get('genre') as GenreId | null) ?? undefined
  const developer = params.get('developer') ?? undefined
  const multiplayer = params.get('multiplayer') === '1'
  const coin = params.get('coin') === '1'
  const sortParam = params.get('sort') as SortKey | null
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : 'popular'
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)

  const platform = platformId ? platformMap[platformId] : undefined
  const genre = genreId ? genreMap[genreId] : undefined

  /**
   * 取数条件。usePageData 和「续接下一页」共用同一份，
   * 分成两处写迟早会出现「筛选用 A、续接却按 B 取」的错位。
   */
  const query = {
    // 传认得的 id 而不是原始参数：?platform=乱填 应当被当成「没筛平台」，
    // 而不是拿去查一个根本不存在的平台、回一页空列表
    platform: platform?.id,
    genre: genre?.id,
    developer,
    multiplayer: multiplayer ? 1 : undefined,
    coin: coin ? 1 : undefined,
    q,
    // 用校验过的 sort，不是原始参数：下拉框显示的是 sort，
    // 传 sortParam 会出现「显示最热门、列表却没排序」的对不上
    sort,
    page,
  }

  const state = usePageData<GamesData>('/games', query, 'games')
  // 换页 / 换筛选条件时 usePageData 会保留上一次的数据，所以这里通常不是空的；
  // 只有首次进入（且没有服务端注入的首屏数据）才会是 undefined
  const list = state.data?.list
  const facets: Facets | undefined = state.data?.facets

  /**
   * 往下滚时接后面的页。
   *
   * resetKey 用整份查询条件做指纹：换平台、换排序、换页码都会把已接上的部分丢掉重来。
   * 少放一个条件进去，就会出现「切了平台，下面还挂着上一个平台的第 2 页」。
   */
  const resetKey = JSON.stringify(query)
  const fetchMore = useCallback(
    async (nextPage: number): Promise<Paged<Game>> => {
      const d = await fetchPageData('/games', { ...query, page: nextPage })
      if (d.route !== 'games') throw new Error('unexpected route payload')
      return d.list
    },
    // query 每次渲染都是新对象，直接进依赖会让回调每帧都变；用它的指纹当依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey],
  )
  const inf = useInfinite({
    first: list,
    // 只有数据确实是当前这套条件的结果才允许续接（见 useInfinite 里 ready 的说明）
    ready: state.status === 'ready',
    fetchPage: fetchMore,
    resetKey,
  })
  /** 有没有已经往下接过内容。接过之后再显示页码就是在骗人了 */
  const appended = inf.items.length > (list?.items.length ?? 0)

  const platformCounts = countsOf(facets?.platforms)
  const genreCounts = countsOf(facets?.genres)
  // 平台顺序沿用「收录多的排前面」；数量还没回来时 sort 是稳定的，保持配置里的顺序
  const platformChips = platforms
    .filter((p) => isPlatformEnabled(p.id))
    .map((p) => ({ ...p, count: platformCounts.get(p.id) }))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))

  const title = q
    ? fmt(t.games.titleSearch, { q })
    : developer
      ? fmt(t.games.titleDeveloper, { name: developer })
      : platform && genre
        ? fmt(t.games.titlePlatformGenre, {
            platform: platformLabel(t, platform.id, platform.name),
            genre: genreLabel(t, genre.id, genre.name),
          })
        : platform
          ? fmt(t.games.titlePlatform, { platform: platformLabel(t, platform.id, platform.name) })
          : genre
            ? fmt(t.games.titleGenre, { genre: genreLabel(t, genre.id, genre.name) })
            : multiplayer
              ? t.games.titleMultiplayer
              : coin
                ? t.games.titleCoin
                : t.games.titleAll

  // 筛选与分页只是同一份列表的不同切片，canonical 统一指向 /games，避免产生大量重复内容页
  useSeo({
    title,
    description: t.seo.games,
    canonicalPath: '/games',
    // 站内搜索结果没有收录价值（内容随关键词无限组合），但仍允许抓取，
    // 这样 canonical 能被读到，首页 JSON-LD 里的站内搜索框也才验证得过
    noindex: Boolean(q),
    jsonLd: [
      // 爬虫拿到的是服务端渲染好的 HTML，那时 list 已经有值；
      // 客户端跳转过来的第一帧列表还没到，先给个空清单，数据回来会重写
      itemListSchema(
        title,
        (list?.items ?? []).map((g) => ({ name: g.titleZh ?? g.title, path: `/games/${g.slug}` })),
      ),
      breadcrumbSchema([
        { name: t.common.home, path: '/' },
        { name: t.common.library, path: '/games' },
      ]),
    ],
  })

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
    if (key !== 'page') next.delete('page')
    setParams(next)
  }

  const hasFilters = Boolean(q || platformId || genreId || developer || multiplayer || coin)

  return (
    <div className="container-x py-8 sm:py-10">
      {/* 标题 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <nav className="text-xs text-muted" aria-label={t.common.breadcrumb}>
            <Link to="/" className="hover:text-fg">
              {t.common.home}
            </Link>
            <span className="mx-1.5">/</span>
            <span className="text-fg">{t.common.library}</span>
          </nav>
          <h1 className="mt-2 flex items-center gap-2 text-2xl font-extrabold tracking-tight sm:text-3xl">
            {platform && <span aria-hidden>{platform.icon}</span>}
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {platform
              ? platformDesc(t, platform.id, platform.description)
              : genre
                ? genreDesc(t, genre.id, genre.description)
                : list
                  ? fmt(t.games.total, { n: list.total })
                  : null}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          {t.games.sortLabel}
          <select
            value={sort}
            onChange={(e) => set('sort', e.target.value)}
            className="h-9 rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-brand focus:outline-none"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 筛选 */}
      <div className="mt-6 space-y-3">
        <FilterRow label={t.games.filterPlatform}>
          <FilterChip active={!platformId} onClick={() => set('platform', null)}>
            {t.common.all}
          </FilterChip>
          {platformChips.map((p) => (
            <FilterChip
              key={p.id}
              active={platformId === p.id}
              onClick={() => set('platform', platformId === p.id ? null : p.id)}
            >
              {p.icon} {p.shortName}
              {p.count !== undefined && <span className="opacity-60">{p.count}</span>}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t.games.filterGenre}>
          <FilterChip active={!genreId} onClick={() => set('genre', null)}>
            {t.common.all}
          </FilterChip>
          {genres.map((g) => {
            const n = genreCounts.get(g.id)
            return (
              <FilterChip
                key={g.id}
                active={genreId === g.id}
                onClick={() => set('genre', genreId === g.id ? null : g.id)}
              >
                {g.icon} {genreLabel(t, g.id, g.name)}
                {n !== undefined && <span className="opacity-60">{n}</span>}
              </FilterChip>
            )
          })}
        </FilterRow>
        <FilterRow label={t.games.filterFeature}>
          <FilterChip active={multiplayer} onClick={() => set('multiplayer', multiplayer ? null : '1')}>
            {t.games.chipMultiplayer}
          </FilterChip>
          {FEATURES.coins && (
            <FilterChip active={coin} onClick={() => set('coin', coin ? null : '1')}>
              {t.games.chipCoin}
            </FilterChip>
          )}
          {developer && (
            <FilterChip active onClick={() => set('developer', null)}>
              🏢 {developer} ✕
            </FilterChip>
          )}
          {q && (
            <FilterChip active onClick={() => set('q', null)}>
              🔍 {q} ✕
            </FilterChip>
          )}
          {hasFilters && (
            <button
              type="button"
              onClick={() => setParams(new URLSearchParams())}
              className="ml-1 text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              {t.games.clearAll}
            </button>
          )}
        </FilterRow>
      </div>

      {/* 结果 */}
      {state.status === 'error' ? (
        <LoadError message={state.error} />
      ) : !list ? (
        <GameGridSkeleton />
      ) : (
        <>
          <p className="mt-6 text-sm text-muted">
            {fmt(t.games.total, { n: list.total })}
            {/* 已经往下接过之后就别再报页码了：显示着 120 款、却写「第 1 / 40 页」是自相矛盾 */}
            {!appended && list.totalPages > 1 && fmt(t.games.pageOf, { page: list.page, total: list.totalPages })}
          </p>

          {inf.items.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-busy={state.status === 'loading'}>
              {inf.items.map((g) => (
                <GameCard key={g.slug} game={g} />
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-dashed border-line py-16 text-center">
              <p className="text-4xl" aria-hidden>
                👾
              </p>
              <p className="mt-3 font-semibold">{t.games.emptyTitle}</p>
              <p className="mt-1 text-sm text-muted">{t.games.emptyHint}</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => setParams(new URLSearchParams())}>
                {t.games.clearFilters}
              </Button>
            </div>
          )}

          {/* 关键词搜了个空：给拼写建议和放宽条件后的相关游戏，别丢一个空页面给用户 */}
          {q && inf.items.length === 0 && state.status !== 'loading' && (
            <SearchRescue q={q} onPick={(next) => set('q', next)} />
          )}

          <InfiniteFooter list={inf} pageSize={list.pageSize} />

          {/*
            页码留着当「跳着看」的入口：一路点「加载更多」翻到第 40 页太苦。
            但一旦开始往下接，它显示的页码就跟实际看到的内容对不上了，所以那时收起来。
          */}
          {!appended && (
            <div className="mt-6">
              <Pagination page={list.page} totalPages={list.totalPages} onChange={(p) => set('page', String(p))} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-10 shrink-0 pt-2.5 text-xs font-semibold text-muted">{label}</span>
      {/* gap-y 稍大一些，给立体投影留出呼吸空间 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">{children}</div>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={chipClasses(active)}>
      {children}
    </button>
  )
}

/**
 * 首屏取数还没回来时的占位。
 * 占位卡片和真实卡片同尺寸（4:3 封面 + 两行文字），数据到位时页面不会整体跳一下。
 */
function GameGridSkeleton() {
  return (
    <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="aspect-[4/3] animate-pulse bg-white/5" />
          <div className="space-y-2 p-3">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-white/5" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-white/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 取数失败。复用空结果那套外壳，避免为一个边缘状态再造一套样式。 */
function LoadError({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line py-16 text-center" role="alert">
      <p className="text-4xl" aria-hidden>
        📡
      </p>
      <p className="mt-3 font-semibold">{message}</p>
    </div>
  )
}
