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
 * 侧边栏最上面那三条，不带分组标题。
 * 直播（FEATURES.live）和博客都不放这儿了 —— 前者没开放，后者挪到了最底部。
 *
 * 合集从「探索」挪上来：那一组是按平台 / 类型 / 开发商这些**属性**切游戏库，
 * 而合集是玩家自己攒的清单，跟「一起玩」一样属于社区那一路，不是一种筛选维度。
 */
export function mainNavFor(t: Translation): NavLinkItem[] {
  return [
    { label: t.nav.discover, to: '/', icon: '🏠', exact: true },
    { label: t.nav.playOnline, to: '/rooms', icon: '👥', exact: true },
    { label: t.collections.title, to: '/collections', icon: '🗂️', exact: true },
  ]
}

/** 「探索」分组：按游戏自身的属性切游戏库（合集不在这儿，见 mainNavFor） */
export function exploreNavFor(t: Translation): NavLinkItem[] {
  return [
    { label: t.nav.allGames, to: '/games', icon: '📚', exact: true },
    { label: t.nav.platforms, to: '/platforms', icon: '🎮' },
    { label: t.nav.genres, to: '/genres', icon: '🧭' },
    { label: t.nav.developers, to: '/developers', icon: '🏢' },
  ]
}

/**
 * 侧边栏最底下的零散入口。博客从上面挪到这儿，免得跟浏览游戏的几条混在一起。
 *
 * 「提交游戏」已经挪去页脚（见 footerLinksFor）：侧边栏是玩家找游戏的主路径，
 * 而投稿是少数人偶尔做一次的事，占一格常驻位置不划算。
 */
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
    // 「服务与隐私」把原来的服务条款 + 隐私政策合并成一格。
    // 目前先指向服务条款页；如果以后要做成合并的法律页，改这个 to 即可。
    { label: '服务与隐私', to: '/terms' },
    /*
      开放平台的开发者入口。放页脚是合适的位置：它面向的是少数人、偶尔来一次。
      ⚠️ 文案写死中文，和它指向的那一页一致 —— 那一页管理的东西（文档、scope 语义、
      错误码）只有中文一份，给入口翻八种语言只会让人点进去发现看不懂。
    */
    { label: '开放平台', to: '/open' },
    ...(FEATURES.live ? [{ label: '8BitGo TV', to: '/rooms?live=1' }] : []),
    { label: '本地游玩', to: '/play-local' },
  ]
}
