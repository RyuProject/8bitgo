import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { PlatformWithCount } from '@/services/games'
import { usePageData, type DevelopersData, type GenresData, type PlatformsData } from '@/services/pageData'
import { platforms, platformMap } from '@/data/platforms'
import { genres } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { cx } from '@/lib/format'
import { useSeo, breadcrumbSchema } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { gameDescription, gameTitle, genreDesc, genreLabel } from '@/services/i18nData'
import { useLang } from '@/services/lang'
import { romUrlForKey } from '@/services/roms'
import { PlatformCard } from '@/components/game/PlatformCard'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'

/**
 * 平台 / 类型 / 开发商三个总览页。
 *
 * 这三页要的只是「每一项底下有多少款游戏」，后端把它算成 facets 一次回来，
 * 不用再为了数数把整个游戏库拉到浏览器里。
 *
 * 平台和类型本身（名称、图标、描述、是否对外开放）仍然是代码里的配置，
 * facets 只补上数量 —— 所以一个刚上线、还没有游戏的平台也照样会出现在列表里。
 */

function PageIntro({ eyebrow, title, desc }: { eyebrow: string; title: string; desc: string }) {
  return (
    <div className="max-w-2xl">
      <span className="text-pixel text-[11px] text-brand-hover">{eyebrow}</span>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{title}</h1>
      <p className="mt-3 leading-relaxed text-muted">{desc}</p>
    </div>
  )
}

/** 数量还没回来时的卡片占位：撑住和真实卡片相近的高度，数据到位时页面不会跳一下 */
function CardGridSkeleton({ count, grid, height }: { count: number; grid: string; height: string }) {
  return (
    <div className={grid} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cx('flex gap-4 rounded-card border border-line bg-surface p-4', height)}>
          <SkeletonBlock className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 pt-1">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="mt-3 h-3 w-full" />
            <SkeletonBlock className="mt-2 h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

function LoadError({ message }: { message: string }) {
  return (
    <p className="mt-8 text-sm text-muted" role="alert">
      {message}
    </p>
  )
}

/** id → 数量。查不到当 0：平台和类型是配置里就有的，只是还没上架游戏。 */
function countsOf(rows: Array<{ id: string; count: number }> | undefined): Map<string, number> {
  return new Map(rows?.map((r) => [r.id, r.count]))
}

const PLATFORM_GRID = 'mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4'
const GENRE_GRID = 'mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4'
const DEVELOPER_GRID = 'mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3'

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
  const state = usePageData<PlatformsData>('/platforms', undefined, 'platforms')
  const facets = state.data?.facets
  const counts = countsOf(facets?.platforms)
  // 开放哪些平台是配置说了算，和后端有没有数据无关 ——
  // 所以「共 N 个平台」这句话不用等取数，首帧就是对的
  const enabled = platforms.filter((p) => isPlatformEnabled(p.id))
  const cards: PlatformWithCount[] = enabled
    .map((p) => ({ ...p, count: counts.get(p.id) ?? 0 }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="container-x py-8 sm:py-10">
      <PageIntro
        eyebrow="PLATFORMS"
        title={t.browse.platformsTitle}
        desc={fmt(t.browse.platformsDesc, { n: enabled.length })}
      />
      {state.status === 'error' ? (
        <LoadError message={state.error} />
      ) : !facets ? (
        <CardGridSkeleton count={enabled.length} grid={PLATFORM_GRID} height="h-44" />
      ) : (
        <div className={PLATFORM_GRID}>
          {cards.map((p) => (
            <PlatformCard key={p.id} platform={p} />
          ))}
        </div>
      )}
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
  const state = usePageData<GenresData>('/genres', undefined, 'genres')
  const facets = state.data?.facets
  const counts = countsOf(facets?.genres)

  return (
    <div className="container-x py-8 sm:py-10">
      <PageIntro eyebrow="GENRES" title={t.browse.genresTitle} desc={t.browse.genresDesc} />
      {state.status === 'error' ? (
        <LoadError message={state.error} />
      ) : !facets ? (
        <CardGridSkeleton count={genres.length} grid={GENRE_GRID} height="h-52" />
      ) : (
        <div className={GENRE_GRID}>
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
              <p className="mt-3 text-sm font-semibold text-brand-hover">
                {fmt(t.common.gamesCountArrow, { n: counts.get(g.id) ?? 0 })}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- 开发商 ---------------- */
export function DevelopersPage() {
  const t = useT()
  const lang = useLang()
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
  const state = usePageData<DevelopersData>('/developers', undefined, 'developers')
  // 开发商不是配置，只能等 facets：名单和数量都由后端 GROUP BY 出来（已按数量倒序）
  const developers = state.data?.facets.developers
  const [brokenCover, setBrokenCover] = useState<Record<string, true>>({})

  return (
    <div className="container-x py-8 sm:py-10">
      <PageIntro
        eyebrow="DEVELOPERS"
        title={t.browse.developersTitle}
        // 家数要等名单回来才知道，先留空，免得闪一个「共 0 家」
        desc={developers ? fmt(t.browse.developersDesc, { n: developers.length }) : ''}
      />
      {state.status === 'error' ? (
        <LoadError message={state.error} />
      ) : !developers ? (
        <CardGridSkeleton count={12} grid={DEVELOPER_GRID} height="h-[88px]" />
      ) : (
        <div className={DEVELOPER_GRID}>
          {developers.map((d) => {
            // 三级回退，和后台那一页的预览完全一致：
            //   后台填的 logo → 代表作封面 → emoji 占位
            // 两者存的都是对象 key（logos/xxx.png、covers/xxx.webp），直接塞进 src 会
            // 404 裂图，必须先拼成公开地址 —— 跟 GameCover 的做法保持一致。
            const image = d.logo || d.topGame?.cover || ''
            const cover = image && !brokenCover[d.name] ? romUrlForKey(image) : ''
            // 后台写了简介就顶掉「平台 · 代表作」那行：管理员特地写的一句话，
            // 比一个游戏名更值得占这个位置。
            const desc = gameDescription(d, lang)
            return (
            <Link
              key={d.name}
              to={`/games?developer=${encodeURIComponent(d.name)}`}
              className="group card-hover flex items-center gap-4 rounded-card border border-line bg-surface p-3 hover:border-brand/60"
            >
              {/*
                封面用该开发商的「代表作」（游玩次数最高的那款）。
                这一项由后端在同一条 facets 查询里用窗口函数一起算出来 ——
                不是把每个开发商的游戏各查一遍，那才是 v2 要去掉的做法。
                还没有代表作（比如所有作品都下架了）就退回图标占位。
              */}
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  width={64}
                  height={64}
                  // 图挂了（key 写错、文件被删）就记下来，下一帧换成图标占位；
                  // 不处理的话浏览器会画一整页默认裂图。
                  onError={() => setBrokenCover((prev) => (prev[d.name] ? prev : { ...prev, [d.name]: true }))}
                  className="h-16 w-16 shrink-0 rounded-lg bg-brand-soft object-cover"
                />
              ) : (
                <span
                  className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-brand-soft text-2xl"
                  aria-hidden
                >
                  {d.topGame?.icon ?? '🏢'}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-bold">{d.name}</h2>
                {desc ? (
                  <p className="mt-0.5 truncate text-xs text-muted" title={desc}>
                    {desc}
                  </p>
                ) : (
                  d.topGame && (
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {platformMap[d.topGame.platform]?.shortName ?? d.topGame.platform} ·{' '}
                      {gameTitle(d.topGame, lang)}
                    </p>
                  )
                )}
              </div>
              <span className="text-pixel shrink-0 text-[11px] text-brand-hover">{fmt(t.browse.countSuffix, { n: d.count })}</span>
            </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
