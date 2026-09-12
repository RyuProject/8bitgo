import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { cx } from '@/lib/format'
import { ShellProvider, useShell } from './ShellContext'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { Footer } from './Footer'
import { AuthModal } from '@/components/auth/AuthModal'
import { ImPanel } from '@/components/im/ImPanel'
import { useT } from '@/services/i18n'
import { onTvHost } from '@/services/tvHost'
import { stripLang } from '@/config/languages'
import { TV_ROUTE } from '../../../shared/tv-host.js'

/** 路由切换时回到顶部；带 hash 时滚动到对应锚点；同时退出沉浸模式、关闭抽屉 */
function RouteEffects() {
  const { pathname, hash } = useLocation()
  const { setImmersive, setMobileOpen } = useShell()

  useEffect(() => {
    setImmersive(false)
    setMobileOpen(false)
    if (hash) {
      // hash 是任意用户输入，不一定是合法 CSS 选择器：Facebook 回跳会附上 #_=_，
      // 旧书签可能是 #1 或带空格的锚点。querySelector 对非法选择器会抛 SyntaxError，
      // 而整个项目没有 ErrorBoundary，effect 抛错会让 React 卸载根节点 —— 整页白屏。
      let el: Element | null = null
      try {
        el = document.getElementById(decodeURIComponent(hash.slice(1)))
      } catch {
        el = null
      }
      if (el) {
        requestAnimationFrame(() => el!.scrollIntoView({ behavior: 'smooth', block: 'start' }))
        return
      }
    }
    window.scrollTo({ top: 0 })
  }, [pathname, hash, setImmersive, setMobileOpen])

  return null
}

/**
 * TV 子域（tv.8bitgo.com）的外壳：**什么都不套**。
 *
 * 侧边栏、顶栏、页脚、登录弹窗、站内消息 —— 这些在电视和车机上全是负担：
 * 遥控器只有方向键和确定，点不到它们；它们却会抢走焦点（Tab 能走进去，
 * 方向键焦点引擎也会把它们算成候选），于是按几下方向键焦点就跑到一个
 * 根本用不了的菜单里出不来了。
 *
 * ⚠️ 不要改成复用 `immersive`：那是**页面内的运行时开关**（玩游戏时临时隐藏外壳），
 * 带一个「退出沉浸」按钮，而且 RouteEffects 每次路由变化都会把它重置成 false。
 * 子域上的「没有外壳」是这个站点形态本身的属性，不是一个可以退出的状态。
 */
function TvShell() {
  return (
    // tv-surface 把整批设计令牌换成深色（见 index.css 里那段的理由）
    <div className="tv-surface min-h-dvh bg-bg">
      <RouteEffects />
      <Outlet />
    </div>
  )
}

function Shell() {
  const { immersive, setImmersive } = useShell()
  const t = useT()
  const isTvRoute = stripLang(useLocation().pathname) === TV_ROUTE

  /*
    走空壳的两种情况：
      · 在 TV 子域上 —— 那个域名整个是给电视 / 车机的；
      · 路径就是 /tv —— 主域上这条已经 301 到子域了，但**本地开发不跳**
        （见 shared/tv-host.js 里那条「正牌域名才跳」的白名单），
        不认这一条的话，开发时预览 /tv 看到的是带侧边栏的样子，和线上不一致。
  */
  if (onTvHost() || isTvRoute) return <TvShell />

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

      {/*
        站内消息的右侧抽屉。**一直挂着**（靠 transform 滑出，所以收起也有动画），
        但它在服务端渲染时什么都不做：useCurrentUser() 的 SSR 快照恒为 null
        （见 services/auth.ts 的注释），所以 SSR 出来就是一个空壳。
        SDK 那 700 KB 是 services/imClient.ts 里的动态 import，不在主包里。
      */}
      <ImPanel />
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
