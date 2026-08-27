import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { Game, Genre, Platform } from '@/types'
import { usePageData, type GenreData, type Paged, type PlatformData } from '@/services/pageData'
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
 *
 * 游戏列表由后端按平台 / 类型查好分好页再回来；平台和类型本身（名称、图标、
 * 描述、是否开放）仍然是代码里的配置，不走网络 —— 所以哪怕列表还没到，
 * 页头和面包屑也能立刻渲染出来。
 */

interface CollectionProps {
  /** 只影响页面上的小标签（PLATFORM / GENRE） */
  kind: 'platform' | 'genre'
  /** H1 与 title */
  heading: string
  /** H1 下面那句简介 */
  intro: string
  /**
   * 页面底部的长文。这是本页独有的内容，也是这类列表页能不能拿到搜索排名的关键 ——
   * 放在游戏网格下面：用户先看到游戏，搜索引擎照样读得到。
   * 空字符串表示这个语言还没写，届时只显示上面的简介。
   */
  article?: string
  /** 长文的小标题 */
  articleTitle?: string
  /** meta description */
  description: string
  /** 上级列表页 */
  parent: { name: string; path: string }
  /** 本页路径（不带 page） */
  basePath: string
  /** 后端返回的这一页；首次取数还没回来时是 undefined */
  list?: Paged<Game>
  /** URL 上的页码。列表还没到也要能算出正确的 canonical，所以不能等 list.page */
  page: number
  /** 取数失败的原因 */
  error?: string
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
  article,
  articleTitle,
  list,
  page: urlPage,
  error,
  onPage,
  filterHref,
}: CollectionProps) {
  const t = useT()

  // 后端会把越界页码夹回合法范围，以它为准；数据没到之前先用 URL 上的
  const page = list?.page ?? urlPage
  const totalPages = list?.totalPages ?? 1

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
      // 爬虫读到的是服务端渲染好的 HTML，那时 list 已经有值
      itemListSchema(
        heading,
        (list?.items ?? []).map((g) => ({ name: g.titleZh ?? g.title, path: `/games/${g.slug}` })),
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
        <p className="mt-2 text-sm text-muted">{list ? fmt(t.common.gamesCount, { n: list.total }) : null}</p>
      </div>

      {error ? (
        <p className="mt-8 text-sm text-muted" role="alert">
          {error}
        </p>
      ) : !list ? (
        <GameGridSkeleton />
      ) : list.items.length > 0 ? (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {list.items.map((g) => (
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

      {article && (
        <section className="mt-10 max-w-3xl border-t border-line pt-8">
          {articleTitle && <h2 className="text-xl font-bold tracking-tight">{articleTitle}</h2>}
          <div className="mt-4 space-y-4 leading-[1.9] text-muted">
            {article.split('\n\n').map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** 列表还没到时的占位，格子数和真实网格一致，数据到位时页面不会整体跳一下 */
function GameGridSkeleton() {
  return (
    <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
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

/** URL 上的 ?page=，非法值一律当第一页 */
function pageFrom(params: URLSearchParams): number {
  return Math.max(1, Number(params.get('page') ?? 1) || 1)
}

/* ---------------- 平台页 /platforms/:id ---------------- */
export function PlatformPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const t = useT()

  const page = pageFrom(params)
  const platform: Platform | undefined = platformMap[id]
  // Hook 不能放到下面的 404 分支后面，所以不认识的 id 也照发一次请求；
  // 后端回一页空列表，反正这种 URL 本来就渲染不到列表
  const state = usePageData<PlatformData>(`/platforms/${encodeURIComponent(id)}`, { page }, 'platform')

  // 未启用的平台不该有可收录的页面
  if (!platform || !isPlatformEnabled(platform.id)) return <NotFoundPage />

  const list = state.data?.list
  const name = platformLabel(t, platform.id, platform.name)
  return (
    <Collection
      kind="platform"
      heading={fmt(t.seo.platformH1, { platform: name })}
      intro={platformDesc(t, platform.id, platform.description)}
      article={t.seo.platformIntro[platform.id as keyof typeof t.seo.platformIntro] || ''}
      articleTitle={fmt(t.seo.platformArticle, { platform: name })}
      // 收录数量还没到时先写 0：真正读 description 的爬虫拿的是服务端渲染的 HTML，
      // 那一份里 list 一定是有值的
      description={fmt(t.seo.platformDesc, { platform: name, n: list?.total ?? 0 })}
      parent={{ name: t.browse.platformsTitle, path: '/platforms' }}
      basePath={`/platforms/${platform.id}`}
      list={list}
      page={page}
      error={state.status === 'error' ? state.error : undefined}
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

  const page = pageFrom(params)
  const genre: Genre | undefined = genreMap[id]
  const state = usePageData<GenreData>(`/genres/${encodeURIComponent(id)}`, { page }, 'genre')

  // 类型是代码里的配置，不认识的 id 立刻 404
  if (!genre) return <NotFoundPage />
  // 一款游戏都没有的类型就是空页面，不如直接 404，别让它进索引。
  // 但必须等数据真的回来才能这么判 —— 拿 loading 时的空列表当 0 会先闪一下 404
  if (state.status === 'ready' && state.data.list.total === 0) return <NotFoundPage />

  const list = state.data?.list
  const name = genreLabel(t, genre.id, genre.name)
  return (
    <Collection
      kind="genre"
      heading={fmt(t.seo.genreH1, { genre: name })}
      intro={genreDesc(t, genre.id, genre.description)}
      description={fmt(t.seo.genreDesc, { genre: name, n: list?.total ?? 0 })}
      parent={{ name: t.browse.genresTitle, path: '/genres' }}
      basePath={`/genres/${genre.id}`}
      list={list}
      page={page}
      error={state.status === 'error' ? state.error : undefined}
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
