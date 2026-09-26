/**
 * 把任意字符串安全地放进属性选择器。
 *
 * CSS.escape 在旧电视内核和 Safari 9 以下不存在；这里只有 slug / 焦点 id，仍实现完整的
 * CSSOM 转义规则，避免引号、反斜杠或控制字符把 querySelector 变成非法选择器。
 */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)

  const input = String(value)
  let out = ''
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    if (code === 0) {
      out += '\uFFFD'
      continue
    }
    if (
      (code >= 1 && code <= 31)
      || code === 127
      || (i === 0 && code >= 48 && code <= 57)
      || (i === 1 && code >= 48 && code <= 57 && input.charCodeAt(0) === 45)
    ) {
      out += `\\${code.toString(16)} `
      continue
    }
    if (i === 0 && code === 45 && input.length === 1) {
      out += '\\-'
      continue
    }
    if (
      code >= 128
      || code === 45
      || code === 95
      || (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    ) {
      out += input.charAt(i)
    } else {
      out += `\\${input.charAt(i)}`
    }
  }
  return out
}
