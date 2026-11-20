import type { ReactNode } from 'react'
import { cx } from '@/lib/format'
import './game-detail.css'

/**
 * 游戏详情页的页面骨架。播放器、资料和社区各自有稳定的版位，
 * 看直播/联机时只切换网格位置，不卸载播放器及其会话。
 */
export function GameDetailLayout({
  children,
  sessionLayout = false,
  immersive = false,
}: {
  children: ReactNode
  sessionLayout?: boolean
  immersive?: boolean
}) {
  return (
    <div className={cx('game-detail-layout', sessionLayout && 'game-detail-layout--session', immersive && 'game-detail-layout--immersive')}>
      {children}
    </div>
  )
}
