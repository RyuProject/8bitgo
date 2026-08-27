/**
 * 手柄桥接：把标准手柄（Gamepad API 的 "standard" 布局）翻译成按键事件。
 *
 * 有些引擎自带手柄支持（EmulatorJS、jsnes 的 gamepadConfig），这个模块是给
 * 那些「只认键盘」的引擎用的 —— 比如 DOSBox：DOS 游戏基本都是键盘操作，
 * 我们轮询手柄状态，边沿触发时替玩家按下/松开对应的键。
 *
 * 只在有按键变化时发事件，不会每帧刷屏。
 */

/** 标准布局的按钮下标，见 https://w3c.github.io/gamepad/#remapping */
export const GP = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const

/** 按钮下标 -> 引擎自己的键码 */
export type GamepadKeyMap = Record<number, number>

export interface GamepadBridgeOptions {
  /** 摇杆推到多少算方向键，默认 0.5 */
  axisThreshold?: number
  /** 左摇杆是否也映射成方向键（默认开） */
  stickAsDpad?: boolean
}

export interface GamepadBridge {
  stop: () => void
  /** 当前是否至少连着一个手柄 */
  connected: () => boolean
}

export function hasGamepadApi(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
}

/**
 * 开始轮询手柄。send(keyCode, pressed) 在状态变化时调用。
 * 返回的 stop() 会把还按着的键都松开，避免退出时角色一直往前跑。
 */
export function startGamepadBridge(map: GamepadKeyMap, send: (keyCode: number, pressed: boolean) => void, opts: GamepadBridgeOptions = {}): GamepadBridge {
  const threshold = opts.axisThreshold ?? 0.5
  const stickAsDpad = opts.stickAsDpad !== false
  const down = new Set<number>()
  let raf = 0
  let stopped = false
  let anyPad = false

  const set = (index: number, pressed: boolean) => {
    const key = map[index]
    if (key === undefined) return
    const was = down.has(index)
    if (pressed === was) return
    if (pressed) down.add(index)
    else down.delete(index)
    try {
      send(key, pressed)
    } catch {
      /* 引擎已经销毁就忽略 */
    }
  }

  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)
    const pads = navigator.getGamepads ? navigator.getGamepads() : []
    const pad = Array.prototype.find.call(pads, (p: Gamepad | null) => p && p.connected) as Gamepad | undefined
    anyPad = Boolean(pad)
    if (!pad) {
      // 手柄拔了：把按着的键全松开
      for (const i of Array.from(down)) set(i, false)
      return
    }
    // 先把这一帧「该按下哪些」算全，再统一比对。
    // 不能边算边发：十字键和摇杆映射到同一个下标，先按按钮写一次 false、
    // 再按摇杆写一次 true 的话，推着摇杆不动也会每帧发出一组「松开+按下」。
    const want = new Array<boolean>(16).fill(false)
    for (let i = 0; i < 16; i++) {
      if (map[i] === undefined) continue
      want[i] = Boolean(pad.buttons[i]?.pressed)
    }
    if (stickAsDpad) {
      const [x = 0, y = 0] = pad.axes
      // 摇杆和十字键取「或」：任一推到位就算按下
      if (x < -threshold) want[GP.LEFT] = true
      if (x > threshold) want[GP.RIGHT] = true
      if (y < -threshold) want[GP.UP] = true
      if (y > threshold) want[GP.DOWN] = true
    }
    for (let i = 0; i < 16; i++) set(i, want[i])
  }

  raf = requestAnimationFrame(tick)

  return {
    stop() {
      stopped = true
      cancelAnimationFrame(raf)
      for (const i of Array.from(down)) {
        const key = map[i]
        if (key === undefined) continue
        try {
          send(key, false)
        } catch {
          /* ignore */
        }
      }
      down.clear()
    },
    connected: () => anyPad,
  }
}
