import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { Game } from '@/types'
import { queryGames, getPlatform, getGenre, DEFAULT_PAGE_SIZE } from '@/services/games'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { useSeo, breadcrumbSchema, itemListSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { genreDesc, genreLabel, platformDesc, platformLabel } from '@/services/i18nData'
import { GameCard } from '@/components/game/GameCard'
import { Pagination } from '@/components/ui/Pagination'
import { Button } from '@/components/ui/Button'
import { NotFoundPage } from './NotFoundPage'

/**
 * 平台页 / 类型页 —— 这两类是本站最主要的搜索入口
 * （「NES 游戏在线玩」「GBA 模拟器」「射击游戏合集」都落在这里）。
 *
 * 为什么要有独立路由，而不是复用 /games?platform=nes：
 *   - 查询参数页在 robots.txt 里被挡、canonical 又统一指向 /games，永远不可能拿到排名
 *   - 干净路径才能拥有自己的 title / description / H1 / 正文和结构化数据
 *   - /games 保留成「带筛选工具的全部游戏」，两者分工明确，不互相抢
 *
 * 分页用 ?page=2，canonical 指向自己（含 page），这样第二页往后的游戏也能被发现。
 */

interface CollectionProps {
  /** 只影响页面上的小标签（PLATFORM / GENRE） */
  kind: 'platform' | 'genre'
  /** H1 与 title */
  heading: string
  /** 页面正文（对搜索引擎来说这是本页独有的内容） */
  intro: string
  /** meta description */
  description: string
  /** 上级列表页 */
  parent: { name: string; path: string }
  /** 本页路径（不带 page） */
  basePath: string
  items: Game[]
  total: number
  page: number
  totalPages: number
  onPage: (p: number) => void
  /** 「用更多条件筛选」跳回 /games 的链接 */
  filterHref: string
}

function Collection({
  kind,
  heading,
  intro,
  description,
  parent,
  basePath,
  items,
  total,
  page,
  totalPages,
  onPage,
  filterHref,
}: CollectionProps) {
  const t = useT()

  useSeo({
    // 第二页起标题带上页码，避免多页共用同一个 title
    title: page > 1 ? `${heading}${fmt(t.games.pageOf, { page, total: totalPages })}` : heading,
    description,
    // 每一页 canonical 指向自己：分页内容不同，不该被合并掉
    canonicalPath: page > 1 ? `${basePath}?page=${page}` : basePath,
    jsonLd: [
      breadcrumbSchema([
        { name: t.common.home, path: '/' },
        { name: parent.name, path: parent.path },
        { name: heading, path: basePath },
      ]),
      itemListSchema(
        heading,
        items.map((g) => ({ name: g.titleZh ?? g.title, path: `/games/${g.slug}` })),
      ),
    ],
  })

  return (
    <div className="container-x py-8 sm:py-10">
      <nav className="text-xs text-muted" aria-label={t.common.breadcrumb}>
        <Link to="/" className="hover:text-fg">
          {t.common.home}
        </Link>
        <span className="mx-1.5">/</span>
        <Link to={parent.path} className="hover:text-fg">
          {parent.name}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-fg">{heading}</span>
      </nav>

      <div className="mt-4 max-w-2xl">
        <span className="text-pixel text-[11px] text-brand-hover">{kind === 'platform' ? 'PLATFORM' : 'GENRE'}</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{heading}</h1>
        <p className="mt-3 leading-relaxed text-muted">{intro}</p>
        <p className="mt-2 text-sm text-muted">{fmt(t.common.gamesCount, { n: total })}</p>
      </div>

      {items.length > 0 ? (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {items.map((g) => (
              <GameCard key={g.slug} game={g} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8">
              <Pagination page={page} totalPages={totalPages} onChange={onPage} />
            </div>
          )}
        </>
      ) : (
        <p className="mt-8 text-sm text-muted">{t.games.emptyTitle}</p>
      )}

      <div className="mt-10 border-t border-line pt-6">
        <Button to={filterHref} variant="secondary" size="sm">
          {t.common.moreFilters}
        </Button>
      </div>
    </div>
  )
}

/* ---------------- 平台页 /platforms/:id ---------------- */
export function PlatformPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const t = useT()

  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const platform = getPlatform(id)
  const result = queryGames({ platform: platform?.id, sort: 'popular', page, pageSize: DEFAULT_PAGE_SIZE })

  // 未启用的平台不该有可收录的页面
  if (!platform || !isPlatformEnabled(platform.id)) return <NotFoundPage />

  const name = platformLabel(t, platform.id, platform.name)
  return (
    <Collection
      kind="platform"
      heading={fmt(t.games.titlePlatform, { platform: name })}
      intro={platformDesc(t, platform.id, platformMap[platform.id]?.description ?? '')}
      description={fmt(t.seo.platformDesc, { platform: name, n: result.total })}
      parent={{ name: t.browse.platformsTitle, path: '/platforms' }}
      basePath={`/platforms/${platform.id}`}
      items={result.items}
      total={result.total}
      page={result.page}
      totalPages={result.totalPages}
      onPage={(p) => {
        const next = new URLSearchParams(params)
        if (p <= 1) next.delete('page')
        else next.set('page', String(p))
        setParams(next)
      }}
      filterHref={`/games?platform=${platform.id}`}
    />
  )
}

/* ---------------- 类型页 /genres/:id ---------------- */
export function GenrePage() {
  const { id = '' } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const t = useT()

  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const genre = getGenre(id)
  const result = queryGames({ genre: genre?.id, sort: 'popular', page, pageSize: DEFAULT_PAGE_SIZE })

  // 一款游戏都没有的类型就是空页面，不如直接 404，别让它进索引
  if (!genre || result.total === 0) return <NotFoundPage />

  const name = genreLabel(t, genre.id, genre.name)
  return (
    <Collection
      kind="genre"
      heading={fmt(t.games.titleGenre, { genre: name })}
      intro={genreDesc(t, genre.id, genreMap[genre.id]?.description ?? '')}
      description={fmt(t.seo.genreDesc, { genre: name, n: result.total })}
      parent={{ name: t.browse.genresTitle, path: '/genres' }}
      basePath={`/genres/${genre.id}`}
      items={result.items}
      total={result.total}
      page={result.page}
      totalPages={result.totalPages}
      onPage={(p) => {
        const next = new URLSearchParams(params)
        if (p <= 1) next.delete('page')
        else next.set('page', String(p))
        setParams(next)
      }}
      filterHref={`/games?genre=${genre.id}`}
    />
  )
}
