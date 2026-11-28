import { Suspense, useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigationType } from 'react-router-dom'
import { cx } from '@/lib/format'
import { onImPanelLoadRequest } from '@/services/im'
import { ShellProvider, useShell } from './ShellContext'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { Footer } from './Footer'
import { useAuthModalOpen } from '@/services/authModal'
import { lazyNamed } from '@/routes/lazy'
import { PageSkeleton } from '@/components/ui/PageSkeleton'
import { useIdleImport } from '@/components/ui/useIdleImport'
import { useT } from '@/services/i18n'
import { onTvHost } from '@/services/tvHost'
import { stripLang } from '@/config/languages'
import { TV_ROUTE } from '../../../shared/tv-host.js'
import { ClarityConsentBanner } from '@/components/privacy/ClarityConsentBanner'
import { MobileBottomNav } from './MobileBottomNav'
import { NoWasmNotice } from './NoWasmNotice'

/** 路由切换时回到顶部；带 hash 时滚动到对应锚点；同时退出沉浸模式、关闭抽屉 */
function RouteEffects() {
  const { pathname, hash } = useLocation()
  const navType = useNavigationType()
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
    // 后退 / 前进（POP）交给浏览器自己的滚动恢复：强制回顶会让玩家从详情页返回长列表时丢掉位置。
    if (navType === 'POP') return
    // 'instant'：html 上挂了 scroll-behavior: smooth，不写的话换页会先在新页面里动画滚一遍
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [pathname, hash, navType, setImmersive, setMobileOpen])

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
      {/* TV 没有普通站点的 main 容器，也必须接住首访下载 TvPage 时的 Suspense。 */}
      <Suspense fallback={<PageSkeleton />}><Outlet /></Suspense>
    </div>
  )
}

/**
 * 站内消息抽屉的延迟挂载壳。
 *
 * 抽屉依赖的 comments / avatar / imClient 不参与首屏绘制；默认等 3 秒和一个空闲窗口，
 * 把这些动态模块移出移动端首屏请求链。顶栏聚焦、悬停、点击或评论头像发私信时，服务接缝
 * 会取消等待并提前加载。即使访客一直没操作，抽屉仍会自动挂载，登录态变化时的 IM 生命周期
 * 不会被条件渲染截断；服务端与 hydration 首帧仍都不读登录态。
 *
 * ⚠️ 别改成条件渲染（登录才挂）：imClient 的 startImWhenIdle 是在这里挂载时排的，
 * 而它在服务端渲染时什么都不做是**故意的**（useCurrentUser 的 SSR 快照恒为 null）。
 */
const loadImPanel = () => import('@/components/im/ImPanel')
const AuthModalChunk = lazyNamed(() => import('@/components/auth/AuthModal'), 'AuthModal')

/** 登录弹窗首屏不需要；收到打开请求时再拉 chunk，等待期间先给用户可访问的轻量反馈。 */
function DeferredAuthModal() {
  const open = useAuthModalOpen()
  const t = useT()
  if (!open) return null

  return (
    <Suspense
      fallback={(
        <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-modal-loading-title"
            aria-busy="true"
            className="my-auto w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-8"
          >
            <h2 id="auth-modal-loading-title" className="text-2xl font-extrabold text-fg">{t.auth.title}</h2>
            <div className="mt-6 flex justify-center" role="status">
              <span className="sr-only">{t.common.loadingMore}</span>
              <span aria-hidden className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            </div>
          </section>
        </div>
      )}
    >
      <AuthModalChunk />
    </Suspense>
  )
}

function DeferredImPanel() {
  const [requested, setRequested] = useState(false)
  useEffect(() => onImPanelLoadRequest(() => setRequested(true)), [])
  // 默认越过移动端首屏关键时间窗；顶栏收到真实交互意图时立即取消延迟，避免按钮显得没响应。
  const mod = useIdleImport(loadImPanel, { timeout: 800, fallbackMs: 200, delayMs: requested ? 0 : 3000 })
  return mod ? <mod.ImPanel /> : null
}

function Shell() {
  const { immersive, setImmersive, mobileOpen, desktop } = useShell()
  const t = useT()
  const routePath = stripLang(useLocation().pathname)
  const isTvRoute = routePath === TV_ROUTE
  // 后台有自己的移动端导航；不要再叠加面向玩家的五项底栏，避免挤占表单和上传区域。
  const isAdminRoute = routePath === '/admin' || routePath.startsWith('/admin/')

  /*
    走空壳的两种情况：
      · 在 TV 子域上 —— 那个域名整个是给电视 / 车机的；
      · 路径就是 /tv —— 主域上这条已经 301 到子域了，但**本地开发不跳**
        （见 shared/tv-host.js 里那条「正牌域名才跳」的白名单），
        不认这一条的话，开发时预览 /tv 看到的是带侧边栏的样子，和线上不一致。
  */
  if (onTvHost() || isTvRoute) return <TvShell />

  const mobileNavigationOpen = mobileOpen && !desktop

  return (
    <div className="min-h-dvh">
      <RouteEffects />
      <Sidebar />

      {/* 内容区：桌面端为侧边栏留出宽度 */}
      <div
        aria-hidden={mobileNavigationOpen || undefined}
        inert={mobileNavigationOpen}
        className={cx(
          'flex min-h-dvh flex-col bg-white transition-[padding] duration-300 ease-out',
          immersive ? 'lg:pl-0' : 'lg:pl-60',
          !immersive && !isTvRoute && !isAdminRoute && 'pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0',
        )}
      >
        <Topbar />
        <main className="site-main flex-1">
          {!isAdminRoute && !isTvRoute && <NoWasmNotice />}
          {/* 只让正文在站内首次进入某页时等待 chunk；顶栏与侧栏不跟着闪退。SSR 同一边界留住水合中的 HTML。 */}
          <Suspense fallback={<PageSkeleton />}><Outlet /></Suspense>
        </main>
        {!immersive && <Footer />}
      </div>

      {!immersive && !isAdminRoute && !mobileNavigationOpen && <MobileBottomNav />}

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
      <DeferredAuthModal />

      {/* 第三方行为分析只有在访客主动同意后才会加载。 */}
      <ClarityConsentBanner />

      {/*
        站内消息的右侧抽屉。挂载之后**一直挂着**（靠 transform 滑出，所以收起也有动画），
        但推迟到浏览器空闲才挂 —— 见上面 DeferredImPanel 的注释。
        它在服务端渲染时什么都不做：useCurrentUser() 的 SSR 快照恒为 null
        （见 services/auth.ts 的注释），所以 SSR 出来就是一个空壳。
        SDK 核心和抽屉所需插件是 services/imClient.ts 里的动态 import，不在首屏主包里。
      */}
      <DeferredImPanel />
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
