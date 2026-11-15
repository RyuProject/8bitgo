/**
 * `navigator.getGamepads()` 在被权限策略挡住时会**抛错**，而不是返回空数组。
 *
 * 2026-11-14 大陆 iPad iOS 17 应用内浏览器（WKWebView）《拳皇 97 风云再起 Plus》：本站页面被别的应用 /
 * 网站用 iframe 嵌着、外层没给 `allow="gamepad"`，WebKit 就把整条框架链都当第三方，`getGamepads()` 抛
 * `SecurityError: Third-party iframes are not allowed to call getGamepads() unless explicitly allowed via
 * Feature-Policy (gamepad)`。我们自己的 iframe 早就带了 `allow="gamepad"`，但子框架拿不到父框架没有的权限。
 *
 * EmulatorJS 的 GamepadHandler 在构造函数里同步跑第一轮 `loop()` → `getGamepads()`，一抛错整个引擎在建
 * 起来之前就死了：核心一字节都没下，玩家对着「加载中」等满两分钟看门狗（换线路重试又是两分钟）。
 * 手柄用不了不该让游戏用不了 —— 读不到就当没有手柄。
 */

type GamepadNavigator = Navigator & { webkitGetGamepads?: () => ArrayLike<Gamepad | null> }

/** 读一次手柄快照；API 不存在或被权限策略挡住都返回空数组。 */
export function readGamepadsSafe(nav: GamepadNavigator | undefined | null): ArrayLike<Gamepad | null> {
  try {
    if (!nav) return []
    if (typeof nav.getGamepads === 'function') return nav.getGamepads() ?? []
    if (typeof nav.webkitGetGamepads === 'function') return nav.webkitGetGamepads() ?? []
  } catch {
    /* SecurityError：权限策略不放行 */
  }
  return []
}

/**
 * 在引擎 iframe 里、loader.js 之前把 `navigator.getGamepads` 换成不会抛错的版本。
 * 返回此刻是否真的被挡住（写进诊断包）；换不掉（只读属性等）时返回 null，让调用方照常继续。
 */
export function guardFrameGamepads(win: Window): boolean | null {
  const nav = win.navigator as GamepadNavigator | undefined
  if (!nav || typeof nav.getGamepads !== 'function') return null
  const native = nav.getGamepads.bind(nav)
  let blocked = false
  try {
    native()
  } catch {
    blocked = true
  }
  try {
    // 权限可能在之后才变（外层框架被换掉 / 策略变化），所以不论此刻挡没挡住都包一层
    Object.defineProperty(nav, 'getGamepads', {
      configurable: true,
      writable: true,
      value: () => {
        try {
          return native() ?? []
        } catch {
          return []
        }
      },
    })
    return blocked
  } catch {
    return null
  }
}
