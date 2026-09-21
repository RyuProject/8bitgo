/**
 * site-notice.js 的类型声明。
 *
 * 本体必须是 .js（server/ 不过 TypeScript 编译，import 不了 .ts），
 * 所以按 age / dosbox-config 的同一套做法手写一份给前端用。
 * 改了 site-notice.js 的导出，记得同步这里。
 */

/** 两种语气。没有「关闭」这一档 —— 关掉由 enabled 表达 */
export type NoticeLevel = 'warn' | 'error'

/** 前台能画的那一份（visibleNotice 的结果；不可见时是 null） */
export interface VisibleSiteNotice {
  level: NoticeLevel
  text: string
}

/** 库里存的那一份（后台编辑器读的就是它） */
export interface StoredSiteNotice extends VisibleSiteNotice {
  enabled: boolean
}

export const NOTICE_LEVELS: readonly NoticeLevel[]
export const NOTICE_LEVEL_DEFAULT: NoticeLevel
export const NOTICE_TEXT_MAX: number

export function cleanNoticeText(raw: unknown): string
export function sanitizeNotice(input: unknown): StoredSiteNotice
export function visibleNotice(raw: unknown): VisibleSiteNotice | null
