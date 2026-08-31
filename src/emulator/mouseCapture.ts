import type { GenreId, PlatformId } from '@/types'

/**
 * 只有 DOS 射击游戏需要相对鼠标：它们通常把鼠标当作持续转向输入，光标碰到画布边缘就会失控。
 * 菜单、策略和模拟经营游戏依赖绝对坐标，锁定鼠标反而会让游戏光标与点击位置错位。
 */
export function shouldCaptureMouse(platform: PlatformId, genres?: readonly GenreId[]): boolean {
  return platform === 'dos' && Boolean(genres?.includes('shooter'))
}
