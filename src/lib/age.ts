/**
 * 成人内容年龄判定的前端入口。
 *
 * 算法本体搬到了 shared/age.js（服务端要用同一份来决定放不放行），
 * 这里只是转发，免得已有的 import 路径全部改一遍。
 */
export { ADULT_AGE, MIN_BIRTH_YEAR, checkAdultBirthDate, isAdultByBirthDate, localDateInputValue, parseBirthDate } from '../../shared/age.js'
export type { AdultAgeResult } from '../../shared/age.js'
