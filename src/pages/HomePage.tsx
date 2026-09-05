import { HomeHeading, HomeIntro } from '@/components/home/HomeIntro'
import { HomeBanner } from '@/components/home/HomeBanner'
import {
  FaqSection,
  GenreGridSection,
  LatestSection,
  PlatformsSection,
  PopularSection,
  TogetherSection,
} from '@/components/home/sections'
import { useSeo, faqSchema, websiteSchema } from '@/services/seo'
import { useT } from '@/services/i18n'
import { usePageData, type HomeData } from '@/services/pageData'
import { GameCardSkeleton, SkeletonBlock } from '@/components/ui/PageSkeleton'

export function HomePage() {
  const t = useT()
  // 首页不传 title，直接用站点默认标题；FAQ 结构化数据直接复用页面上的问答
  useSeo({
    description: t.seo.home,
    jsonLd: [websiteSchema(t.seo.home), faqSchema(t.faq)],
  })
  // 整页只取这一次：热门 / 最新 / 联机 / 分类样例 / facets 全在这份数据里。
  // 让每个区块自己取的话，首屏就是七八个并发请求，而它们本来就是同一次查询能出的结果。
  const state = usePageData<HomeData>('/', undefined, 'home')
  const data = state.data
  const loading = state.status === 'loading' && !data

  return (
    // 顺序：横幅（贴顶）→ 16px → 类型入口 → 40px → 其余区块（相互 40px）。
    // 类型入口放在 space-y 容器外面，就不用负 margin 去抵消 space-y-10 了。
    <div className="pb-8">
      <HomeHeading />
      {/* 标题里轮换的游戏名和右边那摞封面都来自热门这一栏 —— 数据没到时横幅自己有兜底 */}
      <HomeBanner games={data?.popular} />

      <div className="pt-4">
        <HomeIntro facets={data?.facets} loading={loading} />
      </div>

      {/*
        取数失败时只在这里提一句就够了：横幅、FAQ、工具区都不依赖后端，页面本身还是能看的。
        文案直接用 usePageData 给的原始信息（「未配置后端」和网络错误要分得清），
        locales 里暂时没有对应的键。
      */}
      {state.status === 'error' && (
        <div className="container-x pt-6">
          <p className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">{state.error}</p>
        </div>
      )}

      {/*
        还没取到数据时各区块拿到的是空列表：标题和轨道照常渲染，只是里面没有卡片。
        这样从 loading 到 ready 页面不会整段长出来把下面的内容顶走。
      */}
      <div className="space-y-10 pt-10">
        {loading ? (
          <HomeDataSkeleton />
        ) : (
          <>
            <PopularSection games={data?.popular ?? []} curated={data?.popularCurated ?? false} />
            <PlatformsSection facets={data?.facets} />
            <LatestSection games={data?.newest ?? []} />
            <TogetherSection games={data?.multiplayer ?? []} />
            <GenreGridSection facets={data?.facets} genreSamples={data?.genreSamples} />
          </>
        )}
        <FaqSection />
      </div>
    </div>
  )
}

/**
 * 首页一次要等热门、平台、最新等多组数据；先按真实横向轨道占住前三栏，
 * 用户往下滚时不会遇到大片空白，数据回来后卡片宽度和节奏也保持一致。
 */
function HomeDataSkeleton() {
  return (
    <div className="contents" aria-busy="true">
      {(['game', 'platform', 'wide'] as const).map((kind) => (
        <section key={kind} className="container-x" aria-hidden>
          <div className="mb-3 flex items-end justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-5 w-36" />
              <SkeletonBlock className="mt-2 h-3 w-56 max-w-[65vw]" />
            </div>
            <SkeletonBlock className="h-3 w-14" />
          </div>
          <div className="-mx-4 flex gap-4 overflow-hidden px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className={kind === 'wide' ? 'w-64 shrink-0 sm:w-72' : kind === 'platform' ? 'w-52 shrink-0 sm:w-56' : 'w-56 shrink-0 sm:w-60'}
              >
                {kind === 'platform' ? (
                  <div className="h-44 rounded-card border border-line bg-surface p-4">
                    <SkeletonBlock className="h-12 w-12 rounded-xl" />
                    <SkeletonBlock className="mt-5 h-4 w-2/3" />
                    <SkeletonBlock className="mt-3 h-3 w-full" />
                    <SkeletonBlock className="mt-2 h-3 w-3/5" />
                  </div>
                ) : (
                  <GameCardSkeleton coverRatio={kind === 'wide' ? 'landscape' : 'square'} />
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
