/**
 * 游戏详情页（2026-11 新版设计稿）播放器下方的各个区块。
 *
 * 设计稿：Figma「8BitGo 游戏页 – Pokecatch」。颜色直接用设计稿的十六进制值（#40485b / #858891 /
 * #dfe4ea / #f44527 …）：它们来自另一套设计系统，和站点的绿色系令牌不是一一对应的，硬套令牌会走样。
 *
 * 数据边界（2026-11-18 和站长确认过的范围）：
 *   - 有真实数据的照常接：游玩数、正在玩（直播 + 联机房实时数）、评分、评论、相关推荐、推荐合集、开发商 logo；
 *   - 后端还没有数据的区块（贡献者、攻略、近期动态里的「谁做了什么」）显示**真实的空状态**，
 *     不放设计稿上的示例头像 / 示例文字，也不新增任何写入入口 —— 「写攻略」走联系邮箱。
 *   - 「近期动态」只用游戏本身带的时间戳（上线 / 资料更新 / 最新评论），不编造用户行为。
 *
 * 性能：这些区块都在首屏以下或右栏。需要额外请求的只有「正在玩」（页面空闲后再拉）和
 * 「推荐合集」（滚到附近才拉），都不阻塞首屏、不进 SSR。
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Collection, Game, Platform } from '@/types'
import { genreMap } from '@/data/genres'
import { fmt, useT } from '@/services/i18n'
import { genreLabel, platformLabel } from '@/services/i18nData'
import { romLanguageLabel } from '@/config/languages'
import { romUrlForKey } from '@/services/roms'
import { splitDevelopers } from '@/lib/developers'
import { cx, formatCount } from '@/lib/format'
import { InternalLink } from '@/components/ui/InternalLink'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'
import { GameCard } from './GameCard'
import { CollectionCard } from './CollectionCard'
import { listGameCollections } from '@/services/collections'
import { usePlayingNow } from '@/services/playingNow'
import { timeAgo } from '@/services/comments'
import { CONTACT_EMAIL } from '@/components/layout/Logo'
import playsIcon from '@/assets/game-detail/plays.svg?no-inline'
import playingNowIcon from '@/assets/game-detail/playing-now.svg?no-inline'

/* ---------------- 共用：区块标题 ---------------- */

/**
 * 「💡 攻略 / 你可能也喜欢 / 推荐合集」那种区块标题：20px 粗体 + 一行 14px 副标题，右侧可放一颗按钮。
 * 和站内 SectionHeader 的区别只在字号和字距（设计稿 -0.95px）；单独写一个，免得改动全站的标题。
 */
export function DetailSectionTitle({
  icon,
  title,
  subtitle,
  action,
  id,
}: {
  icon?: string
  title: string
  subtitle?: string
  action?: ReactNode
  id?: string
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 id={id} className="flex items-center gap-2 text-xl font-bold leading-7 tracking-[-0.95px] text-[#263329]">
          {icon && <span aria-hidden>{icon}</span>}
          <span className="truncate">{title}</span>
        </h2>
        {subtitle && <p className="pt-1 text-sm leading-5 tracking-[-0.15px] text-[#536354]">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** 设计稿那种 32px 高、2px #dfe4ea 描边、底部 4px 同色实心阴影的小按钮 */
export const DETAIL_PILL_BUTTON =
  'inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-2xl border-2 border-[#dfe4ea] bg-white px-3 text-xs font-bold text-[#263329] shadow-[0_4px_0_0_#dfe4ea] transition-[transform,box-shadow,background-color] duration-100 hover:bg-surface-2 active:translate-y-[3px] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

/* ---------------- 标题区 ---------------- */

/**
 * 支持语言的短码（设计稿写的是「CN,EN,JP」）。四格各 174px 宽、18px 字，完整语言名放不下。
 * 完整名仍然以 sr-only 文本和 title 出现在 HTML 里 —— 之前定过「SSR 正文要说清哪些语言 ROM 真正可选」，
 * 短码只是视觉上的缩写，不能让爬虫和读屏只读到「CN」。
 */
const LANG_SHORT: Record<string, string> = {
  'zh-Hans': 'CN',
  'zh-Hant': 'TW',
  en: 'EN',
  ja: 'JP',
  ko: 'KR',
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  it: 'IT',
  pt: 'PT',
  ru: 'RU',
}
function langShort(code: string): string {
  return LANG_SHORT[code] ?? (code.split('-')[0] ?? code).toUpperCase()
}

export function GameDetailHeading({
  game,
  title,
  platform,
  devices,
  actions,
}: {
  game: Game
  /** 当前语言下的标题（h1） */
  title: string
  platform: Platform
  /** 「电脑、手机和平板」那一句（由页面按运行时的触屏支持算好） */
  devices: string
  actions?: ReactNode
}) {
  const t = useT()
  return (
    <header>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold leading-8 tracking-[-0.35px] text-[#25282d] [overflow-wrap:anywhere] sm:text-[30px] sm:leading-9">
            {title}
          </h1>
          {title !== game.title && (
            <p className="mt-0.5 text-sm font-semibold tracking-[-0.35px] text-[#858891] [overflow-wrap:anywhere]">{game.title}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {(game.genres.length > 0 || game.adult) && (
          <div className="flex flex-wrap items-center gap-2">
            {game.genres.map((id) => (
              <Link
                key={id}
                to={`/genres/${id}`}
                className="inline-flex h-5 items-center gap-1 rounded-md bg-black/[0.06] px-1.5 text-[11px] font-semibold leading-4 tracking-[0.06px] text-[#263329] transition hover:bg-black/10"
              >
                {genreMap[id]?.icon && <span aria-hidden>{genreMap[id]?.icon}</span>}
                {genreLabel(t, id, genreMap[id]?.name ?? id)}
              </Link>
            ))}
            {game.adult && (
              <span className="inline-flex h-5 items-center rounded-md bg-live/15 px-1.5 text-[11px] font-semibold leading-4 text-live">
                {t.game.badgeAdult}
              </span>
            )}
          </div>
        )}
        <p className="flex flex-wrap items-center gap-x-[11px] gap-y-1 text-sm font-medium tracking-[-0.35px] text-[#858891]">
          {/*
            平台名是这一页唯一指向 /platforms/:id 的可抓取内链（原来平台卡上那个链接随设计稿去掉了），
            必须是真正的 <Link>，不能只是一段文字。
          */}
          <Link to={`/platforms/${platform.id}`} className="transition hover:text-brand-hover">
            {fmt(t.game.platformGame, { platform: platformLabel(t, platform.id, platform.name) })}
          </Link>
          <span aria-hidden className="size-1 rounded-full bg-[#d9d9d9]" />
          <span>{devices}</span>
        </p>
      </div>
    </header>
  )
}

/* ---------------- 简介：四格资料 ---------------- */

export function GameIntroFacts({
  game,
  developerLogos,
  players,
  romLangs,
}: {
  game: Game
  developerLogos?: Record<string, string>
  /** 本站在线房间支持人数或“不支持”，页面算好（CS1.6 那种特例在页面里处理） */
  players: string
  romLangs: string[]
}) {
  const t = useT()
  const developers = splitDevelopers(game.developer)
  const langs = Array.from(new Set(romLangs))
  const langFull = langs.map((l) => romLanguageLabel(l)).join(' · ')
  const items: Array<{ key: string; label: string; value: ReactNode; title?: string }> = [
    {
      key: 'developer',
      label: t.game.developer,
      title: developers.join(', ') || undefined,
      value: developers.length ? (
        <span className="inline-flex max-w-full items-center justify-center gap-2">
          {developerLogos?.[developers[0]!] && (
            <DeveloperLogo src={romUrlForKey(developerLogos[developers[0]!]!)} />
          )}
          <span className="truncate">
            {developers.map((name, index) => (
              <span key={name}>
                {index > 0 && ', '}
                <InternalLink to={`/games?developer=${encodeURIComponent(name)}`} className="transition hover:text-brand-hover">
                  {name}
                </InternalLink>
              </span>
            ))}
          </span>
        </span>
      ) : (
        '—'
      ),
    },
    { key: 'year', label: t.game.year, value: game.year > 0 ? String(game.year) : '—' },
    { key: 'players', label: t.game.playersLabel, value: players },
    {
      key: 'langs',
      label: t.game.supportedLanguages,
      title: langFull || undefined,
      value: langs.length ? (
        <>
          {/* 174px 一格放不下八个码：超过四种只摆前三个 + 「+N」，完整名在 title 和 sr-only 里 */}
          <span aria-hidden>
            {langs.length > 4 ? `${langs.slice(0, 3).map(langShort).join(',')} +${langs.length - 3}` : langs.map(langShort).join(',')}
          </span>
          <span className="sr-only">{langFull}</span>
        </>
      ) : (
        '—'
      ),
    },
  ]
  return (
    <dl className="grid grid-cols-2 gap-y-4 sm:flex sm:items-center sm:justify-between">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && <span aria-hidden className="hidden h-3.5 w-px shrink-0 bg-[#dfe4ea] sm:block" />}
          <div className="flex min-w-0 flex-col items-center px-2 text-center sm:flex-1" title={item.title}>
            <dt className="text-sm font-semibold tracking-[-0.35px] text-[#858891]">{item.label}</dt>
            <dd className="max-w-full truncate text-lg font-semibold tracking-[-0.35px] text-[#25282d]">{item.value}</dd>
          </div>
        </Fragment>
      ))}
    </dl>
  )
}

/** 开发商 logo（设计稿 20px、7px 圆角）。图挂了就整块不画，不留一个裂图图标 */
function DeveloperLogo({ src }: { src: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  if (broken || !src) return null
  return (
    <img
      src={src}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className="size-5 shrink-0 rounded-[7px] object-cover"
    />
  )
}

/* ---------------- 贡献者 ---------------- */

/**
 * 贡献者：设计稿是「发布者 / 多语言 / 玩家」三组头像。后端目前没有任何贡献记录
 * （上传 ROM、写简介、翻译都没记是谁做的），所以只放标题和一句真实的空状态 ——
 * 不放示例头像，也不拿游玩数冒充「玩家贡献者」。
 */
export function ContributorsSection() {
  const t = useT()
  return (
    <section aria-labelledby="game-contributors">
      <div className="flex items-center justify-between">
        <h2 id="game-contributors" className="text-base font-semibold leading-[21px] tracking-[-0.31px] text-[#40485b]">
          {t.game.contributorsTitle}
        </h2>
      </div>
      <p className="mt-3 text-sm leading-5 tracking-[-0.15px] text-[#8c92a4]">{t.game.contributorsEmpty}</p>
    </section>
  )
}

/* ---------------- 攻略 ---------------- */

/**
 * 攻略：还没有投稿 / 审核系统（2026-11 决定先不做写入入口），「写攻略」打开写给站长的邮件。
 * 用 mailto 而不是站内表单：表单就得有存储、审核、防刷，那是一整套新功能。
 */
export function GuidesSection({ gameTitle }: { gameTitle: string }) {
  const t = useT()
  const subject = fmt(t.game.guidesMailSubject, { title: gameTitle })
  return (
    <section aria-labelledby="game-guides">
      <DetailSectionTitle
        id="game-guides"
        icon="💡"
        title={t.game.guidesTitle}
        subtitle={t.game.guidesSubtitle}
        action={
          <a href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`} title={t.game.guidesWriteHint} className={DETAIL_PILL_BUTTON}>
            <span aria-hidden>✏️</span>
            {t.game.guidesWrite}
          </a>
        }
      />
      <div className="mt-4 grid h-[111px] place-items-center rounded-[14px] border border-dashed border-[#dfe4ea] px-4 text-center text-sm leading-5 tracking-[-0.15px] text-[#536354]">
        {t.game.guidesEmpty}
      </div>
    </section>
  )
}

/* ---------------- 你可能也喜欢 / 推荐合集 ---------------- */

/**
 * 卡片网格：设计稿每张卡 214px、间距 14px、靠左排。窄屏两列平分；
 * sm 起按 214px 自动填充，773px 宽的正文列正好三张（和设计稿一致），更宽的屏自然多放几张。
 */
const CARD_GRID = 'grid grid-cols-2 gap-3.5 sm:grid-cols-[repeat(auto-fill,minmax(0,214px))]'

export function RelatedGamesSection({ related }: { related: Game[] }) {
  const t = useT()
  const gridRef = useRef<HTMLDivElement>(null)
  const [coversReady, setCoversReady] = useState(false)
  useEffect(() => {
    if (!related.length) return
    const grid = gridRef.current
    if (!grid || typeof IntersectionObserver !== 'function') {
      setCoversReady(true)
      return
    }
    // 浏览器原生 loading="lazy" 通常会提前数百到上千像素取图；推荐封面不是开局必需资源，等卡片真正入视口再放行。
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setCoversReady(true)
      observer.disconnect()
    })
    observer.observe(grid)
    return () => observer.disconnect()
  }, [related.length])
  if (!related.length) return null
  return (
    <section aria-labelledby="game-related">
      <DetailSectionTitle id="game-related" icon="💡" title={t.game.relatedTitle} subtitle={t.game.relatedSubtitle} />
      <div ref={gridRef} className={cx(CARD_GRID, 'mt-6')}>
        {related.map((g) => (
          <GameCard key={g.slug} game={g} showCoin={false} deferCover={!coversReady} coverSizes="214px" />
        ))}
      </div>
    </section>
  )
}

/**
 * 推荐合集：收录了这款游戏的公开合集。
 *
 * 首屏以下才出现，所以**滚到附近（400px）才取数**：大多数访客看完简介就开始玩了，
 * 没必要每个人都多一次请求。取数失败只显示一句提示，不打扰页面其余部分。
 */
export function GameCollectionsSection({ gameSlug }: { gameSlug: string }) {
  const t = useT()
  const ref = useRef<HTMLElement>(null)
  const [state, setState] = useState<{ slug: string; status: 'idle' | 'loading' | 'ready' | 'error'; items: Collection[] }>({
    slug: gameSlug,
    status: 'idle',
    items: [],
  })
  const current = state.slug === gameSlug ? state : { slug: gameSlug, status: 'idle' as const, items: [] }

  useEffect(() => {
    const node = ref.current
    if (!node) return
    let disposed = false
    let controller: AbortController | null = null
    const load = () => {
      if (disposed) return
      controller = new AbortController()
      setState({ slug: gameSlug, status: 'loading', items: [] })
      listGameCollections(gameSlug, 6, controller.signal)
        .then((page) => {
          if (!disposed) setState({ slug: gameSlug, status: 'ready', items: page.items ?? [] })
        })
        .catch(() => {
          if (!disposed && !controller?.signal.aborted) setState({ slug: gameSlug, status: 'error', items: [] })
        })
    }
    if (typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        disposed = true
        controller?.abort()
      }
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          load()
        }
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(node)
    return () => {
      disposed = true
      io.disconnect()
      controller?.abort()
    }
  }, [gameSlug])

  return (
    <section ref={ref} aria-labelledby="game-collections">
      <DetailSectionTitle id="game-collections" icon="💡" title={t.game.collectionsTitle} subtitle={t.game.collectionsSubtitle} />
      {current.status === 'ready' && current.items.length > 0 ? (
        <div className={cx(CARD_GRID, 'mt-6')}>
          {current.items.map((c) => (
            <CollectionCard key={c.id} collection={c} />
          ))}
        </div>
      ) : current.status === 'ready' || current.status === 'error' ? (
        <div className="mt-6 flex min-h-[111px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-[#dfe4ea] px-4 text-center text-sm leading-5 text-[#536354]">
          <p>{current.status === 'error' ? t.game.collectionsLoadFailed : t.game.collectionsEmpty}</p>
          <Link to="/collections" className="font-semibold text-brand-hover underline-offset-4 hover:underline">
            {t.game.collectionsBrowse}
          </Link>
        </div>
      ) : (
        <div className={cx(CARD_GRID, 'mt-6')} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <SkeletonBlock key={i} className={cx('aspect-[3/4] rounded-2xl', i === 2 && 'max-sm:hidden')} />
          ))}
        </div>
      )}
    </section>
  )
}

/* ---------------- 右栏：游玩数据 + 评分 ---------------- */

/**
 * 右栏第一张卡：上半是「次游玩 / 正在玩」，下半由页面塞评分（GameRating variant="card"）。
 * 设计稿是上下两块拼起来的（各自一圈 #dce3e8 描边），这里用一张卡 + 中间一条分隔线画出同样的效果。
 */
export function GameStatsCard({ game, children }: { game: Game; children?: ReactNode }) {
  const t = useT()
  const playing = usePlayingNow(game.slug)
  return (
    <section
      aria-label={`${formatCount(game.plays)} ${t.game.playsLabel} · ${t.game.playingNowLabel}`}
      className="overflow-hidden rounded-2xl border border-[#dce3e8] bg-white shadow-[0_4px_5px_rgba(0,0,0,0.05)]"
    >
      <div className="flex items-center justify-between gap-3 p-6">
        <Stat icon={playsIcon} iconSize={55} value={formatCount(game.plays)} label={t.game.playsLabel} hint={t.game.playsHint} />
        <span aria-hidden className="h-[31px] w-px shrink-0 bg-[#dce3e8]" />
        <Stat
          icon={playingNowIcon}
          iconSize={47}
          value={playing === null ? '—' : formatCount(playing)}
          label={t.game.playingNowLabel}
          hint={t.game.playingNowHint}
          live
        />
      </div>
      {children && <div className="border-t border-[#dce3e8]">{children}</div>}
    </section>
  )
}

function Stat({
  icon,
  iconSize,
  value,
  label,
  hint,
  live,
}: {
  icon: string
  iconSize: number
  value: string
  label: string
  hint: string
  live?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-3" title={hint}>
      <img src={icon} alt="" width={iconSize} height={iconSize} draggable={false} className="shrink-0" />
      <div className="min-w-0 tracking-[-0.31px]">
        <p
          className="truncate text-2xl font-semibold leading-[21px] tabular-nums text-[#40485b]"
          // 实时数字变化时读屏只播报这一格，不打断别的
          aria-live={live ? 'polite' : undefined}
        >
          {value}
        </p>
        <p className="mt-1 truncate text-base font-semibold leading-[21px] text-[#858891]">{label}</p>
      </div>
    </div>
  )
}

/* ---------------- 右栏：近期动态 ---------------- */

/**
 * 近期动态。设计稿是「管理员上传了某语言 ROM / 某玩家玩了」这类按人记的流水，后端没有这份记录；
 * 这里只列游戏本身带的三个真实时间点（上线、资料更新、最新评论），最多三条，所以没有「加载更多」。
 * 「资料更新」只在比上线晚一天以上时才算 —— 上架当天的编辑不值得单列一条。
 */
export function GameActivity({ game, showComments }: { game: Game; showComments: boolean }) {
  const t = useT()
  const DAY = 24 * 60 * 60 * 1000
  const added = Date.parse(game.addedAt)
  const updated = game.updatedAt ? Date.parse(game.updatedAt) : NaN
  const commented = showComments && game.lastCommentAt ? Date.parse(game.lastCommentAt) : NaN
  const events: Array<{ key: string; at: number; iso: string; icon: string; text: string }> = []
  if (Number.isFinite(commented)) events.push({ key: 'comment', at: commented, iso: game.lastCommentAt!, icon: '💬', text: t.game.activityComment })
  if (Number.isFinite(updated) && (!Number.isFinite(added) || updated - added > DAY)) {
    events.push({ key: 'updated', at: updated, iso: game.updatedAt!, icon: '📝', text: t.game.activityUpdated })
  }
  if (Number.isFinite(added)) events.push({ key: 'added', at: added, iso: game.addedAt, icon: '🎮', text: t.game.activityAdded })
  events.sort((a, b) => b.at - a.at)

  return (
    <section aria-labelledby="game-activity" className="py-8">
      <h2 id="game-activity" className="text-base font-semibold leading-[21px] tracking-[-0.31px] text-[#25282d]">
        {t.game.activityTitle}
      </h2>
      {events.length ? (
        <ul className="pt-0.5">
          {events.map((e) => (
            <li key={e.key} className="flex items-center gap-[7px] py-4">
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-xl bg-[#f2f4f8] text-[13px]">
                {e.icon}
              </span>
              <p className="min-w-0 flex-1 text-sm leading-5 tracking-[-0.15px] text-[#25282d]">
                {e.text}
                {/* 时间用 <time>，机器可读；文字是相对时间（一个月以上换成日期），和评论区同一套格式 */}
                <time dateTime={e.iso} className="ml-2 text-xs text-[#8c92a4]" suppressHydrationWarning>
                  {timeAgo(e.iso)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pt-4 text-sm text-[#8c92a4]">{t.game.activityEmpty}</p>
      )}
    </section>
  )
}
