import { Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { HomePage } from '@/pages/HomePage'
import { GamesPage } from '@/pages/GamesPage'
import { GameDetailPage } from '@/pages/GameDetailPage'
import { PlayLocalPage } from '@/pages/PlayLocalPage'
import { DevelopersPage, GenresPage, PlatformsPage } from '@/pages/BrowsePages'
import { ComingSoonPage } from '@/pages/ComingSoonPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { BlogPage } from '@/pages/BlogPage'
import { PostPage } from '@/pages/PostPage'
import { LoginPage } from '@/pages/LoginPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { AdminLayout } from '@/admin/AdminLayout'
import { AdminOverview } from '@/admin/AdminOverview'
import { AdminGames } from '@/admin/AdminGames'
import { AdminData } from '@/admin/AdminData'
import { AdminUsers } from '@/admin/AdminUsers'
import { AdminPosts } from '@/admin/AdminPosts'
import { AdminRoms } from '@/admin/AdminRoms'

const COMING_SOON_ROUTES = [
  '/apps',
  '/about',
  '/terms',
  '/privacy',
  '/tv',
]

export function AppRoutes() {
  return (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GameDetailPage />} />
          <Route path="/platforms" element={<PlatformsPage />} />
          <Route path="/genres" element={<GenresPage />} />
          <Route path="/developers" element={<DevelopersPage />} />
          <Route path="/play-local" element={<PlayLocalPage />} />
          <Route path="/blog" element={<BlogPage />} />
          <Route path="/blog/:slug" element={<PostPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/me" element={<ProfilePage />} />
          {COMING_SOON_ROUTES.map((path) => (
            <Route key={path} path={path} element={<ComingSoonPage />} />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* 后台：独立外壳，不带前台侧边栏 */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminOverview />} />
          <Route path="games" element={<AdminGames />} />
          <Route path="posts" element={<AdminPosts />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="roms" element={<AdminRoms />} />
          <Route path="data" element={<AdminData />} />
        </Route>
      </Routes>
  )
}
