import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getGamesBySlugs } from '@/services/games'
import { platformMap } from '@/data/platforms'
import { gradientFor } from '@/lib/gradients'
import { cx, formatCount } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { useT, fmt } from '@/services/i18n'
import type { Translation } from '@/locales'
import { platformLabel } from '@/services/i18nData'

const FEATURED = [
  { slug: 'taiko-web', tagline: (t: Translation) => t.featured.motion },
  { slug: 'chrono-trigger', tagline: (t: Translation) => t.featured.rpg },
  { slug: 'street-fighter-ii', tagline: (t: Translation) => t.featured.versus },
]

export function FeaturedCarousel() {
  const t = useT()
  const items = getGamesBySlugs(FEATURED.map((f) => f.slug))
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % items.length), 5000)
    return () => window.clearInterval(timer)
  }, [paused, items.length])

  return (
    <section
      className="container-x"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription={t.home.carouselAria}
    >
      <div className="relative overflow-hidden rounded-3xl border border-line">
        <div
          className="flex transition-transform duration-700 ease-out"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {items.map((g, i) => {
            const platform = platformMap[g.platform]
            return (
              <article
                key={g.slug}
                className="relative w-full shrink-0"
                style={{ background: gradientFor(g.slug) }}
                aria-hidden={i !== index}
              >
                <div className="pixel-grid absolute inset-0 opacity-50" aria-hidden />
                <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/55 to-black/10" aria-hidden />
                <div className="relative grid min-h-[300px] gap-6 p-6 sm:p-10 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="max-w-xl">
                    <Badge tone="coin" pixel className="mb-4">
                      {t.home.featured}
                    </Badge>
                    <p className="text-xs font-semibold text-white/80">{FEATURED[i].tagline(t)}</p>
                    <h3 className="mt-2 text-2xl font-extrabold text-white sm:text-4xl">
                      {g.titleZh ?? g.title}
                    </h3>
                    <p className="mt-1 text-sm text-white/70">
                      {g.title} · {platformLabel(t, g.platform, platform.name)} · {g.year} · {g.developer}
                    </p>
                    <p className="mt-4 line-clamp-3 text-sm leading-relaxed text-white/85 sm:text-base">
                      {g.description}
                    </p>
                    <div className="mt-6 flex flex-wrap items-center gap-3">
                      <Button to={`/games/${g.slug}`} size="lg">
                        <span aria-hidden>▶</span> {t.home.playNow}
                      </Button>
                      <span className="text-sm text-white/70">{fmt(t.common.playsCount, { n: formatCount(g.plays) })}</span>
                      <CoinBadge amount={g.coinReward} />
                    </div>
                  </div>
                  <div
                    className="hidden h-44 w-44 place-items-center rounded-3xl border border-white/20 bg-white/10 text-8xl shadow-2xl backdrop-blur md:grid"
                    aria-hidden
                  >
                    {g.icon}
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        {/* 指示器 */}
        <div className="absolute bottom-4 right-6 flex items-center gap-2">
          {items.map((g, i) => (
            <button
              key={g.slug}
              type="button"
              aria-label={fmt(t.home.slideNth, { n: i + 1 })}
              aria-current={i === index}
              onClick={() => setIndex(i)}
              className={cx(
                'h-2 rounded-full transition-all',
                i === index ? 'w-8 bg-white' : 'w-2 bg-white/40 hover:bg-white/70',
              )}
            />
          ))}
        </div>
        <Link to="/games" className="sr-only">
          {t.home.browseAllGames}
        </Link>
      </div>
    </section>
  )
}
