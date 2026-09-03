/**
 * site-taxonomy.js 的类型声明。
 *
 * 本体必须是 .js（server/ 不过 TypeScript 编译，import 不了 .ts），
 * 所以按 site-languages / dosbox-config 的同一套做法，手写一份 .d.ts 给前端用。
 * 改了 site-taxonomy.js 的导出，记得同步这里。
 *
 * 这里一律用 string 而不是字面量联合：ENABLED_PLATFORM_IDS 允许被清空成 []，
 * 平台 id 的窄类型（PlatformId）留给 src/config/platforms.ts 去套。
 */

export const ENABLED_PLATFORM_IDS: readonly string[]

export function isPlatformEnabledId(id: string): boolean

export const GENRE_IDS: readonly string[]
