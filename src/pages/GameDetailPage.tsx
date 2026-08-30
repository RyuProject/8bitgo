import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { recordRecent, toggleFavorite, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import type { RomLang } from '@/config/languages'
import { romLangsOf, useRomUrl } from '@/services/roms'
import { resolveRuntime, runtimesFor } from '@/emulator'
import { usePageData, type GameData } from '@/services/pageData'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { isPlatformEnabled } from '@/config/platforms'
import { getDefaultKeymap } from '@/lib/emulator'
import { formatCount, formatPlayers } from '@/lib/format'
import { usePlatformBiosUrl } from '@/services/platformBios'
import { useSeo, breadcrumbSchema, videoGameSchema } from '@/services/seo'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'
import { gameDescription, gameTitle, genreLabel, platformDesc, platformLabel } from '@/services/i18nData'
import { EmulatorPlayer } from '@/emulator'
import { GameCover } from '@/components/game/GameCover'
import { GameAgeGuard } from '@/components/game/AgeGate'
import { GameCard } from '@/components/game/GameCard'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SkeletonBlock } from '@/components/ui/PageSkeleton'
import { NotFoundPage } from './NotFoundPage'
import { useShell } from '@/components/layout/ShellContext'
import { cx } from '@/lib/format'
import { FEATURES } from '@/config/features'
import { splitDevelopers } from '@/lib/developers'

export function GameDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [searchParams] = useSearchParams()
  // ?p2p= 是 P2P 邀请链接；?room= 是云端房间（付费通道）
  const invite = searchParams.get('p2p') ?? undefined
  const cloudInvite = searchParams.get('room') ?? undefined
  // 从「直播」进来的：默认只看不玩
  const watchOnly = searchParams.get('watch') === '1'
  // ?live= 是「一人玩多人看」的直播间（和联机房的观众席不是一回事）
  const liveInvite = searchParams.get('live') ?? undefined
  const t = useT()
  // 详情页要的就是这一款游戏和它的相关推荐，由后端一次给全 ——
  // v1 是把整个游戏库拉进内存再 find(slug)，几千款时光是首屏就得下载整个目录
  const state = usePageData<GameData>(`/games/${encodeURIComponent(slug)}`, undefined, 'game')
  // data.game 为 null 表示后端确认没有这款游戏；undefined 是「还没拿到」，两者不能混为一谈
  const game = state.data?.game ?? undefined
  const related = state.data?.related ?? []
  const { immersive } = useShell()
  const user = useCurrentUser()
  const [copied, setCopied] = useState(false)
  const isFav = Boolean(user?.favorites.includes(slug))
  /**
   * 玩家手动选的 ROM 语言（null = 跟着站点语言走）。
   * 换游戏时要清掉，否则上一款选的「日本語」会带到下一款上。
   */
  const [romLang, setRomLang] = useState<RomLang | null>(null)
  useEffect(() => setRomLang(null), [slug])
  const rom = useRomUrl(game, romLang)
  /** 这款游戏绑了哪几种语言的 ROM；少于两种时播放器不显示切换入口 */
  const romLangs = game ? romLangsOf(game) : []

  // 记录最近浏览。依赖只看 slug：重新取数会得到一个全新的 game 对象，
  // 按对象比较会让同一款游戏被重复记一次
  useEffect(() => {
    if (game) void recordRecent(game.slug)
  }, [game?.slug])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])

  // SEO：hook 必须在下面的 early return 之前调用，所以「还没取到」和「确实没有」都要在这里各给一套
  const lang = useLang()
  const seoTitle = game ? gameTitle(game, lang) : ''
  const seoPlatform = game ? platformMap[game.platform] : undefined
  const seoPlatformName = seoPlatform ? platformLabel(t, seoPlatform.id, seoPlatform.name) : ''
  // 平台级 BIOS。必须在下面那几个 early return 之前调 —— hook 的调用顺序每次渲染都要一致。
  // 异步到货，第一帧一般是空串；播放器只在挂载引擎那一刻读它，不会因此重启游戏
  const biosUrl = usePlatformBiosUrl(seoPlatform?.id)
  // SEO 描述也要跟语言走：英文页面挂一段中文 meta description，
  // 搜索结果里就是一串看不懂的字，等于白写
  const seoDesc = game ? plainText(gameDescription(game, lang)) : ''
  useSeo(
    game
      ? {
          title: fmt(t.game.docTitle, { title: seoTitle }),
          // 优先用游戏自己的简介，没有再套通用模板
          description: seoDesc || fmt(t.seo.gameDesc, { title: seoTitle, platform: seoPlatformName }),
          image: game.cover,
          publishedTime: game.addedAt,
          updatedTime: game.updatedAt || game.addedAt,
          jsonLd: [
            videoGameSchema({
              name: seoTitle,
              slug: game.slug,
              description: seoDesc,
              image: game.cover,
              platform: seoPlatformName,
              genres: game.genres.map((id) => genreLabel(t, id, genreMap[id]?.name ?? id)),
              year: game.year,
              developer: game.developer,
            }),
            breadcrumbSchema([
              { name: t.common.home, path: '/' },
              { name: t.common.library, path: '/games' },
              { name: seoTitle, path: `/games/${game.slug}` },
            ]),
          ],
        }
      : state.status === 'ready'
        ? // 后端明确说了没有这款游戏
          { title: t.game.notFoundTitle, noindex: true }
        : // 还在取数：先用站点默认标题，别急着挂 noindex ——
          // 那会让「先渲染骨架、后拿到数据」的爬虫读到一个不该有的 noindex
          {},
  )

  // 数据是异步来的，游戏还没到手不代表它不存在，否则每次进详情页都会先闪一下 404
  if (!game) {
    if (state.status === 'error') return <LoadError message={state.error} />
    if (state.status === 'loading') return <DetailSkeleton />
    return <NotFoundPage message={t.game.notFoundMsg} />
  }

  // platform 是数据库里存的值：可能是代码不认识的，也可能是还没对外开放的（见 config/platforms）。
  // v1 在取数时就把这两种情况滤掉了，v2 由后端直接按 slug 回，得在这里挡：
  // 不挡的话下面每一处 platform.xxx 都会把整页带崩。
  if (!seoPlatform || !isPlatformEnabled(seoPlatform.id)) return <NotFoundPage message={t.game.notFoundMsg} />
  const platform = seoPlatform
  // 没有具体文件时，按优先级取该平台实际会用的引擎 —— 跟 PlayLocalPage 的选法一致。
  // 只用 resolveRuntime(platform.id) 会走到「平台默认引擎」那一档（platforms.ts 的 runtime
  // 字段），显示的是兜底引擎而不是真正会跑的那个：NDS 装了 webretro 仍写着 EmulatorJS，
  // NES 明明由 jsnes 接管也一样。
  const runtime = runtimesFor(platform.id)[0] ?? resolveRuntime(platform.id)

  return (
    <div className="container-x py-6 sm:py-8">
      {/* 面包屑 */}
      <nav className="mb-4 text-xs text-muted" aria-label={t.common.breadcrumb}>
        <Link to="/" className="hover:text-fg">
          {t.common.home}
        </Link>
        <span className="mx-1.5">/</span>
        <Link to="/games" className="hover:text-fg">
          {t.common.library}
        </Link>
        <span className="mx-1.5">/</span>
        <Link to={`/platforms/${platform.id}`} className="hover:text-fg">
          {platformLabel(t, platform.id, platform.name)}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-fg">{seoTitle}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-12">
        {/* 主区域：沉浸模式下占满整行并按视口高度居中 */}
        <div className={immersive ? 'lg:col-span-12' : 'lg:col-span-8'}>
          <div className={cx(immersive && 'mx-auto max-w-[calc((100dvh-7rem)*16/9)]')}>
            <GameAgeGuard
              slug={game.slug}
              markedAdult={Boolean(game.adult)}
              backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
            >
              <EmulatorPlayer
                key={game.slug}
                platform={platform}
                gameName={game.title}
                gameSlug={game.slug}
                maxPlayers={game.players}
                invite={invite}
                cloudInvite={cloudInvite}
                watch={watchOnly}
                liveInvite={liveInvite}
                icon={game.icon}
                // 这一款指定的核心（街机尤其需要），以及平台级 BIOS（Neo Geo 缺了起不来）
                core={game.core}
                dosExecutable={game.dosExecutable}
                dosBackend={game.dosBackend}
                biosUrl={biosUrl || undefined}
                romUrl={rom.status === 'found' ? rom.url : undefined}
                romChecking={rom.status === 'checking'}
                romUnavailable={rom.status === 'missing'}
                romLangs={romLangs}
                romLang={rom.lang}
                onRomLangChange={setRomLang}
                backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} priority className="h-full w-full" />}
              />
            </GameAgeGuard>
          </div>

          {/* 标题与元信息 */}
          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{seoTitle}</h1>
              {seoTitle !== game.title && <p className="mt-1 text-sm text-muted">{game.title}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link to={`/platforms/${platform.id}`}>
                  <Badge tone="brand" className="text-xs">
                    {platform.icon} {platformLabel(t, platform.id, platform.name)}
                  </Badge>
                </Link>
                {game.genres.map((id) => (
                  <Link key={id} to={`/genres/${id}`}>
                    <Badge className="text-xs">
                      {genreMap[id]?.icon} {genreLabel(t, id, genreMap[id]?.name ?? id)}
                    </Badge>
                  </Link>
                ))}
                {rom.status === 'found' && <Badge tone="online" className="text-xs">{t.common.instantPlay}</Badge>}
                {game.multiplayer && <Badge tone="online" className="text-xs">{t.game.badgeMultiplayer}</Badge>}
                {game.bodyControl && <Badge tone="coin" className="text-xs">{t.game.badgeBodyControl}</Badge>}
                {game.adult && <Badge tone="live" className="text-xs">{t.game.badgeAdult}</Badge>}
                <CoinBadge amount={game.coinReward} className="text-xs" />
              </div>
            </div>
            {game.plays > 0 && (
              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                <span className="text-xs text-muted">{fmt(t.common.playsCount, { n: formatCount(game.plays) })}</span>
              </div>
            )}
          </div>

          {/* 动作按钮 */}
          <div className="mt-5 flex flex-wrap gap-2">
            {user ? (
              <Button variant={isFav ? 'primary' : 'secondary'} size="sm" onClick={() => void toggleFavorite(game.slug).catch(() => {})} aria-pressed={isFav}>
                {isFav ? t.game.favorited : t.game.favorite}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={openAuthModal}>
                {t.game.favorite}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href)
                  setCopied(true)
                } catch {
                  /* 剪贴板不可用时忽略 */
                }
              }}
            >
              {copied ? t.game.copied : t.game.share}
            </Button>
            {game.multiplayer && (
              <Button variant="secondary" size="sm" to="/games?multiplayer=1">
                {t.game.createRoom}
              </Button>
            )}
            <Button variant="ghost" size="sm" to="/blog">
              {t.game.report}
            </Button>
          </div>

          {/* 简介 */}
          <section className="mt-8">
            <h2 className="text-lg font-bold">{t.game.about}</h2>
            <GameDescription
              key={`${game.slug}:${lang}`}
              description={gameDescription(game, lang)}
              showMore={t.game.showMore}
              showLess={t.game.showLess}
            />
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Meta label={t.game.year} value={String(game.year)} />
              <Meta
                label={t.game.developer}
                value={splitDevelopers(game.developer).map((name, index) => (
                  <span key={name}>
                    {index > 0 && ', '}
                    <Link to={`/games?developer=${encodeURIComponent(name)}`} className="hover:text-brand-hover">
                      {name}
                    </Link>
                  </span>
                ))}
              />
              <Meta label={t.game.players} value={formatPlayers(game.players)} />
              <Meta label={t.game.runtime} value={runtime ? `${runtime.name} · ${runtime.engineLabel(platform.id)}` : t.game.unsupported} />
            </dl>
            {game.tags && game.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {game.tags.map((t) => (
                  <Link
                    key={t}
                    to={`/games?q=${encodeURIComponent(t)}`}
                    className="rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:border-brand hover:text-fg"
                  >
                    #{t}
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* 操作说明 */}
          <section className="mt-8">
            <h2 className="text-lg font-bold">{t.game.controls}</h2>
            <p className="mt-1 text-sm text-muted">{t.game.controlsDesc}</p>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {getDefaultKeymap(runtime?.id).map((k) => (
                <div key={k.button} className="rounded-xl border border-line bg-surface px-3 py-2.5">
                  <p className="text-[11px] text-muted">{k.button}</p>
                  <p className="mt-1 font-mono text-sm font-semibold">{k.key}</p>
                </div>
              ))}
              <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
                <p className="text-[11px] text-muted">{t.game.saveState}</p>
                <p className="mt-1 font-mono text-sm font-semibold">{t.game.menuButton}</p>
              </div>
            </div>
          </section>
        </div>

        {/* 侧栏 */}
        <aside className={cx('space-y-8 lg:col-span-4', immersive && 'hidden')}>
          <div className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <span
                className="grid h-12 w-12 place-items-center rounded-xl text-2xl"
                style={{ background: `${platform.color}22`, border: `1px solid ${platform.color}55` }}
                aria-hidden
              >
                {platform.icon}
              </span>
              <div>
                <p className="font-bold">{platformLabel(t, platform.id, platform.name)}</p>
                <p className="text-xs text-muted">
                  {platform.manufacturer} · {platform.year}
                </p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">{platformDesc(t, platform.id, platform.description)}</p>
            <Button to={`/platforms/${platform.id}`} variant="secondary" size="sm" className="mt-4 w-full">
              {fmt(t.game.browsePlatform, { platform: platform.shortName })}
            </Button>
          </div>

          {FEATURES.coins && (
          <div className="rounded-2xl border border-coin/30 bg-gradient-to-br from-coin/10 to-transparent p-5">
            <p className="text-pixel text-[11px] text-coin">G COIN</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {game.coinReward > 0
                ? fmt(t.game.coinReward, {
                    n: game.coinReward,
                    suffix: user ? t.game.coinSuffixIn : t.game.coinSuffixOut,
                  })
                : t.game.coinNone}
            </p>
            {user ? (
              <p className="mt-4 text-sm font-semibold text-coin">
                {fmt(t.game.coinBalance, { n: user.coins.toLocaleString(getLang()) })}
              </p>
            ) : (
              <Button onClick={openAuthModal} variant="coin" size="sm" className="mt-4">
                {t.game.coinLogin}
              </Button>
            )}
          </div>
          )}
        </aside>
      </div>

      {/* 相关游戏 */}
      {related.length > 0 && (
        <section className="mt-14">
          <SectionHeader title={t.game.relatedTitle} subtitle={t.game.relatedSubtitle} icon="💡" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
            {related.map((g) => (
              <GameCard key={g.slug} game={g} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function GameDescription({
  description,
  showMore,
  showLess,
}: {
  description: string
  showMore: string
  showLess: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [canToggle, setCanToggle] = useState(false)
  const descriptionId = useId()
  const descriptionRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const node = descriptionRef.current
    if (!node || expanded) return

    let active = true
    const measure = () => {
      if (active) setCanToggle(node.scrollHeight > node.clientHeight + 1)
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    // 像素字体加载后每行能放下的字数会变化，要再量一次，避免按钮误显或漏显。
    void document.fonts?.ready.then(measure)

    return () => {
      active = false
      observer?.disconnect()
    }
  }, [description, expanded])

  return (
    <div>
      {/*
       * 这里只做 CSS 视觉裁切，不截短字符串、也不条件渲染正文。
       * 因此 SSR HTML、meta description 和结构化数据里始终保留完整简介，搜索引擎可以正常抓取。
       */}
      <p
        ref={descriptionRef}
        id={descriptionId}
        className={cx('mt-2 leading-relaxed text-muted', !expanded && 'line-clamp-4')}
      >
        {description}
      </p>
      {canToggle && (
        <button
          type="button"
          className="mt-2 rounded-sm text-sm font-semibold text-brand-hover underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          aria-expanded={expanded}
          aria-controls={descriptionId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? showLess : showMore}
        </button>
      )}
    </div>
  )
}

function Meta({ label, value, to }: { label: string; value: ReactNode; to?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-1 truncate font-semibold">
        {to ? (
          <Link to={to} className="hover:text-brand-hover">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

/** meta description / 结构化数据里的描述必须是单行纯文本：去掉 Markdown 与 HTML 标记 */
function plainText(source: string): string {
  return source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 取数期间的占位。
 * 布局和真实页面对齐（左侧播放器 + 标题，右侧平台卡），数据到位时不会整页跳一下。
 */
function DetailSkeleton() {
  return (
    <div className="container-x py-6 sm:py-8" aria-busy="true">
      <SkeletonBlock className="mb-4 h-3 w-64 max-w-[70vw]" />
      <div className="grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <SkeletonBlock className="aspect-[16/9] rounded-2xl border border-line" />
          <SkeletonBlock className="mt-6 h-8 w-2/3" />
          <div className="mt-3 flex gap-2">
            <SkeletonBlock className="h-7 w-20 rounded-lg" />
            <SkeletonBlock className="h-7 w-24 rounded-lg" />
            <SkeletonBlock className="h-7 w-16 rounded-lg" />
          </div>
          <div className="mt-8 space-y-3">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-3 w-full" />
            <SkeletonBlock className="h-3 w-11/12" />
            <SkeletonBlock className="h-3 w-3/4" />
          </div>
        </div>
        <aside className="space-y-8 lg:col-span-4">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex gap-3">
              <SkeletonBlock className="h-12 w-12 shrink-0 rounded-xl" />
              <div className="flex-1 pt-1">
                <SkeletonBlock className="h-4 w-2/3" />
                <SkeletonBlock className="mt-2 h-3 w-1/2" />
              </div>
            </div>
            <SkeletonBlock className="mt-5 h-3 w-full" />
            <SkeletonBlock className="mt-2 h-3 w-4/5" />
            <SkeletonBlock className="mt-5 h-9 w-full rounded-xl" />
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * 取数失败。和「没有这款游戏」分开：网络挂了不该告诉用户游戏不存在，
 * 那会让人以为游戏被下架了。
 */
function LoadError({ message }: { message: string }) {
  return (
    <div className="container-x flex min-h-[60vh] flex-col items-center justify-center py-20 text-center" role="alert">
      <p className="text-4xl" aria-hidden>
        📡
      </p>
      <p className="mt-4 max-w-md text-sm text-muted">{message}</p>
    </div>
  )
}
