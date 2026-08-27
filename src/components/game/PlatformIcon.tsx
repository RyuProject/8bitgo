import type { Platform } from '@/types'
import { cx } from '@/lib/format'

/**
 * 平台图标：有自制图就用图，没有就退回 emoji。
 *
 * 想给某个平台换成自制图标，只要两步：
 *   1. 把 svg 丢进 public/ui/
 *   2. 在 src/data/platforms.ts 对应平台加一行 image: '/ui/XXX.svg'
 * 用到本组件的地方都会自动跟着换，不用挨个改页面。
 *
 * className 由调用方给（不同位置的图标尺寸不一样），外面那层带背景色和边框的
 * 方框也仍然由调用方控制 —— 这里只负责「图还是 emoji」。
 */
export function PlatformIcon({
  platform,
  className,
}: {
  platform: Pick<Platform, 'icon' | 'image'>
  className?: string
}) {
  if (!platform.image) return <>{platform.icon}</>
  return (
    <img
      src={platform.image}
      alt=""
      className={cx('object-contain', className)}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  )
}
