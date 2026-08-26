import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { cx } from '@/lib/format'
import { getRandomGame } from '@/services/games'
import { useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useShell } from './ShellContext'
import { buttonClasses } from '@/components/ui/Button'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Logo } from './Logo'
import { communityLinks, libraryNavFor, mainNavFor, type NavLinkItem } from './nav'
import { useT, fmt } from '@/services/i18n'
import { SocialIcon } from './SocialIcon'
import { FEATURES } from '@/config/features'
import { useRooms } from '@/services/rooms'
import { RoomCard } from '@/components/game/RoomCard'

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

          <NavGroup title={t.sidebar.groupNav} collapsed={collapsed}>
            {mainNavFor(t).map((item) => (
              <NavItem key={item.to} item={item} collapsed={collapsed} trailing={item.to === '/rooms' ? <RoomCount /> : undefined} />
            ))}
          </NavGroup>

          <RoomsBox collapsed={collapsed} />

          <NavGroup title={t.sidebar.groupLibrary} collapsed={collapsed}>
            {libraryNavFor(t).map((item) => (
              <NavItem key={item.to} item={item} collapsed={collapsed} />
            ))}
          </NavGroup>
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

/** 「联机玩」右侧的在线房间数 */
function RoomCount() {
  const rooms = useRooms()
  if (rooms.length === 0) return null
  return (
    <span className="inline-flex items-center gap-1 rounded bg-online/15 px-1.5 py-0.5 text-[10px] font-bold text-online">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-online" />
      {rooms.length}
    </span>
  )
}

/** 联机玩：正在进行的房间（最多 5 个），封面 = 正在玩的游戏，显示房主与人数 */
function RoomsBox({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  const rooms = useRooms()
  const { setMobileOpen } = useShell()
  if (rooms.length === 0) return null
  return (
    <div className={cx('mb-3', collapsed && 'lg:hidden')} onClick={() => setMobileOpen(false)}>
      <p className="text-pixel mb-1.5 px-3 text-[10px] uppercase tracking-wider text-dim">{t.rooms.sidebarTitle}</p>
      <ul className="space-y-0.5">
        {rooms.slice(0, 5).map((room) => (
          <li key={room.roomId}>
            <RoomCard room={room} compact />
          </li>
        ))}
      </ul>
      {rooms.length > 5 && (
        <Link to="/rooms" className="mt-1 block px-3 text-[11px] text-muted hover:text-fg">
          {t.rooms.sidebarMore} →
        </Link>
      )}
    </div>
  )
}

/** 随机跳转到一款可在线运行的游戏 */
function RandomGameButton({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { setMobileOpen } = useShell()

  const play = () => {
    const current = location.pathname.startsWith('/games/') ? location.pathname.split('/')[2] : undefined
    const game = getRandomGame(current)
    setMobileOpen(false)
    navigate(`/games/${game.slug}`)
  }

  return (
    <button
      type="button"
      onClick={play}
      title={t.sidebar.randomGame}
      className={buttonClasses('primary', 'md', cx('group relative mb-3 w-full', collapsed && 'lg:px-0'))}
    >
      <span className="text-base transition group-hover:rotate-12" aria-hidden>
        🎲
      </span>
      <span className={cx(collapsed && 'lg:hidden')}>{t.sidebar.randomGame}</span>
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

function NavGroup({ title, collapsed, children }: { title: string; collapsed: boolean; children: ReactNode }) {
  return (
    <div className="mb-3">
      <p
        className={cx(
          'text-pixel mb-1.5 px-3 text-[10px] uppercase tracking-wider text-dim',
          collapsed && 'lg:sr-only',
        )}
      >
        {title}
      </p>
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
