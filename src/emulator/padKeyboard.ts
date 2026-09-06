import { getPadKeys, onPadKeysChange, parseBinding, type PadAction, type Seat } from '@/services/padKeys'

/**
 * 把键盘接进红白机（jsnes）。
 *
 * jsnes 自带一套 document 级键盘监听，但我们在 adapters/jsnes.ts 里把它的映射表清空
 * 停用了 —— 理由写在 services/padKeys.ts 的开头（keyCode vs code、裸 localStorage['keys']、
 * 以及 disableIfGamepadEnabled 那个静默失效）。这里是替代品。
 *
 * 几个必须这么写的地方：
 *
 *  - **挂在冒泡阶段**。站里的存读档快捷键（emulator/hotkeyBridge.ts）走的是**捕获**阶段
 *    并且 stopPropagation，所以它认领过的键根本到不了这儿 —— 这正是想要的优先级：
 *    F2 存档永远不会被当成游戏按键。改键界面同理（window 捕获 + stopPropagation），
 *    所以玩家正在录新键位时不会顺手往游戏里发一个按键。
 *  - **输入框里不接**。玩家在评论框打字按到 X 不该让马力欧跳一下。
 *  - **只在状态变化时发**。keydown 按住会连发，jsnes 那边重复置位没有意义，
 *    而且连发键（turbo）本来就是它自己按帧翻转的。
 *  - **失焦要把按着的键全松开**。不松的话玩家 Alt+Tab 出去再回来，
 *    角色带着「一直往右」继续跑 —— 这条是 gamepadInput.ts 那边踩过的。
 */

type Send = (action: PadAction, down: boolean, seat: Seat) => void

function isEditable(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  if (node.isContentEditable) return true
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT'
}

/** 装上键盘输入。返回卸载函数 */
export function installPadKeyboard(send: Send): () => void {
  let map = getPadKeys()
  /** 现在按着的物理键。既用来去重，也用来在失焦时逐个松开 */
  const held = new Set<string>()

  const release = (code: string) => {
    if (!held.delete(code)) return
    // 用**按下那一刻**的映射来松开，不然玩家玩着玩着改了键，会漏一次 keyup
    const parsed = parseBinding(pressedAs.get(code) ?? '')
    pressedAs.delete(code)
    if (parsed) send(parsed.action, false, parsed.seat)
  }
  /** 每个按下的键当时算作哪条绑定 */
  const pressedAs = new Map<string, string>()

  const releaseAll = () => {
    for (const code of [...held]) release(code)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditable(e.target)) return
    const binding = map[e.code]
    if (!binding) return
    // 命中就吃掉：不拦的话方向键会滚页面、空格会翻屏
    e.preventDefault()
    if (held.has(e.code)) return
    const parsed = parseBinding(binding)
    if (!parsed) return
    held.add(e.code)
    pressedAs.set(e.code, binding)
    send(parsed.action, true, parsed.seat)
  }

  const onKeyUp = (e: KeyboardEvent) => {
    if (!held.has(e.code)) {
      // 没记着的键也可能是我们的（在输入框里按下、移出来才松开），一律不拦
      return
    }
    e.preventDefault()
    release(e.code)
  }

  const onBlur = () => releaseAll()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') releaseAll()
  }

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  const unsubscribe = onPadKeysChange(() => {
    map = getPadKeys()
  })

  return () => {
    unsubscribe()
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
    // 拆的时候也要松开：不松就等于把「按着」的状态留给了下一局
    releaseAll()
  }
}
