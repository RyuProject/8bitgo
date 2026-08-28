import { useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { Game, Genre, Platform } from '@/types'
import { fetchPageData, usePageData, type GenreData, type Paged, type PlatformData } from '@/services/pageData'
import { useInfinite, type InfiniteList } from '@/services/infinite'
import { InfiniteFooter } from '@/components/ui/InfiniteFooter'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { useSeo, breadcrumbSchema, itemListSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { gameTitle, genreDesc, genreLabel, platformDesc, platformLabel } from '@/services/i18nData'
import { useLang } from '@/services/lang'
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
  /** 往下滚续接出来的完整列表（含首页） */
  more: InfiniteList<Game>
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
  more,
  page: urlPage,
  error,
  onPage,
  filterHref,
}: CollectionProps) {
  const t = useT()
  const lang = useLang()

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
        (list?.items ?? []).map((g) => ({ name: gameTitle(g, lang), path: `/games/${g.slug}` })),
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
      ) : more.items.length > 0 ? (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {more.items.map((g) => (
              <GameCard key={g.slug} game={g} />
            ))}
          </div>

          <InfiniteFooter list={more} pageSize={list.pageSize} />

          {/* 已经往下接过之后，页码显示的位置和实际看到的内容对不上，收起来 */}
          {totalPages > 1 && more.items.length === list.items.length && (
            <div className="mt-6">
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

/**
 * 平台页 / 类型页共用的「接下一页」。
 *
 * resetKey 把路径和入口页码都算进去：从 /platforms/nes 走到 /platforms/gba，
 * 或者点页码跳到第 3 页，都必须把已经接上的部分丢掉重来。
 */
function useCollectionInfinite(
  path: string,
  page: number,
  list: Paged<Game> | undefined,
  ready: boolean,
): InfiniteList<Game> {
  const resetKey = `${path}?page=${page}`
  const fetchMore = useCallback(
    async (nextPage: number): Promise<Paged<Game>> => {
      const d = await fetchPageData(path, { page: nextPage })
      // 后端按路径决定回哪种 payload；对不上说明路由变了，这批数据不能用
      if (d.route !== 'platform' && d.route !== 'genre') throw new Error('unexpected route payload')
      return d.list
    },
    [path],
  )
  return useInfinite({ first: list, ready, fetchPage: fetchMore, resetKey })
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
  const path = `/platforms/${encodeURIComponent(id)}`
  const state = usePageData<PlatformData>(path, { page }, 'platform')
  // 必须在下面的 404 分支之前调用：hook 的调用顺序每次渲染都得一致
  const more = useCollectionInfinite(path, page, state.data?.list, state.status === 'ready')

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
      more={more}
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
  const path = `/genres/${encodeURIComponent(id)}`
  const state = usePageData<GenreData>(path, { page }, 'genre')
  const more = useCollectionInfinite(path, page, state.data?.list, state.status === 'ready')

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
      more={more}
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
