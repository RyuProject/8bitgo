import type { PlatformId } from '@/types'
import { ENABLED_PLATFORM_IDS, isPlatformEnabledId } from '../../shared/site-taxonomy.js'

/**
 * 目前对外开放的平台白名单。
 *
 * 名单本身搬到了 shared/site-taxonomy.js —— 后端的实时 sitemap 也要用它，
 * 而 server/ 不经过 TypeScript 编译、import 不了 .ts。想改开放范围就改那个文件，
 * 这里只负责套上 PlatformId 类型。
 */
export const ENABLED_PLATFORMS: PlatformId[] = ENABLED_PLATFORM_IDS as PlatformId[]

export function isPlatformEnabled(id: PlatformId): boolean {
  return isPlatformEnabledId(id)
}
