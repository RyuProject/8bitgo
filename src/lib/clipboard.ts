/**
 * 复制文本，并在 Clipboard API 不存在或被权限策略拦住时退回老式选区复制。
 *
 * `navigator.clipboard` 只在安全上下文里可用，旧 Safari、部分电视浏览器、HTTP 内网地址以及
 * 被嵌入的页面都可能拿不到。复制按钮属于便利功能，不能因为这一项缺失就抛异常或毫无反应。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限拒绝后仍值得试同步退路；Safari 有时只允许当前点击事件里的 execCommand。
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(textarea)
  try {
    textarea.focus({ preventScroll: true })
  } catch {
    textarea.focus()
  }
  textarea.select()
  // iOS 需要显式范围；只调 select() 在某些旧 WebKit 里不会真正建立选区。
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
    if (active) {
      try {
        active.focus({ preventScroll: true })
      } catch {
        active.focus()
      }
    }
  }
  return copied
}
