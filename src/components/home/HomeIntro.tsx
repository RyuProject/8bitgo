import { Link } from 'react-router-dom'
import { genres } from '@/data/genres'
import { chipClasses } from '@/components/ui/Button'
import { useT } from '@/services/i18n'
import { genreLabel } from '@/services/i18nData'
import type { Facets } from '@/services/pageData'

/**
 * 首页隐藏的 h1：屏幕上看不见，搜索引擎与读屏软件仍能读到。
 * 首页可见的大标题（HomeBanner）是 h2，没有这个 h1 首页就一个 h1 都没有，对 SEO 不利。
 * 想恢复显示：把 sr-only 换成 text-3xl font-extrabold tracking-tight sm:text-4xl
 */
export function HomeHeading() {
  const t = useT()
  return (
    <h1 className="sr-only">
      {t.home.introHeadline1}
      {t.home.introHeadline2}
    </h1>
  )
}

/**
 * 类型快捷入口（横幅下方那一排）。按钮沿用站内统一的 3D chip 样式。
 *
 * 数量由 HomePage 一次取好的 facets 提供；facets 还没到（首帧 loading）就先一个都不渲染，
 * 而不是先把 12 个类型全铺上去 —— 那样数据到了要抽掉几个，整排 chip 会跳一下。
 */
export function HomeIntro({ facets }: { facets?: Facets }) {
  const t = useT()
  // chip 上的图标和名字仍旧来自 src/data/genres，facets 只用来筛掉空类型
  const nonEmpty = new Set<string>(facets?.genres.filter((g) => g.count > 0).map((g) => g.id))
  const shown = genres.filter((g) => nonEmpty.has(g.id))

  return (
    <section className="container-x">
      <nav className="flex flex-wrap items-center gap-x-2 gap-y-2.5" aria-label={t.home.browseByGenre}>
        {shown.map((g) => (
          <Link key={g.id} to={`/genres/${g.id}`} className={chipClasses(false, 'text-sm')}>
            <span aria-hidden>{g.icon}</span>
            {genreLabel(t, g.id)}
          </Link>
        ))}
      </nav>
    </section>
  )
}
