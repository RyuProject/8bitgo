/**
 * 开发商仍保存在一个字符串字段里，但录入和展示都按逗号拆分。
 * 同时认英文、中文逗号，免得中文输入法下不小心录成两种数据格式。
 */
export function splitDevelopers(value: string | undefined | null): string[] {
  const seen = new Set<string>()
  return String(value ?? '')
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter((name) => {
      if (!name) return false
      const key = name.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** 库里统一保存成「公司 A, 公司 B」，方便 SQL 稳定拆分。 */
export function normalizeDevelopers(value: string | undefined | null): string {
  return splitDevelopers(value).join(', ')
}
