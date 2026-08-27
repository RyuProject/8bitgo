/** 侧边栏 / 抽屉共用的导航配置（标题随语言变化，所以做成取 t 的函数） */
import { FEATURES } from '@/config/features'
import type { Translation } from '@/locales'

export interface NavLinkItem {
  label: string
  to: string
  icon: string
  /** 精确匹配 pathname + search；不设置时按 pathname 前缀匹配 */
  exact?: boolean
  external?: boolean
  badge?: string
  /** 功能尚未开放：置灰、不可点击，并显示 coming soon 标签 */
  disabled?: boolean
}

export interface NavGroup {
  title: string
  items: NavLinkItem[]
}

/**
 * 侧边栏最上面那两条，不带分组标题。
 * 直播（FEATURES.live）和博客都不放这儿了 —— 前者没开放，后者挪到了最底部。
 */
export function mainNavFor(t: Translation): NavLinkItem[] {
  return [
    { label: t.nav.discover, to: '/', icon: '🏠', exact: true },
    { label: t.nav.playOnline, to: '/rooms', icon: '👥', exact: true },
  ]
}

/** 「探索」分组：按不同维度浏览游戏库 */
export function exploreNavFor(t: Translation): NavLinkItem[] {
  return [
    { label: t.nav.allGames, to: '/games', icon: '📚', exact: true },
    { label: t.nav.platforms, to: '/platforms', icon: '🎮' },
    { label: t.nav.genres, to: '/genres', icon: '🧭' },
    { label: t.nav.developers, to: '/developers', icon: '🏢' },
  ]
}

/** 侧边栏最底下的零散入口。博客从上面挪到这儿，免得跟浏览游戏的几条混在一起。 */
export function bottomNavFor(t: Translation): NavLinkItem[] {
  return [{ label: t.nav.blog, to: '/blog', icon: '📝' }]
}

export interface CommunityLink {
  id: 'discord' | 'x' | 'youtube' | 'instagram' | 'facebook'
  label: string
  href: string
}

/** 侧边栏底部「玩家社区」：全部为外部链接，替换成你自己的社群地址即可 */
export const communityLinks: CommunityLink[] = [
  { id: 'discord', label: 'Discord', href: 'https://discord.com' },
  { id: 'x', label: 'X / Twitter', href: 'https://x.com' },
  { id: 'youtube', label: 'YouTube', href: 'https://youtube.com' },
  { id: 'instagram', label: 'Instagram', href: 'https://instagram.com' },
  { id: 'facebook', label: 'Facebook', href: 'https://facebook.com' },
]

export function footerLinksFor(t: Translation) {
  return [
    { label: t.nav.about, to: '/about' },
    { label: t.nav.terms, to: '/terms' },
    { label: t.nav.privacy, to: '/privacy' },
    { label: t.nav.apps, to: '/apps' },
    ...(FEATURES.live ? [{ label: '8BitGo TV', to: '/rooms?live=1' }] : []),
    { label: t.nav.playLocal, to: '/play-local' },
  ]
}
