import type { GenreId, PlatformId } from '@/types'

/**
 * DOSBox 里的鼠标必须留在客体里：射击游戏用它持续转向，策略 / Windows 客体则自己画光标。
 * 若只给 shooter 标签开相对鼠标，标签缺失或分类为 action 的游戏里系统指针会直接跑出画面，
 * 客体光标随即停住。js-dos 在触屏设备上会自行禁用 Pointer Lock，所以这里对全部 DOS 开启；
 * 桌面端点击画面捕获、Esc 释放，和本地 DOSBox 的行为一致。
 */
export function shouldCaptureMouse(platform: PlatformId, _genres?: readonly GenreId[]): boolean {
  return platform === 'dos'
}
