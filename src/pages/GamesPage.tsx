import { useMemo, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { GenreId, PlatformId, SortKey } from '@/types'
import type { Translation } from '@/locales'
import { getGenre, getGenres, getPlatform, getPlatforms, queryGames } from '@/services/games'
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
    { key: 'rating', label: t.games.sortRating },
    { key: 'name', label: t.games.sortName },
  ]
}

const SORT_KEYS: SortKey[] = ['popular', 'newest', 'rating', 'name']

/**
 * 游戏库页面。所有筛选条件都保存在 URL 查询参数里，方便分享与前进后退：
 *   /games?platform=gba&genre=rpg&q=zelda&sort=rating&multiplayer=1&coin=1&page=2
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

  const platform = platformId ? getPlatform(platformId) : undefined
  const genre = genreId ? getGenre(genreId) : undefined

  const result = useMemo(
    () =>
      queryGames({
        q,
        platform: platform?.id,
        genre: genre?.id,
        developer,
        multiplayer,
        coin,
        // 用校验过的 sort，不是原始参数：下拉框显示的是 sort，
        // 传 sortParam 会出现「显示最热门、列表却没排序」的对不上
        sort,
        page,
      }),
    [q, platform?.id, genre?.id, developer, multiplayer, coin, sort, page],
  )

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
    jsonLd: [
      itemListSchema(
        title,
        result.items.map((g) => ({ name: g.titleZh ?? g.title, path: `/games/${g.slug}` })),
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
                : fmt(t.games.total, { n: result.total })}
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
          {getPlatforms().map((p) => (
            <FilterChip
              key={p.id}
              active={platformId === p.id}
              onClick={() => set('platform', platformId === p.id ? null : p.id)}
            >
              {p.icon} {p.shortName}
              <span className="opacity-60">{p.count}</span>
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t.games.filterGenre}>
          <FilterChip active={!genreId} onClick={() => set('genre', null)}>
            {t.common.all}
          </FilterChip>
          {getGenres().map((g) => (
            <FilterChip
              key={g.id}
              active={genreId === g.id}
              onClick={() => set('genre', genreId === g.id ? null : g.id)}
            >
              {g.icon} {genreLabel(t, g.id, g.name)}
              <span className="opacity-60">{g.count}</span>
            </FilterChip>
          ))}
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
      <p className="mt-6 text-sm text-muted">
        {fmt(t.games.total, { n: result.total })}
        {result.totalPages > 1 && fmt(t.games.pageOf, { page: result.page, total: result.totalPages })}
      </p>

      {result.items.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {result.items.map((g) => (
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

      <div className="mt-10">
        <Pagination page={result.page} totalPages={result.totalPages} onChange={(p) => set('page', String(p))} />
      </div>
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
