import type { Platform } from '@/types'
import { cx } from '@/lib/format'
import nesPlatformIcon from '@/assets/ui/NES.svg'

// 静态图标走 Vite 内容哈希，避免公共路径只有一小时缓存；后台自定义图仍保留原 URL。
const HASHED_PLATFORM_ICONS: Record<string, string> = { nes: nesPlatformIcon }

/**
 * 平台图标：有自制图就用图，没有就退回 emoji。
 *
 * 想给某个平台换成自制图标，只要两步：
 *   1. 把 svg 丢进 public/ui/
 *   2. 在 src/data/platforms.ts 对应平台加一行 image: '/ui/XXX.svg'
 * 站内固定图标若要长期缓存，再在 HASHED_PLATFORM_ICONS 里映射到 src/assets 的哈希资源。
 * 用到本组件的地方都会自动跟着换，不用挨个改页面。
 *
 * className 由调用方给（不同位置的图标尺寸不一样），外面那层带背景色和边框的
 * 方框也仍然由调用方控制 —— 这里只负责「图还是 emoji」。
 */
export function PlatformIcon({
  platform,
  className,
}: {
  platform: Pick<Platform, 'id' | 'icon' | 'image'>
  className?: string
}) {
  if (!platform.image) return <>{platform.icon}</>
  const src = HASHED_PLATFORM_ICONS[platform.id] ?? platform.image
  return (
    <img
      src={src}
      alt=""
      className={cx('object-contain', className)}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  )
}
