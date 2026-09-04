/**
 * 成人内容的年龄判定 —— 前后端共用同一份。
 *
 * 出生日期记在账号上（users.birth_date），服务端据此决定放不放行，
 * 前端只是把服务端的结论画出来；两边如果各写一份「满 18 岁」的算法，
 * 迟早会在生日当天、闰日、时区边界上得出不一样的结果。
 *
 * 本体必须是 .js：server/ 不过 TypeScript 编译。类型声明在同名 .d.ts 里手写，
 * 改了这里的导出记得同步那边。
 */

/** 成人内容的年龄线 */
export const ADULT_AGE = 18

/**
 * 出生年份的下限。1900 之前的日期基本只会是手滑（<input type="date"> 里年份多敲一位），
 * 放进去会让「已验证成人」永远为真，不如当场拦下让人改。
 */
export const MIN_BIRTH_YEAR = 1900

/**
 * 用本地年月日而不是 toISOString()：后者按 UTC 取日，东八区晚上十点的「今天」
 * 会被算成明天，西半球则相反。
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD
 */
export function localDateInputValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 解析 YYYY-MM-DD。不用 Date.parse —— 规范把不带时间的日期串当 UTC，
 * 在 UTC 以西的时区会落到前一天。日期不存在（2 月 30 日）或格式不对返回 null。
 * @param {unknown} value
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseBirthDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(year, month - 1, day, 12)
  if (
    !Number.isFinite(probe.getTime()) ||
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

/**
 * 按完整年月日判断是否年满 18 岁。
 *
 * 不能只做「当前年份 − 出生年份」：生日还没到的人会被提前放行。
 * 未来的日期、1900 年之前的日期、不存在的日期一律 'invalid'。
 *
 * @param {unknown} value  YYYY-MM-DD
 * @param {Date} [today]   默认当前时间；测试和服务端可以传固定值
 * @returns {'adult' | 'underage' | 'invalid'}
 */
export function checkAdultBirthDate(value, today = new Date()) {
  const parsed = parseBirthDate(value)
  if (!parsed || parsed.year < MIN_BIRTH_YEAR) return 'invalid'
  const { year, month, day } = parsed
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12)
  const birth = new Date(year, month - 1, day, 12)
  if (birth > now) return 'invalid'
  const years = now.getFullYear() - year
  const birthdayPassed = now.getMonth() > month - 1 || (now.getMonth() === month - 1 && now.getDate() >= day)
  return years > ADULT_AGE || (years === ADULT_AGE && birthdayPassed) ? 'adult' : 'underage'
}

/**
 * 账号上记的出生日期 -> 现在能不能玩成人内容。
 * 没填过是 false；填了但未满 18 也是 false —— 到生日当天这个函数自然开始返回 true，
 * 不需要任何定时任务去「解锁」。
 * @param {unknown} birthDate
 * @param {Date} [today]
 * @returns {boolean}
 */
export function isAdultByBirthDate(birthDate, today = new Date()) {
  return Boolean(birthDate) && checkAdultBirthDate(birthDate, today) === 'adult'
}
