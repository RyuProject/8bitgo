import { Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { TopProgressBar } from '@/components/layout/TopProgressBar'
import { RouteChunk, lazyNamed } from '@/routes/lazy'
import { HomePage } from '@/pages/HomePage'
import { GamesPage } from '@/pages/GamesPage'
import { GameDetailPage } from '@/pages/GameDetailPage'
import { PlayLocalPage } from '@/pages/PlayLocalPage'
import { RoomsPage } from '@/pages/RoomsPage'
import { DevelopersPage, GenresPage, PlatformsPage } from '@/pages/BrowsePages'
import { GenrePage, PlatformPage } from '@/pages/CollectionPage'
import { ComingSoonPage } from '@/pages/ComingSoonPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { BlogPage } from '@/pages/BlogPage'
import { PostPage } from '@/pages/PostPage'
import { LoginPage } from '@/pages/LoginPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { AboutPage } from '@/pages/AboutPage'
import { WeiboCallbackPage } from '@/pages/WeiboCallbackPage'

/**
 * 后台整块按需加载。
 *
 * 能这么干的前提是服务端根本不渲染 /admin（见 server/src/ssr.js 的 isAdminPath）——
 * renderToString 是同步的，碰上没解析完的 lazy 会直接抛。前台那些页面都要 SSR，
 * 所以只能留在主包里；后台不 SSR，正好整块摘出去。
 *
 * 前台页面**不要**照抄这个写法，会把服务端渲染打挂。
 */
const AdminLayout = lazyNamed(() => import('@/admin/AdminLayout'), 'AdminLayout')
const AdminOverview = lazyNamed(() => import('@/admin/AdminOverview'), 'AdminOverview')
const AdminGames = lazyNamed(() => import('@/admin/AdminGames'), 'AdminGames')
const AdminPosts = lazyNamed(() => import('@/admin/AdminPosts'), 'AdminPosts')
const AdminUsers = lazyNamed(() => import('@/admin/AdminUsers'), 'AdminUsers')
const AdminComments = lazyNamed(() => import('@/admin/AdminComments'), 'AdminComments')
const AdminDevelopers = lazyNamed(() => import('@/admin/AdminDevelopers'), 'AdminDevelopers')
const AdminRoms = lazyNamed(() => import('@/admin/AdminRoms'), 'AdminRoms')
const AdminData = lazyNamed(() => import('@/admin/AdminData'), 'AdminData')

const COMING_SOON_ROUTES = [
  '/apps',
  '/terms',
  '/privacy',
  '/tv',
]

export function AppRoutes() {
  return (
    <>
      {/* 顶部加载条。放在 <Routes> 外面，前台和后台共用同一根 */}
      <TopProgressBar />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GameDetailPage />} />
          <Route path="/platforms" element={<PlatformsPage />} />
          <Route path="/platforms/:id" element={<PlatformPage />} />
          <Route path="/genres" element={<GenresPage />} />
          <Route path="/genres/:id" element={<GenrePage />} />
          <Route path="/developers" element={<DevelopersPage />} />
          <Route path="/play-local" element={<PlayLocalPage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/blog" element={<BlogPage />} />
          <Route path="/blog/:slug" element={<PostPage />} />
          <Route path="/login" element={<LoginPage />} />
          {/* 微博授权回调。路径写死、且不带语言前缀 —— 微博开放平台只认一个「授权回调页」，
              必须和后端 WEIBO_REDIRECT_URI 完全一致。登完由页面自己整页跳回原来的语言站 */}
          <Route path="/auth/weibo/callback" element={<WeiboCallbackPage />} />
          <Route path="/me" element={<ProfilePage />} />
          <Route path="/about" element={<AboutPage />} />
          {COMING_SOON_ROUTES.map((path) => (
            <Route key={path} path={path} element={<ComingSoonPage />} />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

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
          <Route path="users" element={<RouteChunk><AdminUsers /></RouteChunk>} />
          <Route path="comments" element={<RouteChunk><AdminComments /></RouteChunk>} />
          <Route path="roms" element={<RouteChunk><AdminRoms /></RouteChunk>} />
          <Route path="data" element={<RouteChunk><AdminData /></RouteChunk>} />
        </Route>
      </Routes>
    </>
  )
}
