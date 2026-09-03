import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useShell } from './ShellContext'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Logo } from './Logo'
import { bottomNavFor, communityLinks, exploreNavFor, mainNavFor, type NavLinkItem } from './nav'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { SocialIcon } from './SocialIcon'
import { FEATURES } from '@/config/features'
import { anyRoomsEnabled, useAllRooms } from '@/services/allRooms'
import { useGamesTotal } from '@/services/gamesTotal'
import { api, apiEnabled } from '@/services/api'
import { useCurrentUser as useUser } from '@/services/auth'
import { useGamesBySlugs } from '@/services/gameCache'
import { useGuestRecents } from '@/services/recents'
import { platformMap } from '@/data/platforms'
import { gameTitle, platformLabel } from '@/services/i18nData'
import { GameCover } from '@/components/game/GameCover'

export const SIDEBAR_WIDTH = 240
export const SIDEBAR_COLLAPSED_WIDTH = 72

/**
 * 左侧导航栏。
 *  - lg 及以上：固定在左侧，可折叠成图标栏
 *  - lg 以下：作为抽屉从左侧滑出，带遮罩
 */
export function Sidebar() {
  const { mobileOpen, setMobileOpen, immersive } = useShell()
  const user = useCurrentUser()
  const t = useT()
  // 折叠功能已取消：侧边栏在桌面端始终展开
  const collapsed = false

  return (
    <>
      {/* 移动端遮罩 */}
      <div
        aria-hidden
        onClick={() => setMobileOpen(false)}
        className={cx(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        aria-label={t.sidebar.aria}
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-line bg-surface transition-transform duration-300 ease-out',
          // 移动端：抽屉；桌面端：常驻；沉浸模式下整体移出
          mobileOpen ? 'translate-x-0' : cx('-translate-x-full', !immersive && 'lg:translate-x-0'),
        )}
      >

        {/* 顶部：Logo（+ 折叠按钮）左，语言切换器右 */}
        <div className={cx('flex h-16 shrink-0 items-center gap-1 px-3', collapsed ? 'lg:justify-center' : 'justify-between')}>
          <Logo />

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label={t.sidebar.closeMenu}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-fg lg:hidden"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            <LanguageSwitcher align="right" />
          </div>
        </div>

        {/* 可滚动导航区 */}
        <nav className="scrollbar-none flex-1 overflow-y-auto px-2 py-3">
          <RandomGameButton collapsed={collapsed} />
          <CommunityBox collapsed={collapsed} />

          {/* 最上面两条不带分组标题 —— 只有两项，加个「导航」的小标题纯属噪声 */}
          <NavGroup collapsed={collapsed}>
            {mainNavFor(t).map((item) => (
              <NavItem key={item.to} item={item} collapsed={collapsed} trailing={item.to === '/rooms' ? <RoomCount /> : undefined} />
            ))}
          </NavGroup>

          <LaterBox collapsed={collapsed} />

          <NavGroup title={t.sidebar.groupLibrary} collapsed={collapsed}>
            {exploreNavFor(t).map((item) => (
              <NavItem
                key={item.to}
                item={item}
                collapsed={collapsed}
                trailing={item.to === '/games' ? <GamesCount /> : undefined}
              />
            ))}
          </NavGroup>

          <NavGroup collapsed={collapsed}>
            {bottomNavFor(t).map((item) => (
              <NavItem key={item.to} item={item} collapsed={collapsed} />
            ))}
          </NavGroup>

          <PlayedBox collapsed={collapsed} />
        </nav>

        {/* 底部：用户 */}
        <div className="shrink-0 border-t border-line p-2">
          {user ? (
            <Link
              to="/me"
              onClick={() => setMobileOpen(false)}
              className={cx(
                'flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-black/5',
                collapsed && 'lg:justify-center lg:px-0',
              )}
              title={t.sidebar.profile}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-soft text-sm" aria-hidden>
                {user.avatar}
              </span>
              <span className={cx('min-w-0', collapsed && 'lg:hidden')}>
                <span className="block truncate text-sm font-semibold">{user.nickname}</span>
                <span className="block truncate text-[11px] text-muted">
                  {FEATURES.coins ? fmt(t.common.coinAmount, { n: user.coins.toLocaleString() }) : t.sidebar.viewFavorites}
                </span>
              </span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMobileOpen(false)
                openAuthModal()
              }}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-black/5',
                collapsed && 'lg:justify-center lg:px-0',
              )}
              title={t.common.loginOrRegister}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-surface-3 to-surface-2 text-sm" aria-hidden>
                👤
              </span>
              <span className={cx('min-w-0', collapsed && 'lg:hidden')}>
                <span className="block truncate text-sm font-semibold">{t.common.loginOrRegister}</span>
                <span className="block truncate text-[11px] text-muted">
                  {FEATURES.coins ? t.sidebar.coinsHint : t.sidebar.loginToFavorite}
                </span>
              </span>
            </button>
          )}
        </div>
      </aside>
    </>
  )
}

/** 计数徽标的静默样式：数字为 0 或纯静态计数时用，不抢「有人在线」那点绿色 */
const COUNT_BADGE = 'inline-flex items-center rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted'

/**
 * 「一起玩」右侧的房间数 —— 联机房间 + 直播房间（useAllRooms 已经把三路合过）。
 *
 * 以前 0 个房间时整块不渲染，结果这一栏平时看不出「现在有没有人在玩」，
 * 只有热闹的时候才冒出个数字。现在 0 也照样显示，只是收成灰色不带呼吸点。
 * 三条通道全都没开（无后端 / 无信令）时才真的不渲染 —— 那种情况下 0 是假的。
 */
function RoomCount() {
  const rooms = useAllRooms()
  if (!anyRoomsEnabled()) return null
  if (rooms.length === 0) return <span className={COUNT_BADGE}>0</span>
  return (
    <span className="inline-flex items-center gap-1 rounded bg-online/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-online">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-online" />
      {rooms.length}
    </span>
  )
}

/** 「全部游戏」右侧的游戏库总数 */
function GamesCount() {
  const total = useGamesTotal()
  if (total === undefined) return null
  return <span className={COUNT_BADGE}>{total.toLocaleString()}</span>
}

/**
 * 「稍后玩」：玩家自己标记的游戏，最多显示 3 款，点标题右边的箭头看全部。
 *
 * 数据就是原来的「收藏」（favorites 表），只是全站文案改叫「稍后玩」——
 * 玩家收藏一款老游戏，本来想的也就是「等会儿来玩」。
 *
 * 没登录、或者一款都没加时整块不渲染，不占位置。
 */
function LaterBox({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  const lang = useLang()
  const user = useUser()
  const { setMobileOpen } = useShell()
  // 只要前 3 个 slug，多取无益 —— gameCache 会按需向后端批量拉并缓存
  const games = useGamesBySlugs((user?.favorites ?? []).slice(0, 3))
  if (!games.length) return null
  return (
    <div className={cx('mb-3', collapsed && 'lg:hidden')}>
      <Link
        to="/me"
        onClick={() => setMobileOpen(false)}
        className="text-pixel mb-1.5 flex items-center gap-1 px-3 text-[10px] uppercase tracking-wider text-dim transition hover:text-fg"
      >
        {t.sidebar.laterTitle}
        <span aria-hidden>›</span>
      </Link>
      <ul className="space-y-0.5">
        {games.map((g) => (
          <li key={g.slug}>
            <Link
              to={`/games/${g.slug}`}
              onClick={() => setMobileOpen(false)}
              className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-muted transition hover:bg-black/5 hover:text-fg"
            >
              <span className="h-6 w-6 shrink-0 overflow-hidden rounded" aria-hidden>
                <GameCover game={g} ratio="square" showTitle={false} iconSize="sm" />
              </span>
              <span className="min-w-0 flex-1 truncate">{gameTitle(g, lang)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 「曾经玩过」：最近打开过的游戏，最多 4 款。
 *
 * 两个来源二选一：登录了读账号上的 users.recent（换设备也在），
 * 没登录读这台浏览器的本地记录（services/recents.ts）。一款都没有时整块不渲染。
 * 卡片样式沿用原来侧边栏「联机玩」的房间卡：横版小封面 + 标题 + 一行副文字。
 */
function PlayedBox({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  const lang = useLang()
  const user = useUser()
  const guest = useGuestRecents()
  const { setMobileOpen } = useShell()
  const games = useGamesBySlugs((user ? user.recent : guest).slice(0, 4))
  if (!games.length) return null

  const title = <>{t.sidebar.playedTitle}</>
  const titleClass = 'text-pixel mb-1.5 flex items-center gap-1 px-3 text-[10px] uppercase tracking-wider text-dim'

  return (
    <div className={cx('mb-3', collapsed && 'lg:hidden')}>
      {/* 访客点 /me 只会被弹登录框，所以只有登录用户的标题才是链接 */}
      {user ? (
        <Link to="/me" onClick={() => setMobileOpen(false)} className={cx(titleClass, 'transition hover:text-fg')}>
          {title}
          <span aria-hidden>›</span>
        </Link>
      ) : (
        <p className={titleClass}>{title}</p>
      )}
      <ul className="space-y-0.5">
        {games.map((g) => (
          <li key={g.slug}>
            <Link
              to={`/games/${g.slug}`}
              onClick={() => setMobileOpen(false)}
              title={gameTitle(g, lang)}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-black/5"
            >
              <span className="w-14 shrink-0 overflow-hidden rounded-md">
                <GameCover game={g} ratio="landscape" showTitle={false} showBadge={false} iconSize="sm" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{gameTitle(g, lang)}</span>
                <span className="block truncate text-[11px] text-muted">
                  {platformLabel(t, g.platform, platformMap[g.platform]?.name ?? g.platform)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 随机跳转到一款可在线运行的游戏 */
function RandomGameButton({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { setMobileOpen } = useShell()

  const [rolling, setRolling] = useState(false)

  /**
   * 随机一款游戏。v1 是把整库拉到浏览器再随机取下标，v2 不再全量加载，
   * 改成问后端要一条。取不到（库是空的 / 网络不通）就退到游戏库，
   * 别让按钮点了没反应。
   */
  const play = async () => {
    if (rolling) return
    const current = location.pathname.startsWith('/games/') ? location.pathname.split('/')[2] : undefined
    setMobileOpen(false)
    if (!apiEnabled()) return navigate('/games')
    setRolling(true)
    try {
      const game = await api.get<{ slug: string }>(
        `/api/games/random${current ? `?exclude=${encodeURIComponent(current)}` : ''}`,
      )
      navigate(game?.slug ? `/games/${game.slug}` : '/games')
    } catch {
      navigate('/games')
    } finally {
      setRolling(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void play()}
      disabled={rolling}
      title={t.sidebar.randomGame}
      className={cx(
        'group relative mb-3 flex h-11 w-full select-none items-center justify-center bg-transparent px-2 text-[13px] font-bold whitespace-nowrap text-[#fcfae5]',
        'transition-transform duration-100 hover:-translate-y-px active:translate-y-[2px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#528b84] focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:pointer-events-none disabled:opacity-55',
        collapsed && 'lg:px-0',
      )}
    >
      {/*
       * 三段 SVG 保留两端的像素台阶，中段独自伸缩；整张图直接横向拉伸会把圆角和
       * 阴影一起拉胖。折叠态换成窄中段，避免仅剩图标时中心纹理被压成一条脏线。
       */}
      <span className="pointer-events-none absolute inset-0 z-0 flex" aria-hidden>
        <img
          src="/ui/random-button/left.svg"
          alt=""
          draggable={false}
          className="h-full w-[22.76px] shrink-0 transition-[filter] duration-100 group-hover:brightness-105"
        />
        <img
          src={collapsed ? '/ui/random-button/middle-mini.svg' : '/ui/random-button/middle.svg'}
          alt=""
          draggable={false}
          className="h-full min-w-0 flex-1 transition-[filter] duration-100 group-hover:brightness-105"
          style={{ objectFit: 'fill' }}
        />
        <img
          src="/ui/random-button/right.svg"
          alt=""
          draggable={false}
          className="h-full w-[22.76px] shrink-0 transition-[filter] duration-100 group-hover:brightness-105"
        />
      </span>
      <span className={cx('relative z-10 -translate-y-[4px]', collapsed && 'lg:hidden')}>{t.sidebar.randomGame}</span>
      {collapsed && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-surface-3 px-2 py-1 text-xs font-normal text-fg opacity-0 shadow-xl transition group-hover:opacity-100 lg:block"
        >
          {t.sidebar.randomGame}
        </span>
      )}
    </button>
  )
}

/**
 * 玩家社区卡片：标题嵌在边框上，一行社交图标。
 * 桌面折叠态没有横向空间，改为竖排图标并带悬浮提示。
 */
function CommunityBox({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  return (
    <>
      {/* 展开态 / 移动端抽屉 */}
      <fieldset className={cx('mb-4 rounded-xl border border-line-strong px-3 pb-3 pt-2', collapsed && 'lg:hidden')}>
        <legend className="px-1.5 text-xs font-semibold text-fg">{t.sidebar.community}</legend>
        <div className="flex items-center justify-between">
          {communityLinks.map((c) => (
            <a
              key={c.id}
              href={c.href}
              target="_blank"
              rel="noreferrer"
              aria-label={c.label}
              title={c.label}
              className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-black/5 hover:text-fg"
            >
              <SocialIcon id={c.id} />
            </a>
          ))}
        </div>
      </fieldset>

      {/* 桌面折叠态：竖排图标 */}
      <ul className={cx('mb-3 hidden space-y-0.5 border-b border-line pb-3', collapsed && 'lg:block')} aria-label={t.sidebar.community}>
        {communityLinks.map((c) => (
          <li key={c.id}>
            <a
              href={c.href}
              target="_blank"
              rel="noreferrer"
              aria-label={c.label}
              title={c.label}
              className="group relative flex h-9 items-center justify-center rounded-lg text-muted transition hover:bg-black/5 hover:text-fg"
            >
              <SocialIcon id={c.id} size={20} />
              <span
                role="tooltip"
                className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-surface-3 px-2 py-1 text-xs text-fg opacity-0 shadow-xl transition group-hover:opacity-100"
              >
                {c.label}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </>
  )
}

/** title 可以不传：只有一两项的分组加标题反而更乱 */
function NavGroup({ title, collapsed, children }: { title?: string; collapsed: boolean; children: ReactNode }) {
  return (
    <div className="mb-3">
      {title && (
        <p
          className={cx(
            'text-pixel mb-1.5 px-3 text-[10px] uppercase tracking-wider text-dim',
            collapsed && 'lg:sr-only',
          )}
        >
          {title}
        </p>
      )}
      <div className={cx('mb-2 hidden h-px bg-line', collapsed && 'lg:block')} aria-hidden />
      <ul className="space-y-0.5">{children}</ul>
    </div>
  )
}

function NavItem({
  item,
  collapsed,
  trailing,
  muted,
}: {
  item: NavLinkItem
  collapsed: boolean
  trailing?: ReactNode
  muted?: boolean
}) {
  const t = useT()
  const location = useLocation()
  const { setMobileOpen } = useShell()

  const [path, search] = item.to.split('?')
  const isHash = item.to.includes('#')
  const active = item.external || item.disabled
    ? false
    : item.exact
      ? location.pathname === path && (search ? location.search === `?${search}` : location.search === '') && !isHash
      : !isHash && location.pathname.startsWith(path) && path !== '/'

  const className = cx(
    'group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition',
    collapsed && 'lg:justify-center lg:px-0',
    item.disabled
      ? 'cursor-not-allowed text-dim opacity-60'
      : active
        ? 'bg-brand-soft font-semibold text-fg'
        : muted
          ? 'text-dim hover:bg-black/5 hover:text-muted'
          : 'text-muted hover:bg-black/5 hover:text-fg',
  )

  const content = (
    <>
      {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" aria-hidden />}
      <span className="relative grid h-6 w-6 shrink-0 place-items-center text-base leading-none" aria-hidden>
        {item.icon}
      </span>
      <span className={cx('min-w-0 flex-1 truncate', collapsed && 'lg:hidden')}>{item.label}</span>
      {item.badge && (
        <span
          className={cx(
            'whitespace-nowrap rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none',
            item.disabled ? 'border border-line-strong text-dim' : 'bg-live text-white',
            collapsed && 'lg:hidden',
          )}
        >
          {item.badge}
        </span>
      )}
      {trailing && <span className={cx(collapsed && 'lg:hidden')}>{trailing}</span>}

      {/* 折叠态悬浮提示 */}
      {collapsed && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-surface-3 px-2 py-1 text-xs text-fg opacity-0 shadow-xl transition group-hover:opacity-100 lg:block"
        >
          {item.label}
          {item.disabled && <span className="ml-1 text-dim">{t.common.comingSoonSuffix}</span>}
        </span>
      )}
    </>
  )

  return (
    <li>
      {item.disabled ? (
        <span className={className} aria-disabled="true" title={collapsed ? fmt(t.common.comingSoonParen, { label: item.label }) : t.common.comingSoon}>
          {content}
        </span>
      ) : item.external ? (
        <a href={item.to} target="_blank" rel="noreferrer" className={className} title={collapsed ? item.label : undefined}>
          {content}
        </a>
      ) : (
        <Link to={item.to} className={className} onClick={() => setMobileOpen(false)} title={collapsed ? item.label : undefined}>
          {content}
        </Link>
      )}
    </li>
  )
}
