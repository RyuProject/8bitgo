import { Link } from 'react-router-dom'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { HScroll } from '@/components/ui/HScroll'
import { Accordion } from '@/components/ui/Accordion'
import { Button } from '@/components/ui/Button'
import { GameCard } from '@/components/game/GameCard'
import { GameCardWide } from '@/components/game/GameCardWide'
import { PlatformCard } from '@/components/game/PlatformCard'
import { GameCover } from '@/components/game/GameCover'
import { genreMap, genres } from '@/data/genres'
import { platformMap, platforms } from '@/data/platforms'
import { isPlatformEnabled } from '@/config/platforms'
import { gradientFor } from '@/lib/gradients'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { genreLabel, gameTitle } from '@/services/i18nData'
import type { Facets } from '@/services/pageData'
import type { Translation } from '@/locales'
import type { Game, Genre, GenreId, Platform } from '@/types'

/*
 * 这些区块一律不自己取数，数据由 HomePage 一次拉好再传进来。
 * 各区块各调各的 getXxxGames() 是 v1 的做法 —— 那时整个游戏库本来就在内存里，
 * 多调几次不花钱；v2 每次都是一趟网络请求，首屏会被拆成七八个并发。
 */

/** 名称、图标、配色这些是常量，仍旧从 src/data 读；facets 只负责补上「有多少款」 */
type PlatformWithCount = Platform & { count: number }
type GenreWithCount = Genre & { count: number }

/** 数量为 0 的平台不进首页入口 —— 点进去是空列表，不如不给 */
function platformsWithCount(facets: Facets | undefined): PlatformWithCount[] {
  const counts = new Map<string, number>(facets?.platforms.map((p) => [p.id, p.count] as const) ?? [])
  return (
    platforms
      // facets 是直接按数据库分组出来的，不认识前台的平台白名单，这道闸得自己关
      .filter((p) => isPlatformEnabled(p.id))
      .map((p) => ({ ...p, count: counts.get(p.id) ?? 0 }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.count - a.count)
  )
}

/** 顺序沿用 src/data/genres 的排列而不是按数量排，免得上新一款游戏首页的类型就换个位置 */
function genresWithCount(facets: Facets | undefined): GenreWithCount[] {
  const counts = new Map<string, number>(facets?.genres.map((g) => [g.id, g.count] as const) ?? [])
  return genres.map((g) => ({ ...g, count: counts.get(g.id) ?? 0 })).filter((g) => g.count > 0)
}

/* ---------------- 最多人玩 ---------------- */
export function PopularSection({ games }: { games: Game[] }) {
  const t = useT()
  return (
    <section className="container-x">
      <SectionHeader
        title={t.sections.popularTitle}
        subtitle={t.sections.popularSubtitle}
        icon="🔥"
        moreTo="/games?sort=popular"
      />
      <HScroll>
        {games.map((g, i) => (
          <GameCard key={g.slug} game={g} rank={i + 1} />
        ))}
      </HScroll>
    </section>
  )
}

/* ---------------- 按平台 ---------------- */
export function PlatformsSection({ facets }: { facets?: Facets }) {
  const t = useT()
  // 局部变量避开 platforms 这个名字：模块顶部的同名导入才是静态平台表
  const shown = platformsWithCount(facets).slice(0, 8)
  return (
    <section className="container-x">
      <SectionHeader title={t.sections.platformsTitle} subtitle={t.sections.platformsSubtitle} icon="🎮" moreTo="/platforms" />
      <HScroll itemClassName="w-52 sm:w-56">
        {shown.map((p) => (
          <PlatformCard key={p.id} platform={p} className="h-full" />
        ))}
      </HScroll>
    </section>
  )
}

/* ---------------- 最新上线 ---------------- */
export function LatestSection({ games }: { games: Game[] }) {
  const t = useT()
  return (
    <section className="container-x">
      <SectionHeader title={t.sections.latestTitle} subtitle={t.sections.latestSubtitle} icon="✨" moreTo="/games?sort=newest" />
      <HScroll itemClassName="w-64 sm:w-72">
        {games.map((g, i) => (
          <GameCardWide key={g.slug} game={g} isNew={i < 3} />
        ))}
      </HScroll>
    </section>
  )
}

/* ---------------- 一起玩 ---------------- */
export function TogetherSection({ games }: { games: Game[] }) {
  const t = useT()
  return (
    <section className="container-x">
      <SectionHeader
        title={t.sections.togetherTitle}
        subtitle={t.sections.togetherSubtitle}
        icon="👥"
        moreTo="/games?multiplayer=1"
      />
      <HScroll>
        {games.map((g) => (
          <GameCard key={g.slug} game={g} />
        ))}
      </HScroll>
    </section>
  )
}

/* ---------------- 赢取 G 币 ---------------- */
/**
 * FEATURES.coins 关着，首页现在没挂这一块，所以后端的首页数据里也没有对应的列表。
 * 留着是为了 G 币上线时不用重写：那时 loadHome() 补一组数据，这里直接传进来即可。
 */
export function CoinSection({ games }: { games: Game[] }) {
  const t = useT()
  return (
    <section className="container-x">
      <div className="rounded-3xl border border-coin/25 bg-gradient-to-br from-coin/10 via-transparent to-transparent p-5 sm:p-6">
        <SectionHeader
          title={t.sections.coinTitle}
          subtitle={t.sections.coinSubtitle}
          icon="🪙"
          moreTo="/games?coin=1"
        />
        <HScroll bleed={false}>
          {games.map((g) => (
            <GameCard key={g.slug} game={g} />
          ))}
        </HScroll>
      </div>
    </section>
  )
}

/* ---------------- 评分最高 ---------------- */
/* ---------------- 分类网格 ---------------- */
/** 每个类型一套固定渐变，色相各不相同，让大卡片彼此区分 */
const GENRE_GRADIENTS: Record<GenreId, string> = {
  action: 'linear-gradient(135deg, #ef4444 0%, #991b1b 100%)',
  fighting: 'linear-gradient(135deg, #fb923c 0%, #c2410c 100%)',
  shooter: 'linear-gradient(135deg, #22d3ee 0%, #0e7490 100%)',
  platformer: 'linear-gradient(135deg, #ec4899 0%, #9d174d 100%)',
  adventure: 'linear-gradient(135deg, #fbbf24 0%, #d97706 100%)',
  rpg: 'linear-gradient(135deg, #a78bfa 0%, #6d28d9 100%)',
  strategy: 'linear-gradient(135deg, #818cf8 0%, #3730a3 100%)',
  racing: 'linear-gradient(135deg, #60a5fa 0%, #1d4ed8 100%)',
  sports: 'linear-gradient(135deg, #4ade80 0%, #15803d 100%)',
  music: 'linear-gradient(135deg, #e879f9 0%, #a21caf 100%)',
  puzzle: 'linear-gradient(135deg, #2dd4bf 0%, #0f766e 100%)',
  card: 'linear-gradient(135deg, #fb7185 0%, #be123c 100%)',
}

/** 下方分栏里展示的类型（各挑 4 款游戏）——取游戏数量较多的几个，保证列表填满 */
const GENRE_COLUMNS: GenreId[] = ['action', 'adventure', 'rpg', 'puzzle']

export function GenreGridSection({
  facets,
  genreSamples,
}: {
  facets?: Facets
  genreSamples?: Record<string, Game[]>
}) {
  const lang = useLang()
  const t = useT()
  const genreList = genresWithCount(facets)
  // 服务端只给「确实有游戏」的类型建键，所以这里取不到就是这一栏没内容，整栏不渲染
  const columns = GENRE_COLUMNS.map((id) => ({ genre: genreMap[id], games: genreSamples?.[id] ?? [] })).filter((c) => c.games.length > 0)

  return (
    <section className="container-x">
      <SectionHeader title={t.sections.genreGridTitle} subtitle={t.sections.genreGridSubtitle} icon="🧭" moreTo="/genres" />

      {/* 大类型卡片：横向滑动 */}
      <HScroll itemClassName="w-64 sm:w-72">
        {genreList.map((g) => (
          <Link
            key={g.id}
            to={`/genres/${g.id}`}
            className="card-hover relative flex h-36 flex-col justify-end overflow-hidden rounded-card p-5"
            style={{ background: GENRE_GRADIENTS[g.id] ?? gradientFor(g.id) }}
          >
            <span className="pixel-grid absolute inset-0 opacity-25" aria-hidden />
            <span
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[6.5rem] leading-none opacity-25 mix-blend-soft-light select-none"
              aria-hidden
            >
              {g.icon}
            </span>
            <span className="relative text-2xl font-extrabold tracking-tight text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]">
              {genreLabel(t, g.id, g.name)}
            </span>
            <span className="relative mt-0.5 text-xs font-medium text-white/85">{fmt(t.common.gamesCount, { n: g.count })}</span>
          </Link>
        ))}
      </HScroll>

      {/* 分栏：每个类型列出几款样例（缩略图 + 标题 + 平台 + 查看） */}
      <div className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map(({ genre, games }) => (
          <div key={genre.id}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-base font-bold">
                <span aria-hidden>{genre.icon}</span>
                {genreLabel(t, genre.id, genre.name)}
              </h3>
              <Link to={`/genres/${genre.id}`} className="text-xs text-muted transition hover:text-brand-hover">
                {t.common.more}
              </Link>
            </div>
            <ul className="space-y-1">
              {games.map((g) => (
                <li key={g.slug}>
                  <Link to={`/games/${g.slug}`} className="group flex items-center gap-3 rounded-xl p-1.5 transition hover:bg-black/[0.04]">
                    <GameCover game={g} ratio="square" showTitle={false} showBadge={false} iconSize="sm" className="h-11 w-11 shrink-0 rounded-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold leading-tight">{gameTitle(g, lang)}</span>
                      <span className="block text-xs text-muted">{platformMap[g.platform]?.shortName}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold text-muted transition group-hover:bg-brand group-hover:text-white">
                      {t.common.view}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ---------------- 工具与扩展 ---------------- */
function toolsFor(t: Translation) {
  return [
    {
      icon: '🤸',
      tag: 'Pose Control',
      title: t.tools.motionTitle,
      desc: t.tools.motionDesc,
      to: '/apps',
      cta: t.tools.motionCta,
    },
    {
      icon: '🎙️',
      tag: 'Voice Control',
      title: t.tools.voiceTitle,
      desc: t.tools.voiceDesc,
      to: '/apps',
      cta: t.tools.voiceCta,
    },
    {
      icon: '🎬',
      tag: 'AI Video',
      title: t.tools.videoTitle,
      desc: t.tools.videoDesc,
      to: '/apps',
      cta: t.tools.videoCta,
    },
  ]
}

export function ToolsSection() {
  const t = useT()
  return (
    <section className="container-x">
      <SectionHeader title={t.sections.toolsTitle} subtitle={t.sections.toolsSubtitle} icon="🧰" />
      <div className="grid gap-4 md:grid-cols-3">
        {toolsFor(t).map((tool) => (
          <article
            key={tool.title}
            className="group relative overflow-hidden rounded-card border border-line bg-surface p-6 transition hover:border-brand/60"
          >
            <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-brand/15 blur-3xl transition group-hover:bg-brand/30" aria-hidden />
            <div className="relative">
              <span className="text-pixel text-[10px] text-brand-hover">{tool.tag}</span>
              <div className="mt-3 flex items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-soft text-2xl" aria-hidden>
                  {tool.icon}
                </span>
                <h3 className="text-lg font-bold">{tool.title}</h3>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted">{tool.desc}</p>
              <Button to={tool.to} variant="secondary" size="sm" className="mt-5">
                {tool.cta} →
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

/* ---------------- FAQ ---------------- */
export function FaqSection() {
  const t = useT()
  return (
    <section className="container-x">
      <div className="grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <SectionHeader title={t.sections.faqTitle} subtitle={t.sections.faqSubtitle} icon="❓" />
          <p className="text-sm leading-relaxed text-muted">
            {t.sections.faqHelper}
          </p>
          <div className="mt-4 flex gap-2">
            <Button to="/blog" variant="secondary" size="sm">
              {t.sections.faqReadBlog}
            </Button>
            <Button to="/about" variant="ghost" size="sm">
              {t.sections.faqAbout}
            </Button>
          </div>
        </div>
        <div className="lg:col-span-8">
          <Accordion items={t.faq} />
        </div>
      </div>
    </section>
  )
}
