/**
 * iframe 运行时的「焦点」与「手柄读数」两件小事。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────
 * 浏览器只把键盘和手柄输入交给**有焦点的那个文档**。我们的播放器里，
 * 「▶ 开始」按钮画在外层页面上，EmulatorJS / Ruffle / html5 / webretro / J2ME
 * 却都跑在 iframe 里 —— 玩家点完开始，焦点停在那个按钮上，iframe 从头到尾
 * 没有拿到过焦点。结果：
 *
 *   · 键盘：引擎的 keydown 监听挂在 iframe 内部的元素上，一个事件都收不到。
 *     玩家必须先用鼠标点一下画面，键盘才活过来 —— 这就是「不点一下没反应」。
 *   · 手柄：更彻底。手柄对每个文档是**分别**可见的（规范里的 [[hasGamepadGesture]]：
 *     玩家按下手柄按键的那一刻，只有当时有焦点的文档才拿得到手柄），
 *     所以 iframe 里的 navigator.getGamepads() 永远返回一串 null，
 *     引擎自带的手柄支持等于全废。而且它连点一下画面都救不回来 ——
 *     点完画面之后还得**再按一次手柄按键**才行。
 *
 * 2026-09-03 用 Playwright 实测（外层一个按钮 + 一个同源 srcdoc iframe）：
 *   点外层按钮后            → iframe 内 document.hasFocus() === false
 *   iframe.focus() 之后      → true
 *   玩家点进 iframe 画面之后  → true
 *
 * 所以开局之后（以及手柄接上时）主动把焦点还给 iframe，两个问题一起解决。
 */

/**
 * 把焦点交给这个 iframe。
 *
 * 一定要用 iframe 元素的 focus({ preventScroll: true })，不能用 contentWindow.focus()
 * —— 后者没有 preventScroll，手机上会把页面猛地滚到播放器，玩家刚看的那段介绍就飞了。
 */
export function focusFrame(iframe: HTMLIFrameElement | null | undefined): void {
  try {
    iframe?.focus({ preventScroll: true })
  } catch {
    /* iframe 已经被拆了就算了 */
  }
}

/**
 * 读 iframe 那一侧看得到的手柄名字。
 *
 * 同源才读得到；跨源（现在没有这种运行时）会抛，按「读不到」处理。
 * 返回的是名字数组而不是 Gamepad 对象：Gamepad 是活的快照，跨文档存着容易读到过期值，
 * 而工具栏那个面板只需要「几个、都叫什么」。
 */
export function frameGamepads(iframe: HTMLIFrameElement | null | undefined): string[] {
  try {
    const nav = iframe?.contentWindow?.navigator
    if (!nav || typeof nav.getGamepads !== 'function') return []
    return Array.from(nav.getGamepads())
      .filter((p): p is Gamepad => Boolean(p?.connected))
      .map((p) => p.id)
  } catch {
    return []
  }
}
