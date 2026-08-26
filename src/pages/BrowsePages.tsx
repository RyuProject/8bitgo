import { Link } from 'react-router-dom'
import { getDevelopers, getGenres, getPlatforms } from '@/services/games'
import { platformMap } from '@/data/platforms'
import { useSeo, breadcrumbSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { genreDesc, genreLabel } from '@/services/i18nData'
import { PlatformCard } from '@/components/game/PlatformCard'
import { GameCover } from '@/components/game/GameCover'

function PageIntro({ eyebrow, title, desc }: { eyebrow: string; title: string; desc: string }) {
  return (
    <div className="max-w-2xl">
      <span className="text-pixel text-[11px] text-brand-hover">{eyebrow}</span>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{title}</h1>
      <p className="mt-3 leading-relaxed text-muted">{desc}</p>
    </div>
  )
}

/* ---------------- 平台 ---------------- */
export function PlatformsPage() {
  const t = useT()
  useSeo({
    title: t.browse.platformsTitle,
    description: t.seo.platforms,
    jsonLd: [
      breadcrumbSchema([
        { name: t.common.home, path: '/' },
        { name: t.browse.platformsTitle, path: '/platforms' },
      ]),
    ],
  })
  const platforms = getPlatforms()
  return (
    <div className="container-x py-8 sm:py-10">
      <PageIntro
        eyebrow="PLATFORMS"
        title={t.browse.platformsTitle}
        desc={fmt(t.browse.platformsDesc, { n: platforms.length })}
      />
      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {platforms.map((p) => (
          <PlatformCard key={p.id} platform={p} />
        ))}
      </div>
    </div>
  )
}

/* ---------------- 类型 ---------------- */
export function GenresPage() {
  const t = useT()
  useSeo({
    title: t.browse.genresTitle,
    description: t.seo.genres,
    jsonLd: [
      breadcrumbSchema([
        { name: t.common.home, path: '/' },
        { name: t.browse.genresTitle, path: '/genres' },
      ]),
    ],
  })
  const genres = getGenres()
  return (
    <div className="container-x py-8 sm:py-10">
      <PageIntro eyebrow="GENRES" title={t.browse.genresTitle} desc={t.browse.genresDesc} />
      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {genres.map((g) => (
          <Link
            key={g.id}
            to={`/genres/${g.id}`}
            className="group card-hover rounded-card border border-line bg-surface p-5 hover:border-brand/60"
          >
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-soft text-2xl transition group-hover:scale-110" aria-hidden>
              {g.icon}
            </span>
            <h2 className="mt-4 text-lg font-bold">{genreLabel(t, g.id, g.name)}</h2>
            <p className="mt-1 line-clamp-2 text-sm text-muted">{genreDesc(t, g.id, g.description)}</p>
            <p className="mt-3 text-sm font-semibold text-brand-hover">{fmt(t.common.gamesCountArrow, { n: g.count })}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 开发商 ---------------- */
export function DevelopersPage() {
  const t = useT()
  useSeo({
    title: t.browse.developersTitle,
    description: t.seo.developers,
    jsonLd: [
      breadcrumbSchema([
        { name: t.common.home, path: '/' },
        { name: t.browse.developersTitle, path: '/developers' },
      ]),
    ],
  })
  const developers = getDevelopers()
  return (
    <div className="container-x py-8 sm:py-10">
      <PageIntro eyebrow="DEVELOPERS" title={t.browse.developersTitle} desc={fmt(t.browse.developersDesc, { n: developers.length })} />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {developers.map((d) => (
          <Link
            key={d.name}
            to={`/games?developer=${encodeURIComponent(d.name)}`}
            className="group card-hover flex items-center gap-4 rounded-card border border-line bg-surface p-3 hover:border-brand/60"
          >
            <div className="w-16 shrink-0 overflow-hidden rounded-lg">
              <GameCover game={d.topGame} ratio="square" showTitle={false} iconSize="sm" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-bold">{d.name}</h2>
              <p className="mt-0.5 truncate text-xs text-muted">
                {fmt(t.browse.topGame, { title: d.topGame.titleZh ?? d.topGame.title })}
              </p>
              <p className="mt-1.5 flex flex-wrap gap-1">
                {d.platforms.slice(0, 4).map((p) => (
                  <span key={p} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">
                    {platformMap[p].shortName}
                  </span>
                ))}
              </p>
            </div>
            <span className="text-pixel shrink-0 text-[11px] text-brand-hover">{fmt(t.browse.countSuffix, { n: d.count })}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
