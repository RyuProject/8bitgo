import type { PlatformId } from '@/types'

/**
 * 目前对外开放的平台白名单。不在名单里的平台、以及它们的游戏，前台一律不展示
 * （后台 /admin 仍可看到并管理全部平台的游戏）。
 *
 * 想开放更多平台：把对应 id 加进来即可。想恢复「全部平台」：把数组清空 []。
 *
 * 说明：GBC（Game Boy Color）并入 gb（我们的「Game Boy / Color」平台，支持 .gbc）；
 *       WebGame / 网页游戏 即 flash（平台名「Flash / 网页游戏」）。
 */
export const ENABLED_PLATFORMS: PlatformId[] = ['nes', 'flash', 'gba', 'gb', 'java', 'arcade']

export function isPlatformEnabled(id: PlatformId): boolean {
  return ENABLED_PLATFORMS.length === 0 || ENABLED_PLATFORMS.includes(id)
}
