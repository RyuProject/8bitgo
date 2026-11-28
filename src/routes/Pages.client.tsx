import { lazyNamed } from './lazy'
import { loadLegalLocale } from '@/locales'
import { getLang } from '@/services/lang'

/**
 * 客户端按路由下载页面；法律正文和页面组件都只在访问法律页时下载。
 * 服务端使用同名的 Pages.tsx 同步渲染，水合时由 Layout 的 Suspense 留住已渲染的页面。
 */
export const GamesPage = lazyNamed(() => import('@/pages/GamesPage'), 'GamesPage')
export const GameDetailPage = lazyNamed(() => import('@/pages/GameDetailPage'), 'GameDetailPage')
export const PlayLocalPage = lazyNamed(() => import('@/pages/PlayLocalPage'), 'PlayLocalPage')
export const RoomsPage = lazyNamed(() => import('@/pages/RoomsPage'), 'RoomsPage')
export const CollectionsPage = lazyNamed(() => import('@/pages/CollectionsPage'), 'CollectionsPage')
export const CollectionDetailPage = lazyNamed(() => import('@/pages/CollectionDetailPage'), 'CollectionDetailPage')
export const DevelopersPage = lazyNamed(() => import('@/pages/BrowsePages'), 'DevelopersPage')
export const GenresPage = lazyNamed(() => import('@/pages/BrowsePages'), 'GenresPage')
export const PlatformsPage = lazyNamed(() => import('@/pages/BrowsePages'), 'PlatformsPage')
export const GenrePage = lazyNamed(() => import('@/pages/CollectionPage'), 'GenrePage')
export const PlatformPage = lazyNamed(() => import('@/pages/CollectionPage'), 'PlatformPage')
export const RomLanguagePage = lazyNamed(() => import('@/pages/CollectionPage'), 'RomLanguagePage')
export const ComingSoonPage = lazyNamed(() => import('@/pages/ComingSoonPage'), 'ComingSoonPage')
export const NotFoundPage = lazyNamed(() => import('@/pages/NotFoundPage'), 'NotFoundPage')
export const BlogPage = lazyNamed(() => import('@/pages/BlogPage'), 'BlogPage')
export const PostPage = lazyNamed(() => import('@/pages/PostPage'), 'PostPage')
export const LoginPage = lazyNamed(() => import('@/pages/LoginPage'), 'LoginPage')
export const ProfilePage = lazyNamed(() => import('@/pages/ProfilePage'), 'ProfilePage')
export const AboutPage = lazyNamed(() => import('@/pages/AboutPage'), 'AboutPage')
/** 法律正文与页面同批预载，避免懒组件渲染时拿不到文案。 */
export const TermsPage = lazyNamed(
  () => Promise.all([import('@/pages/TermsPage'), loadLegalLocale(getLang())]).then(([page]) => page),
  'TermsPage',
)
export const PrivacyPage = lazyNamed(
  () => Promise.all([import('@/pages/PrivacyPage'), loadLegalLocale(getLang())]).then(([page]) => page),
  'PrivacyPage',
)
export const SubmitGamePage = lazyNamed(() => import('@/pages/SubmitGamePage'), 'SubmitGamePage')
export const EmbedPage = lazyNamed(() => import('@/pages/EmbedPage'), 'EmbedPage')
export const AppsPage = lazyNamed(() => import('@/pages/AppsPage'), 'AppsPage')
export const OAuthCallbackPage = lazyNamed(() => import('@/pages/OAuthCallbackPage'), 'OAuthCallbackPage')
export const OpenPlatformPage = lazyNamed(() => import('@/pages/OpenPlatformPage'), 'OpenPlatformPage')
export const OpenDevicePage = lazyNamed(() => import('@/pages/OpenDevicePage'), 'OpenDevicePage')
export const OpenAuthorizePage = lazyNamed(() => import('@/pages/OpenAuthorizePage'), 'OpenAuthorizePage')
export const TvPage = lazyNamed(() => import('@/pages/TvPage'), 'TvPage')
export const SymbianPage = lazyNamed(() => import('@/pages/SymbianPage'), 'SymbianPage')
export const PokecatchSaveSyncPage = lazyNamed(() => import('@/pages/PokecatchSaveSyncPage'), 'PokecatchSaveSyncPage')
