/**
 * 站内离开确认之后重放原链接。
 *
 * 不能在 confirm(true) 后继续依赖原来的 click：部分移动端 Chromium 从同步确认框回来时，
 * 会丢掉那次事件后半段，React Router 因而永远收不到它。这里先明确取消旧事件，再用
 * anchor.click() 发一条新的；重放标记让新事件只放行、不再弹第二次确认。
 */
export interface LeaveNavigationReplay {
  current: HTMLAnchorElement | null
}

type ClickGateEvent = Pick<MouseEvent, 'preventDefault' | 'stopPropagation'>

export type LeaveNavigationResult = 'bypass' | 'cancelled' | 'replayed'

export function confirmAndReplayAnchorNavigation(
  event: ClickGateEvent,
  anchor: HTMLAnchorElement,
  message: string,
  replaying: LeaveNavigationReplay,
  confirmLeave: (message: string) => boolean = (text) => window.confirm(text),
): LeaveNavigationResult {
  // anchor.click() 会同步再次走到 document 捕获监听。只放行这一条重放事件，避免递归弹窗。
  if (replaying.current === anchor) {
    replaying.current = null
    return 'bypass'
  }

  // 无论玩家选哪一项，原事件都不再继续；确定时由下面的新 click 接管导航。
  event.preventDefault()
  event.stopPropagation()
  if (!confirmLeave(message)) return 'cancelled'

  replaying.current = anchor
  try {
    anchor.click()
  } finally {
    // 如果链接已经从 DOM 移除、浏览器没派发 click，不能让下一次真实点击误闯过守卫。
    if (replaying.current === anchor) replaying.current = null
  }
  return 'replayed'
}
