/**
 * age.js 的类型声明。
 *
 * 本体必须是 .js（server/ 不过 TypeScript 编译，import 不了 .ts），
 * 所以按 roles / isolated-embeds 的同一套做法手写一份给前端用。
 * 改了 age.js 的导出，记得同步这里。
 */

/** 出生日期验证结果。出生日期属于敏感个人信息，除了写入账号的那一次之外不要在别处持久化。 */
export type AdultAgeResult = 'adult' | 'underage' | 'invalid'

export const ADULT_AGE: number
export const MIN_BIRTH_YEAR: number

export function localDateInputValue(date?: Date): string
export function parseBirthDate(value: unknown): { year: number; month: number; day: number } | null
export function checkAdultBirthDate(value: unknown, today?: Date): AdultAgeResult
export function isAdultByBirthDate(birthDate: unknown, today?: Date): boolean
