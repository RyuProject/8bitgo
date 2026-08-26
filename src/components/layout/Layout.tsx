import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { cx } from '@/lib/format'
import { ShellProvider, useShell } from './ShellContext'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { Footer } from './Footer'
import { AuthModal } from '@/components/auth/AuthModal'
import { useT } from '@/services/i18n'

/** 路由切换时回到顶部；带 hash 时滚动到对应锚点；同时退出沉浸模式、关闭抽屉 */
function RouteEffects() {
  const { pathname, hash } = useLocation()
  const { setImmersive, setMobileOpen } = useShell()

  useEffect(() => {
    setImmersive(false)
    setMobileOpen(false)
    if (hash) {
      const el = document.querySelector(hash)
      if (el) {
        requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
        return
      }
    }
    window.scrollTo({ top: 0 })
  }, [pathname, hash, setImmersive, setMobileOpen])

  return null
}

function Shell() {
  const { immersive, setImmersive } = useShell()
  const t = useT()

  return (
    <div className="min-h-dvh">
      <RouteEffects />
      <Sidebar />

      {/* 内容区：桌面端为侧边栏留出宽度 */}
      <div
        className={cx(
          'flex min-h-dvh flex-col transition-[padding] duration-300 ease-out',
          immersive ? 'lg:pl-0' : 'lg:pl-60',
        )}
      >
        <Topbar />
        <main className="flex-1">
          <Outlet />
        </main>
        {!immersive && <Footer />}
      </div>

      {/* 沉浸模式退出按钮 */}
      {immersive && (
        <button
          type="button"
          onClick={() => setImmersive(false)}
          className="fixed right-4 top-4 z-50 inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface/90 px-4 text-xs font-semibold text-fg shadow-xl backdrop-blur transition hover:border-brand"
        >
          {t.player.exitImmersiveBtn} <kbd className="rounded border border-line px-1 text-[10px] text-dim">Esc</kbd>
        </button>
      )}

      {/* 全站登录弹窗 */}
      <AuthModal />
    </div>
  )
}

export function Layout() {
  return (
    <ShellProvider>
      <Shell />
    </ShellProvider>
  )
}
