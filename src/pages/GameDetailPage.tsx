import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { recordRecent, toggleFavorite, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useRomUrl } from '@/services/roms'
import { resolveRuntime } from '@/emulator'
import { getGame, getRelatedGames } from '@/services/games'
import { platformMap } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { getDefaultKeymap } from '@/lib/emulator'
import { formatCount, formatPlayers } from '@/lib/format'
import { useSeo, breadcrumbSchema, videoGameSchema } from '@/services/seo'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'
import { genreLabel, platformDesc, platformLabel, gameTitle } from '@/services/i18nData'
import { EmulatorPlayer } from '@/emulator'
import { GameCover } from '@/components/game/GameCover'
import { GameCard } from '@/components/game/GameCard'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { RatingLine } from '@/components/ui/Rating'
import { Badge, CoinBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { NotFoundPage } from './NotFoundPage'
import { useShell } from '@/components/layout/ShellContext'
import { cx } from '@/lib/format'
import { FEATURES } from '@/config/features'

export function GameDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [searchParams] = useSearchParams()
  // ?p2p= 是 P2P 邀请链接；?room= 是云端房间（付费通道）
  const invite = searchParams.get('p2p') ?? undefined
  const cloudInvite = searchParams.get('room') ?? undefined
  const t = useT()
  const game = getGame(slug)
  const { immersive } = useShell()
  const user = useCurrentUser()
  const [copied, setCopied] = useState(false)
  const isFav = Boolean(user?.favorites.includes(slug))
  const rom = useRomUrl(game)

  // 记录最近浏览
  useEffect(() => {
    if (game) void recordRecent(game.slug)
  }, [game])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])

  // SEO：hook 必须在下面的 early return 之前调用，所以未找到游戏时走 noindex 分支
  const lang = useLang()
  const seoTitle = game ? gameTitle(game, lang) : ''
  const seoPlatform = game ? platformMap[game.platform] : undefined
  const seoPlatformName = seoPlatform ? platformLabel(t, seoPlatform.id, seoPlatform.name) : ''
  const seoDesc = game ? plainText(game.description) : ''
  useSeo(
    game
      ? {
          title: fmt(t.game.docTitle, { title: seoTitle }),
          // 优先用游戏自己的简介，没有再套通用模板
          description: seoDesc || fmt(t.seo.gameDesc, { title: seoTitle, platform: seoPlatformName }),
          image: game.cover,
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
              rating: game.rating,
              ratingCount: game.ratingCount,
            }),
            breadcrumbSchema([
              { name: t.common.home, path: '/' },
              { name: t.common.library, path: '/games' },
              { name: seoTitle, path: `/games/${game.slug}` },
            ]),
          ],
        }
      : { title: t.game.notFoundTitle, noindex: true },
  )

  if (!game) return <NotFoundPage message={t.game.notFoundMsg} />

  const platform = platformMap[game.platform]
  const runtime = resolveRuntime(platform.id)
  const related = getRelatedGames(game, 8)

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
        <Link to={`/games?platform=${platform.id}`} className="hover:text-fg">
          {platformLabel(t, platform.id, platform.name)}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-fg">{seoTitle}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-12">
        {/* 主区域：沉浸模式下占满整行并按视口高度居中 */}
        <div className={immersive ? 'lg:col-span-12' : 'lg:col-span-8'}>
          <div className={cx(immersive && 'mx-auto max-w-[calc((100dvh-7rem)*16/9)]')}>
            <EmulatorPlayer
              key={game.slug}
              platform={platform}
              gameName={game.title}
              gameSlug={game.slug}
              maxPlayers={game.players}
              invite={invite}
              cloudInvite={cloudInvite}
              icon={game.icon}
              romUrl={rom.status === 'found' ? rom.url : undefined}
              romChecking={rom.status === 'checking'}
              backdrop={<GameCover game={game} ratio="wide" showTitle={false} showBadge={false} className="h-full w-full" />}
            />
          </div>

          {/* 标题与元信息 */}
          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{seoTitle}</h1>
              {seoTitle !== game.title && <p className="mt-1 text-sm text-muted">{game.title}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link to={`/games?platform=${platform.id}`}>
                  <Badge tone="brand" className="text-xs">
                    {platform.icon} {platformLabel(t, platform.id, platform.name)}
                  </Badge>
                </Link>
                {game.genres.map((id) => (
                  <Link key={id} to={`/games?genre=${id}`}>
                    <Badge className="text-xs">
                      {genreMap[id]?.icon} {genreLabel(t, id, genreMap[id]?.name ?? id)}
                    </Badge>
                  </Link>
                ))}
                {rom.status === 'found' && <Badge tone="online" className="text-xs">{t.common.instantPlay}</Badge>}
                {game.multiplayer && <Badge tone="online" className="text-xs">{t.game.badgeMultiplayer}</Badge>}
                {game.bodyControl && <Badge tone="coin" className="text-xs">{t.game.badgeBodyControl}</Badge>}
                <CoinBadge amount={game.coinReward} className="text-xs" />
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              <RatingLine rating={game.rating} count={game.ratingCount} />
              <span className="text-xs text-muted">{fmt(t.common.playsCount, { n: formatCount(game.plays) })}</span>
            </div>
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
            <p className="mt-2 leading-relaxed text-muted">{game.description}</p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Meta label={t.game.year} value={String(game.year)} />
              <Meta label={t.game.developer} value={game.developer} to={`/games?developer=${encodeURIComponent(game.developer)}`} />
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
            <Button to={`/games?platform=${platform.id}`} variant="secondary" size="sm" className="mt-4 w-full">
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

function Meta({ label, value, to }: { label: string; value: string; to?: string }) {
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
