/** 出生日期验证结果。出生日期属于敏感个人信息，调用方只应使用结果，不应持久化原值。 */
export type AdultAgeResult = 'adult' | 'underage' | 'invalid'

/** 用本地年月日而不是 toISOString()，避免 UTC 时差让“今天”在部分时区提前或延后一天。 */
export function localDateInputValue(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 按完整年月日判断是否年满 18 岁。
 *
 * 不能只做“当前年份 - 出生年份”：生日还没到的人会被提前放行。解析时也不用
 * Date.parse('YYYY-MM-DD')，因为规范把它当 UTC 日期，不同地区可能落到前一天。
 */
export function checkAdultBirthDate(value: string, today = new Date()): AdultAgeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return 'invalid'
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const birth = new Date(year, month - 1, day, 12)
  if (
    !Number.isFinite(birth.getTime()) ||
    birth.getFullYear() !== year ||
    birth.getMonth() !== month - 1 ||
    birth.getDate() !== day
  ) {
    return 'invalid'
  }

  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12)
  if (birth > now) return 'invalid'
  const years = now.getFullYear() - year
  const birthdayPassed = now.getMonth() > month - 1 || (now.getMonth() === month - 1 && now.getDate() >= day)
  return years > 18 || (years === 18 && birthdayPassed) ? 'adult' : 'underage'
}
