import type { GenreId, PlatformId } from '@/types'

/**
 * 默认只有 DOS 射击游戏使用相对鼠标：它们通常把鼠标当作持续转向输入，碰到画布边缘就会失控。
 * 其他类型默认走绝对坐标，但允许逐游戏覆盖，绕过 js-dos v8 在少数游戏里的光标回中缺陷。
 */
export function shouldCaptureMouse(
  platform: PlatformId,
  genres?: readonly GenreId[],
  override?: boolean,
): boolean {
  if (platform !== 'dos') return false
  return override ?? Boolean(genres?.includes('shooter'))
}
