import { Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { TopProgressBar } from '@/components/layout/TopProgressBar'
import { RouteChunk, lazyNamed } from '@/routes/lazy'
import { useAutoInclude } from '@/services/autoInclude'
import { HomePage } from '@/pages/HomePage'
import { onTvHost } from '@/services/tvHost'
import {
  GamesPage, GameDetailPage, PlayLocalPage, RoomsPage, CollectionsPage, CollectionDetailPage,
  DevelopersPage, GenresPage, PlatformsPage, GenrePage, PlatformPage, ComingSoonPage,
  NotFoundPage, BlogPage, PostPage, LoginPage, ProfilePage, AboutPage, SubmitGamePage,
  EmbedPage, AppsPage, OAuthCallbackPage, OpenPlatformPage, OpenDevicePage,
  OpenAuthorizePage, TvPage,
} from '@/routes/Pages'
import { TermsPage } from '@/pages/TermsPage'
import { PrivacyPage } from '@/pages/PrivacyPage'

/**
 * 前台与后台按页面加载。前台使用同一路由声明，但 Pages.tsx 在服务端同步导出页面、
 * 客户端构建替换为 Pages.client.tsx 的懒组件；首页与法律页仍在主包中。
 *
 * 后台不做 SSR（见 server/src/ssr.js），它原本的 lazyNamed 路由继续保持原样。
 */
const AdminLayout = lazyNamed(() => import('@/admin/AdminLayout'), 'AdminLayout')
const AdminOverview = lazyNamed(() => import('@/admin/AdminOverview'), 'AdminOverview')
const AdminGames = lazyNamed(() => import('@/admin/AdminGames'), 'AdminGames')
const AdminPosts = lazyNamed(() => import('@/admin/AdminPosts'), 'AdminPosts')
const AdminUsers = lazyNamed(() => import('@/admin/AdminUsers'), 'AdminUsers')
const AdminComments = lazyNamed(() => import('@/admin/AdminComments'), 'AdminComments')
const AdminDevelopers = lazyNamed(() => import('@/admin/AdminDevelopers'), 'AdminDevelopers')
const AdminFriendLinks = lazyNamed(() => import('@/admin/AdminFriendLinks'), 'AdminFriendLinks')
const AdminNotice = lazyNamed(() => import('@/admin/AdminNotice'), 'AdminNotice')
const AdminRoms = lazyNamed(() => import('@/admin/AdminRoms'), 'AdminRoms')
const AdminData = lazyNamed(() => import('@/admin/AdminData'), 'AdminData')
const AdminOpenApps = lazyNamed(() => import('@/admin/AdminOpenApps'), 'AdminOpenApps')
const AdminConfig = lazyNamed(() => import('@/admin/AdminConfig'), 'AdminConfig')
const AdminApps = lazyNamed(() => import('@/admin/AdminApps'), 'AdminApps')

// 应用中心（/apps）已经做出来了，不再进 coming soon
const COMING_SOON_ROUTES: string[] = []

export function AppRoutes() {
  // 前端路由换页时补一次头条自动收录的推送（index.html 里那段只推首屏那一个 URL）
  useAutoInclude()

  return (
    <>
      {/* 顶部加载条。放在 <Routes> 外面，前台和后台共用同一根 */}
      <TopProgressBar />
      <Routes>
        <Route element={<Layout />}>
          {/*
            TV 子域（tv.8bitgo.com）的根挂的是 TV 页，不是首页 —— 那个域名整个是给
            电视和车机用的（见 shared/tv-host.js）。主域的 / 不受影响。

            ⚠️ 判定必须和服务端一致：服务端在渲染前把结果塞进 setSsrTvHost，
            客户端读 location.hostname，两边同一套规则。不一致的话页面会先渲 TV 再跳首页。
          */}
          <Route index element={onTvHost() ? <TvPage /> : <HomePage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GameDetailPage />} />
          <Route path="/platforms" element={<PlatformsPage />} />
          <Route path="/platforms/:id" element={<PlatformPage />} />
          <Route path="/genres" element={<GenresPage />} />
          <Route path="/genres/:id" element={<GenrePage />} />
          <Route path="/developers" element={<DevelopersPage />} />
          <Route path="/play-local" element={<PlayLocalPage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          {/* 用户自建合集。注意和 pages/CollectionPage.tsx 不是一回事 ——
              那个是平台页 / 类型页的共用组件（/platforms/:id、/genres/:id） */}
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/collections/:id" element={<CollectionDetailPage />} />
          <Route path="/blog" element={<BlogPage />} />
          <Route path="/blog/:slug" element={<PostPage />} />
          <Route path="/login" element={<LoginPage />} />
          {/* 第三方登录的落地页。注册给 Microsoft / Apple 的是**后端**那个回调地址，
              这里只接后端 302 回来的结果。不带语言前缀（前缀是路由 basename），
              所以登完要整页跳回原来的语言站 */}
          <Route path="/auth/callback" element={<OAuthCallbackPage />} />
          <Route path="/me" element={<ProfilePage />} />
          <Route path="/about" element={<AboutPage />} />
          {/* 法律页继续静态 import —— 应用商店和第三方登录的
              审核会来抓这两个 URL，SSR 挂了等于审核看到空壳 */}
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/submit" element={<SubmitGamePage />} />
          <Route path="/apps" element={<AppsPage />} />
          {/* 开放平台的开发者控制台。**不叫 /developers** —— 那个路径是站内的「开发商」
              浏览页（科乐美、SNK 那种），两个 developer 完全不是一回事，见 OpenPlatformPage 的注释 */}
          <Route path="/open" element={<OpenPlatformPage />} />
          {/* 设备码流程里用户确认那一步。设备上没有浏览器，人到这一页来输码 */}
          <Route path="/open/device" element={<OpenDevicePage />} />
          {/* 授权码流程里用户同意那一步。有浏览器的 Web 应用把用户重定向到这里点同意 */}
          <Route path="/open/authorize" element={<OpenAuthorizePage />} />
          {/* 8BitGo TV：24/7 复古游戏直播频道。收不到信号（503）时退回游戏库浏览 */}
          <Route path="/tv" element={<TvPage />} />
          {COMING_SOON_ROUTES.map((path) => (
            <Route key={path} path={path} element={<ComingSoonPage />} />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/*
          第三方页面嵌入用的精简游玩页。刻意挂在 <Route element={<Layout />}> **外面** ——
          挂里面就会带上侧边栏、顶栏和页脚，在一个 640x480 的 iframe 里全是负担。
          它仍然要走 SSR，服务端使用 Pages.tsx 的同步组件；浏览器端第一次进入才下载。
        */}
        <Route path="/embed/:slug" element={<RouteChunk><EmbedPage /></RouteChunk>} />
        {/*
          Play! / Dolphin 仍从详情页跳到这些隔离路由。PSP 的正常详情页已经由服务端直接加
          COOP/COEP，旧 /play/psp 链接只保留兼容，不能再把新访客送到铺满视口的精简页。
        */}
        <Route path="/play/psp/:slug" element={<RouteChunk><EmbedPage standalonePlatform="psp" /></RouteChunk>} />
        <Route path="/play/ps2/:slug" element={<RouteChunk><EmbedPage standalonePlatform="ps2" /></RouteChunk>} />
        <Route path="/play/gamecube/:slug" element={<RouteChunk><EmbedPage standalonePlatform="gamecube" /></RouteChunk>} />
        <Route path="/play/wii/:slug" element={<RouteChunk><EmbedPage standalonePlatform="wii" /></RouteChunk>} />

        {/* 后台：独立外壳，不带前台侧边栏 */}
        <Route
          path="/admin"
          element={
            <RouteChunk>
              <AdminLayout />
            </RouteChunk>
          }
        >
          {/*
            每个子页各自一个 Suspense 边界。共用外层那个的话，从概览点到「游戏管理」时
            连后台侧边栏一起被 fallback 掉，整个外壳闪一下再回来。
          */}
          <Route index element={<RouteChunk><AdminOverview /></RouteChunk>} />
          <Route path="games" element={<RouteChunk><AdminGames /></RouteChunk>} />
          <Route path="posts" element={<RouteChunk><AdminPosts /></RouteChunk>} />
          <Route path="developers" element={<RouteChunk><AdminDevelopers /></RouteChunk>} />
          <Route path="friend-links" element={<RouteChunk><AdminFriendLinks /></RouteChunk>} />
          <Route path="notice" element={<RouteChunk><AdminNotice /></RouteChunk>} />
          <Route path="users" element={<RouteChunk><AdminUsers /></RouteChunk>} />
          <Route path="comments" element={<RouteChunk><AdminComments /></RouteChunk>} />
          <Route path="roms" element={<RouteChunk><AdminRoms /></RouteChunk>} />
          <Route path="data" element={<RouteChunk><AdminData /></RouteChunk>} />
          <Route path="open-apps" element={<RouteChunk><AdminOpenApps /></RouteChunk>} />
          <Route path="apps" element={<RouteChunk><AdminApps /></RouteChunk>} />
          <Route path="config" element={<RouteChunk><AdminConfig /></RouteChunk>} />
        </Route>
      </Routes>
    </>
  )
}
