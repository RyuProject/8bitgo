/**
 * 整页全屏（TV 端回车开玩时用）。
 *
 * ## ⚠️ 两条硬约束，少一条全屏就进不去
 *
 * 1. **必须在用户手势的同步调用栈里调**。全屏要 transient activation：放进 useEffect、
 *    setTimeout、await 之后的那半截，浏览器一律拒绝（Chrome 控制台只给一句
 *    `Permissions check failed`，不报错、不抛异常，看起来像「什么都没发生」）。
 *    所以它挂在 `<Link>` 的 onClick 上 —— FocusScope 的回车是 `el.click()` 派发的，
 *    同步落在同一个 keydown 手势里。
 *
 * 2. **进全屏之后的跳转必须是同文档的前端路由跳转**（`<Link>` / `navigate`）。
 *    整页重新加载会让全屏状态消失，而新页面上没有手势可用，补不回来 ——
 *    所以 TV 那边是 `<Link>` 不是 `<a>`，这条和上面一条一样是硬的。
 *
 * 失败一律吞掉：全屏进不去也不该挡住「开始玩」这件事本身。
 */
export function enterFullscreen(el: Element = document.documentElement): void {
  // 已经在全屏里（比如玩家自己按过 F11 或播放器的全屏键）就别再要一次
  if (document.fullscreenElement) return
  // iOS Safari 的 iPhone 版没有元素全屏；企业策略也可能关掉
  if (document.fullscreenEnabled === false) return
  const req = el.requestFullscreen
  if (typeof req !== 'function') return
  /*
    两种失败都要吞掉，而且**同步抛那种必须用 try/catch 兜**：
    `Promise.resolve(...).catch()` 只接得住 reject，接不住同步抛出的异常。
    这一下是在 <Link> 的 onClick 里跑的 —— 抛出去会连带把「跳转过去开玩」一起掐掉，
    于是回车之后既没全屏也没进游戏。规范里它返回 rejected promise，但老实现和
    被策略挡住的情况会直接 throw，两条路都得堵上。
  */
  try {
    // navigationUI: 'hide' 是「能藏就藏地址栏」，不支持的浏览器忽略它
    const done = req.call(el, { navigationUI: 'hide' })
    if (done && typeof done.catch === 'function') void done.catch(() => {})
  } catch {
    /* 进不去全屏也不该挡住开始玩这件事 */
  }
}
