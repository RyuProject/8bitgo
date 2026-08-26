import { Link } from 'react-router-dom'
import { getGenres } from '@/services/games'
import { chipClasses } from '@/components/ui/Button'
import { useT } from '@/services/i18n'
import { genreLabel } from '@/services/i18nData'

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

/** 类型快捷入口（横幅下方那一排）。按钮沿用站内统一的 3D chip 样式。 */
export function HomeIntro() {
  const t = useT()
  const genres = getGenres().filter((g) => g.count > 0)

  return (
    <section className="container-x">
      <nav className="flex flex-wrap items-center gap-x-2 gap-y-2.5" aria-label={t.home.browseByGenre}>
        {genres.map((g) => (
          <Link key={g.id} to={`/games?genre=${g.id}`} className={chipClasses(false, 'text-sm')}>
            <span aria-hidden>{g.icon}</span>
            {genreLabel(t, g.id)}
          </Link>
        ))}
      </nav>
    </section>
  )
}
