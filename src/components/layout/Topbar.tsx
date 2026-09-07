import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cx } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { useCurrentUser } from '@/services/auth'
import { useShell } from './ShellContext'
import { useT, fmt } from '@/services/i18n'
import { Logo } from './Logo'
import { FEATURES } from '@/config/features'
import { SearchBox, SearchIcon } from './SearchBox'
import { ChatButton } from './ChatButton'

/**
 * 顶栏：移动端菜单按钮 + 搜索 + 快捷操作（玩本地 ROM / G 币 / 通知 / 登录）
 */
export function Topbar() {
  const t = useT()
  const { setMobileOpen, immersive } = useShell()
  const [searchOpen, setSearchOpen] = useState(false)
  const user = useCurrentUser()
  const location = useLocation()
  const loginTo = `/login?next=${encodeURIComponent(location.pathname + location.search)}`

  if (immersive) return null

  return (
    <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* 移动端：菜单 + Logo */}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label={t.topbar.openMenu}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-fg hover:bg-black/5 lg:hidden"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <Logo className="lg:hidden" />

        {/* 搜索 */}
        <SearchBox className="hidden flex-1 md:block md:max-w-xl" />

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            aria-label={t.topbar.search}
            aria-expanded={searchOpen}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-fg md:hidden"
          >
            <SearchIcon />
          </button>

          <Button to="/apps" variant="secondary" size="sm" className="hidden sm:inline-flex">
            <span aria-hidden>📱</span> {t.topbar.downloadApp}
          </Button>

          {FEATURES.coins && (
            <Link
              to={user ? '/me' : loginTo}
              title={user ? t.topbar.coinBalance : t.topbar.coinBalanceGuest}
              className="hidden h-9 items-center gap-1.5 rounded-lg border border-coin/30 bg-coin-soft px-3 text-xs font-semibold text-coin transition hover:border-coin/60 sm:inline-flex"
            >
              <span aria-hidden>🪙</span> {fmt(t.topbar.coinChip, { n: user ? user.coins.toLocaleString() : 0 })}
            </Link>
          )}

          {/*
            登录入口保留在侧边栏；顶栏只在已登录时显示聊天入口。
            原来这儿是「头像 + 昵称 + 下拉」的用户菜单，拿掉了 —— 身份和入口侧边栏底部
            已经有一份（头像 + 昵称 + G 币 → /me），退出登录在 /me 页面里也有。
          */}
          {user && <ChatButton />}
        </div>
      </div>

      {/* 移动端展开的搜索行 */}
      <div
        className={cx(
          'grid overflow-hidden transition-[grid-template-rows] duration-300 md:hidden',
          searchOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0">
          <div className="border-t border-line px-4 py-3">
            <SearchBox full onSubmitted={() => setSearchOpen(false)} />
          </div>
        </div>
      </div>
    </header>
  )
}
