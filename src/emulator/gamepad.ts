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

/**
 * 按钮下标 -> 引擎自己的「键」。
 * 键长什么样由引擎决定：DOSBox 用数字键码，FreeJ2ME 用 { code, key } 这样的键名对象。
 */
export type GamepadKeyMap<K> = Record<number, K>

export interface GamepadBridgeOptions {
  /** 摇杆推到多少算方向键，默认 0.5 */
  axisThreshold?: number
  /** 左摇杆是否也映射成方向键（默认开） */
  stickAsDpad?: boolean
  /**
   * 从哪儿读手柄。默认读本文档。
   *
   * ⚠️ 手柄对**每个文档**是分别可见的：焦点在 iframe 里的时候，父页面
   * `navigator.getGamepads()` 读到的是一串 null（见 frameFocus.ts）。所以引擎跑在 iframe 里、
   * 而我们又主动把焦点交进去的那些运行时（j2me），必须从 iframe 那个 window 上读，
   * 否则手柄插上去在这一局里永远不会生效。js-dos 是直接跑在主页面上的，用默认的就对。
   */
  getPads?: () => readonly (Gamepad | null)[]
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
export function startGamepadBridge<K>(map: GamepadKeyMap<K>, send: (key: K, pressed: boolean) => void, opts: GamepadBridgeOptions = {}): GamepadBridge {
  const threshold = opts.axisThreshold ?? 0.5
  const stickAsDpad = opts.stickAsDpad !== false
  const readPads = opts.getPads ?? (() => (navigator.getGamepads ? navigator.getGamepads() : []))
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
    const pads = readPads()
    /**
     * ⚠️ 必须挑 `mapping === 'standard'` 的那一个。
     *
     * 非标准布局（街机摇杆、杂牌 USB 手柄，以及 Firefox + Linux 上的大多数设备）的
     * axes[0] 常常是**扳机**，静止值就是 -1 —— 于是 `x < -threshold` 每帧为真，
     * 而 set() 只在边沿发事件：发过一次「LEFT 按下」之后**再也不会发松开**，
     * DOSBox / FreeJ2ME 里方向键左等于被焊死，角色贴着左墙走不动，整局无解。
     * buttons 按下标读在非标准布局下也是乱的（按跳变成开火）。
     * gamepadInput.ts 那边早就加了这道判断，这里一直漏着。
     *
     * 用 find 而不是 filter：跳过杂牌的那一个之后，插在第二个槽位的好手柄照样能被选中
     * （以前是无条件取第一个连着的，插着摇杆时 Xbox 手柄全程无效）。
     */
    const pad = Array.prototype.find.call(
      pads,
      (p: Gamepad | null) => p && p.connected && p.mapping === 'standard',
    ) as Gamepad | undefined
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

  /**
   * 有没有连着手柄。
   *
   * ⚠️ 没有的话 rAF 循环一帧都不该排。
   *
   * 这个桥挂在 DOS 和 J2ME 上，而手机上根本插不了手柄 —— 以前每一局全程 60Hz 空转：
   * `getGamepads()` 每次调用都新建一份快照（Chrome 会造 4 个 Gamepad 对象、各带 17 个
   * GamepadButton 和一条 axes），加上每帧 `new Array(16)` 和一次 find，一秒几千个纯垃圾对象。
   * 这些 GC 压力紧挨着模拟器本来就吃紧的 16ms 帧预算，低端机上就是掉帧 + 发烫掉电。
   * 改成靠 gamepadconnected / gamepaddisconnected 开关循环：没手柄时零开销。
   *
   * ⚠️ 只在读的是**父页面**的手柄时才这么做：j2me 传了 getPads 去读 iframe 里的
   * navigator（见 startGamepadBridge 的 getPads 选项），那一路的连接事件打在 iframe 上、
   * 父页面收不到，按事件开关会让插着的手柄一个键都不生效 —— 那种情况保持常开。
   */
  const gated = !opts.getPads && typeof window !== 'undefined'
  const hasPad = () => {
    try {
      return Array.prototype.some.call(readPads(), (p: Gamepad | null) => Boolean(p?.connected))
    } catch {
      return false
    }
  }
  const sync = () => {
    if (stopped) return
    const on = hasPad()
    if (on && !raf) raf = requestAnimationFrame(tick)
    if (!on && raf) {
      cancelAnimationFrame(raf)
      raf = 0
      anyPad = false
      for (const i of Array.from(down)) set(i, false)
    }
  }

  if (gated) {
    window.addEventListener('gamepadconnected', sync)
    window.addEventListener('gamepaddisconnected', sync)
    // 进页面之前就插着的手柄不会补发 gamepadconnected，先自己探一次
    sync()
  } else {
    raf = requestAnimationFrame(tick)
  }

  return {
    stop() {
      stopped = true
      if (gated) {
        window.removeEventListener('gamepadconnected', sync)
        window.removeEventListener('gamepaddisconnected', sync)
      }
      if (raf) cancelAnimationFrame(raf)
      raf = 0
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
