import { HomeHeading, HomeIntro } from '@/components/home/HomeIntro'
import { HomeBanner } from '@/components/home/HomeBanner'
import { FeaturedCarousel } from '@/components/home/FeaturedCarousel'
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

  return (
    // 顺序：横幅（贴顶）→ 16px → 类型入口 → 40px → 其余区块（相互 40px）。
    // 类型入口放在 space-y 容器外面，就不用负 margin 去抵消 space-y-10 了。
    <div className="pb-8">
      <HomeHeading />
      <HomeBanner />

      <div className="pt-4">
        <HomeIntro facets={data?.facets} />
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
        <PopularSection games={data?.popular ?? []} />
        <PlatformsSection facets={data?.facets} />
        <LatestSection games={data?.newest ?? []} />
        <TogetherSection games={data?.multiplayer ?? []} />
        <GenreGridSection facets={data?.facets} genreSamples={data?.genreSamples} />
        <FeaturedCarousel />
        <FaqSection />
      </div>
    </div>
  )
}
