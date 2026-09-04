/**
 * 物理手柄 → 运行时按键。
 *
 * ── 为什么要我们自己来 ───────────────────────────────────────
 * jsnes 自带一个 GamepadController，但它的配置是**按 gamepad.id 逐个记**的
 * （`{ playerGamepadId: [...], configs: { '<pad.id>': { buttons: [...] } } }`），
 * 而 gamepad.id 是「Xbox 360 Controller (XInput STANDARD GAMEPAD)」这种由驱动给的字符串 ——
 * 玩家插上之前我们压根不知道它叫什么，也就没法预先配一份默认映射。
 * 那条路只有配合一套「按一下这个键」的绑定界面才走得通。
 *
 * 而 Gamepad API 本身已经给了标准布局（`mapping === 'standard'`：下方键 0、右侧键 1、
 * SELECT 8、START 9、十字键 12~15），绝大多数手柄都照它报。所以这里直接按下标读，
 * 喂给 RuntimeHandle.sendButton（和屏幕手柄同一个入口，见 types.ts）。
 *
 * ⚠️ EmulatorJS 那一路**不要**用这个：它在 iframe 里自己处理手柄（iframe 上带着
 * `allow="gamepad"`），两边同时喂会变成一按走两格。
 */
import type { PadButton } from './types'

/**
 * 标准布局的按钮下标 → 手柄键。
 *
 * 面对面两组各映一次是故意的：下方键（Xbox A / PS ✕）和左侧键（X / □）都是 B，
 * 右侧键（B / ○）和上方键（Y / △）都是 A。红白机只有两个动作键，多出来的两个
 * 空着不如让玩家能两指交替连发 —— 马里奥里按住 B 冲刺的同时还要连点 A 跳，
 * 单指来回搓很难受。
 */
const BUTTON_MAP: Record<number, PadButton> = {
  0: 'b',
  1: 'a',
  2: 'b',
  3: 'a',
  8: 'select',
  9: 'start',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
}

/** 摇杆推过这个量才算按下方向键。0.5 是手感和误触之间的常用折中 */
const DEADZONE = 0.5

const ALL: PadButton[] = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right']

/**
 * 读一遍所有手柄，算出「此刻按住了哪些键」。
 *
 * 多个手柄的状态是**合并**的，都算一号手柄：sendButton 的签名里没有手柄序号
 * （屏幕手柄只有一套），真要支持双人本地对战得先改那个约定。合并的副作用是
 * 第二个手柄也能操作一号，比「插上没反应」好。
 */
export function gamepadPadState(pads: readonly (Gamepad | null)[]): Set<PadButton> {
  const next = new Set<PadButton>()
  for (const pad of pads) {
    if (!pad || !pad.connected) continue
    /**
     * 按下标读只在标准布局下成立（文件头说的就是这件事，但一直没真的挡）。
     * 非标准布局（杂牌 USB 手柄、街机摇杆、Firefox+Linux 上的大部分设备）报的是
     * `mapping: ''`：它们的 axes[0] 常常是扳机，空闲时静止在 -1 —— `x <= -DEADZONE`
     * 永远成立，等于**方向键左被一直按住**，角色贴着墙走，而且状态不变就永远不再发事件，
     * 松不开。宁可这只手柄不生效，也不能把游戏卡死。
     */
    if (pad.mapping !== 'standard') continue
    for (let i = 0; i < pad.buttons.length; i++) {
      if (!pad.buttons[i]?.pressed) continue
      const key = BUTTON_MAP[i]
      if (key) next.add(key)
    }
    // 左摇杆也当方向键用 —— 有些手柄的十字键根本不报 12~15
    const x = pad.axes[0] ?? 0
    const y = pad.axes[1] ?? 0
    if (x <= -DEADZONE) next.add('left')
    if (x >= DEADZONE) next.add('right')
    if (y <= -DEADZONE) next.add('up')
    if (y >= DEADZONE) next.add('down')
  }
  return next
}

export interface GamepadInput {
  stop: () => void
}

/**
 * 开始轮询手柄。返回的 stop() 必须在运行时销毁时调 —— 否则 rAF 循环会一直跑，
 * 而且换游戏时上一局按住的键不会松开。
 *
 * 只发**变化**：按住不放的键不会每帧重复喂给核心。
 */
export function startGamepadInput(send: (button: PadButton, down: boolean) => void): GamepadInput {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return { stop: () => {} }
  }

  const held = new Set<PadButton>()
  let stopped = false
  let raf = 0

  const poll = () => {
    const next = gamepadPadState(navigator.getGamepads())
    for (const button of ALL) {
      const want = next.has(button)
      if (want === held.has(button)) continue
      if (want) held.add(button)
      else held.delete(button)
      send(button, want)
    }
  }

  /**
   * ⚠️ requestAnimationFrame 必须排在 try 外面。
   * jsnes 自己那个手柄循环就是写成 `poll(); requestAnimationFrame(loop)` ——
   * poll 一抛异常，下一拍就再也不排了，手柄从此彻底失灵，而且只在控制台留一条报错。
   */
  const loop = () => {
    if (stopped) return
    try {
      poll()
    } catch {
      /* 某一帧读不到手柄状态无所谓，下一帧再来 */
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      // 松开这一局还按着的键，否则角色会带着「一直往右」进下一局
      for (const button of [...held]) send(button, false)
      held.clear()
    },
  }
}
