import { Link, useLocation } from 'react-router-dom'
import { useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useT } from '@/services/i18n'
import { stripLang } from '@/config/languages'
import { cx } from '@/lib/format'

/**
 * 手机上最常用的五个入口常驻底边，避免玩家每次滚回顶部、再打开抽屉才能换页面。
 * 沉浸游玩时由 Layout 卸载它：游戏需要完整视口，不能让全站导航压住触控按键。
 */
export function MobileBottomNav() {
  const t = useT()
  const user = useCurrentUser()
  const location = useLocation()
  const path = stripLang(location.pathname)

  const items = [
    { to: '/', label: t.nav.discover, icon: '🏠', active: path === '/' },
    { to: '/games', label: t.nav.allGames, icon: '📚', active: path === '/games' || path.startsWith('/games/') },
    { to: '/rooms', label: t.nav.playOnline, icon: '👥', active: path === '/rooms' || path.startsWith('/rooms/') },
    { to: '/play-local', label: t.nav.playLocal, icon: '📁', active: path === '/play-local' || path.startsWith('/play-local/') },
  ]

  return (
    <nav
      aria-label={t.sidebar.aria}
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 px-1 pt-1 backdrop-blur-xl lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.active ? 'page' : undefined}
          className={cx(
            'flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 text-[10px] leading-tight transition-colors',
            item.active ? 'font-semibold text-brand-hover' : 'text-muted active:bg-black/5 active:text-fg',
          )}
        >
          <span aria-hidden className="text-lg leading-5">{item.icon}</span>
          <span className="max-w-full truncate">{item.label}</span>
        </Link>
      ))}

      {user ? (
        <Link
          to="/me"
          aria-current={path === '/me' || path.startsWith('/me/') ? 'page' : undefined}
          className={cx(
            'flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 text-[10px] leading-tight transition-colors',
            path === '/me' || path.startsWith('/me/') ? 'font-semibold text-brand-hover' : 'text-muted active:bg-black/5 active:text-fg',
          )}
        >
          <span aria-hidden className="text-lg leading-5">👤</span>
          <span className="max-w-full truncate">{t.sidebar.profile}</span>
        </Link>
      ) : (
        <button
          type="button"
          onClick={openAuthModal}
          className="flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 text-[10px] leading-tight text-muted transition-colors active:bg-black/5 active:text-fg"
        >
          <span aria-hidden className="text-lg leading-5">👤</span>
          <span className="max-w-full truncate">{t.sidebar.profile}</span>
        </button>
      )}
    </nav>
  )
}
