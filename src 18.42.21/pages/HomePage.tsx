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
  TopRatedSection,
} from '@/components/home/sections'
import { useSeo, faqSchema, websiteSchema } from '@/services/seo'
import { useT } from '@/services/i18n'

export function HomePage() {
  const t = useT()
  // 首页不传 title，直接用站点默认标题；FAQ 结构化数据直接复用页面上的问答
  useSeo({
    description: t.seo.home,
    jsonLd: [websiteSchema(t.seo.home), faqSchema(t.faq)],
  })
  return (
    // 顺序：横幅（贴顶）→ 16px → 类型入口 → 40px → 其余区块（相互 40px）。
    // 类型入口放在 space-y 容器外面，就不用负 margin 去抵消 space-y-10 了。
    <div className="pb-8">
      <HomeHeading />
      <HomeBanner />

      <div className="pt-4">
        <HomeIntro />
      </div>

      <div className="space-y-10 pt-10">
        <PopularSection />
        <PlatformsSection />
        <LatestSection />
        <TogetherSection />
        <TopRatedSection />
        <GenreGridSection />
        <FeaturedCarousel />
        <FaqSection />
      </div>
    </div>
  )
}
