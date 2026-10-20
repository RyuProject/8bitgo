/**
 * 全站共用的 body 滚动锁（引用计数）。
 *
 * 移动端抽屉、登录弹窗、通用 Modal、分享面板以前各自写 `body.style.overflow`：
 * 抽屉的 effect 每次都直接写 `''`，会把同一批提交里弹窗刚加的锁冲掉（手机上从抽屉点「登录」，
 * 弹窗开着背后页面照样能滚）；各自「记住 prev 再还原」在嵌套 / 乱序关闭时也会留下一把永远不放的锁。
 * 统一走这里：第一把锁加 hidden，最后一把放开才还原。
 */
let holders = 0
let saved = ''

export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (holders === 0) {
    saved = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  holders += 1
  let released = false
  return () => {
    if (released) return
    released = true
    holders = Math.max(0, holders - 1)
    if (holders === 0) document.body.style.overflow = saved
  }
}
