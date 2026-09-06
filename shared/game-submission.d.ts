/**
 * game-submission.js 的类型声明。
 *
 * 本体必须是 .js（server/ 不过 TypeScript 编译，import 不了 .ts），
 * 按 age / roles / lanczos 的同一套做法手写一份给前端用。
 * 改了 game-submission.js 的导出记得同步这里。
 */

export type SubmitRomLang = 'en' | 'ja' | 'zh' | 'zhHant' | 'de' | 'fr' | 'it' | 'es'

export const SUBMIT_ROM_LANGS: SubmitRomLang[]
export const SUBMIT_ROM_LANG_LABEL_ZH: Record<SubmitRomLang, string>
export const ALLOWED_ROM_EXT: string[]
export const DEFAULT_SUBMIT_MAX_FILE_MB: number
export const DEFAULT_SUBMIT_MAX_TOTAL_MB: number

export function romExtOf(filename: unknown): string
export function isAllowedRomExt(filename: unknown): boolean
