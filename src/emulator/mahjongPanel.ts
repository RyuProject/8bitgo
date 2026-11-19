/**
 * MAME 麻将机（只有麻将面板、没有摇杆的那批，名单见 shared/mahjong-panel-sets.js）的输入。
 *
 * ── 为什么要单独一套 ─────────────────────────────────────────
 * 麻将机的 14 张手牌、吃碰杠听胡、押注 / 得分 / 比倍 / 大小，在 MAME 里全是 IPT_MAHJONG_*，
 * 默认**只绑键盘**（inpttype.ipp：A–N、左 Ctrl/Alt/Shift、空格、Z、3、右 Ctrl/Shift、
 * Enter、Backspace）。libretro-mame 的 RetroPad 只接方向、按键 1–6、投币、开始，
 * 所以本站默认的「键盘 → RetroPad」那一路在麻将机上等于把键盘拔了：
 * 能投币、能开始，进了牌局一张牌都打不出去（2026-11-19《龙虎争霸1》lhzb 实测）。
 *
 * 解法是把这一局的键盘**直通**给核心（EmulatorJS 的 keyboardInput，RetroArch 再交给
 * libretro-mame 的 retro_keyboard_event），但不能整把直通：MAME 自己也认键盘上的
 * UI 键 —— P 暂停、Tab 开菜单、Esc 退出、F2 测试模式、F3 复位、F10 关限速 ……
 * 玩家随手一按就是「游戏卡住了」。所以这里是一张**白名单**：只有面板上的键进得去，
 * 其余在 RetroArch 之前拦下（站内的 F2 / F4 存读档在文档捕获阶段，早于这里，不受影响）。
 *
 * ── 别名 ───────────────────────────────────────────────────
 * MAME 原生键位照常可用（老玩家的肌肉记忆、MAME 菜单里显示的也是它们），另补三个别名：
 *   V → 投币   和本站其它街机的投币键一致
 *   P → 碰     原生是左 Alt：Windows 上单按 Alt 会把焦点交给浏览器菜单；P 又正好是 Pon / Peng
 *   S → 得分   原生是右 Ctrl，Mac 和多数笔记本根本没有这颗键；S = Score
 * 别名在 RetroArch 之前换成原生键码再派发，MAME 看到的永远是原生那一颗。
 */
import { isMahjongPanelRomset } from '../../shared/mahjong-panel-sets.js'
import { GP, startGamepadBridge, type GamepadBridge } from './gamepad'

export const MAHJONG_TILE_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'] as const
export type MahjongTileKey = (typeof MAHJONG_TILE_KEYS)[number]

/** 吃碰杠听胡 —— 牌局里的动作 */
export const MAHJONG_ACTION_KEYS = ['chi', 'pon', 'kan', 'reach', 'ron'] as const
/** 投币 / 开始 / 押注 / 得分 / 比倍 / 大 / 小 —— 牌局外的流程键 */
export const MAHJONG_FLOW_KEYS = ['coin', 'start', 'bet', 'score', 'double', 'big', 'small'] as const

export type MahjongKey =
  | MahjongTileKey
  | (typeof MAHJONG_ACTION_KEYS)[number]
  | (typeof MAHJONG_FLOW_KEYS)[number]
  | 'last'

interface KeyDef {
  /** MAME 默认绑的那颗键（KeyboardEvent.code）。RetroArch 按 code 认键，见 rwebinput 的 encoding_crc32(code) */
  code: string
  key: string
  keyCode: number
}

/**
 * 面板键 → MAME 0.289 inpttype.ipp 的默认键位；投币 / 开始取 libretro-mame
 * retromain.cpp customize_input_type_list 的 KEYCODE_5 / KEYCODE_1。改这里之前先对源码。
 */
export const MAHJONG_KEY_DEFS: Readonly<Record<MahjongKey, KeyDef>> = {
  ...(Object.fromEntries(
    MAHJONG_TILE_KEYS.map((k, i) => [k, { code: `Key${k.toUpperCase()}`, key: k, keyCode: 65 + i }]),
  ) as Record<MahjongTileKey, KeyDef>),
  chi: { code: 'Space', key: ' ', keyCode: 32 },
  pon: { code: 'AltLeft', key: 'Alt', keyCode: 18 },
  kan: { code: 'ControlLeft', key: 'Control', keyCode: 17 },
  reach: { code: 'ShiftLeft', key: 'Shift', keyCode: 16 },
  ron: { code: 'KeyZ', key: 'z', keyCode: 90 },
  bet: { code: 'Digit3', key: '3', keyCode: 51 },
  score: { code: 'ControlRight', key: 'Control', keyCode: 17 },
  double: { code: 'ShiftRight', key: 'Shift', keyCode: 16 },
  big: { code: 'Enter', key: 'Enter', keyCode: 13 },
  small: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
  last: { code: 'AltRight', key: 'Alt', keyCode: 18 },
  start: { code: 'Digit1', key: '1', keyCode: 49 },
  coin: { code: 'Digit5', key: '5', keyCode: 53 },
}

/** 浏览器友好的别名（物理键 code → 面板键）。理由见文件头 */
export const MAHJONG_KEY_ALIASES: Readonly<Record<string, MahjongKey>> = {
  KeyV: 'coin',
  KeyP: 'pon',
  KeyS: 'score',
  NumpadEnter: 'big',
}

const NATIVE_BY_CODE: ReadonlyMap<string, MahjongKey> = new Map(
  (Object.entries(MAHJONG_KEY_DEFS) as [MahjongKey, KeyDef][]).map(([k, d]) => [d.code, k]),
)

/** 物理键 → 面板键（原生或别名）。不在面板上的键返回 null —— 那些键不许进 MAME */
export function mahjongKeyForCode(code: string): MahjongKey | null {
  return NATIVE_BY_CODE.get(code) ?? MAHJONG_KEY_ALIASES[code] ?? null
}

/** 这颗物理键是不是面板键的**原生**键位（是的话原样放行，不必换码重发） */
export function isNativeMahjongCode(code: string): boolean {
  return NATIVE_BY_CODE.has(code)
}

/**
 * 一个面板键在键位表上该写哪几颗键（KeyboardEvent.code）：原生键在前，别名在后（左 Alt / P）。
 * 小键盘 Enter 只是顺手兜底，不往表上写。
 */
export function mahjongKeyCodes(key: MahjongKey): string[] {
  const codes = [MAHJONG_KEY_DEFS[key].code]
  for (const [code, k] of Object.entries(MAHJONG_KEY_ALIASES)) {
    if (k === key && code !== 'NumpadEnter') codes.push(code)
  }
  return codes
}

/**
 * 这款游戏要不要按麻将面板来。只认 mame-current —— 名单里的板子 FBNeo / MAME 2003 都没有。
 * @param romKeys ROM 对象 key / URL / 文件名，任一个是麻将机 romset 就算
 */
export function isMahjongPanelGame(platform: string | undefined, core: string | null | undefined, romKeys: readonly (string | null | undefined)[]): boolean {
  if (platform !== 'arcade' || core !== 'mame-current') return false
  return romKeys.some((k) => isMahjongPanelRomset(k))
}

/** 短按也要让核心至少看到这么久：RetroArch 一帧轮询一次键盘，按下和松开落在同一帧里这一下就丢了 */
export const MAHJONG_MIN_HOLD_MS = 70

export interface MahjongKeyboard {
  /** 屏幕面板 / 手柄按下、松开一颗面板键 */
  press: (key: MahjongKey, down: boolean, source?: string) => void
  /** 卸掉监听，松开所有按着的键 */
  dispose: () => void
}

interface InstallOptions {
  /** 返回 true 时这一下完全不管（引擎弹窗开着、焦点在输入框里） */
  passThrough?: (e: KeyboardEvent) => boolean
  now?: () => number
}

/**
 * 在引擎的 parent 元素上装麻将键盘桥。
 *
 * 装在 `parent` 的**捕获阶段**是有讲究的：RetroArch 的键盘回调注册在 `!parent`
 * （EmulatorJS 的 Module.parent）上、非捕获；站内存读档快捷键在 iframe document 的捕获阶段。
 * 事件的路线是 document 捕获 → parent 捕获 → parent 目标/冒泡，所以这里拦得住 MAME，
 * 又不会挡到站内快捷键。
 */
export function installMahjongKeyboard(parent: HTMLElement, win: Window, opts: InstallOptions = {}): MahjongKeyboard {
  const now = opts.now ?? (() => win.performance?.now?.() ?? Date.now())
  const synthetic = new WeakSet<Event>()
  /** 每颗面板键被哪些来源按着（键盘别名 / 屏幕面板 / 手柄）—— 最后一个松手才真的松开 */
  const holders = new Map<MahjongKey, Set<string>>()
  /** 玩家实际按着的原生键：失焦时浏览器不补 keyup，得替他松开，不然吃 / 碰会一直按着 */
  const nativeHeld = new Set<string>()
  const downAt = new Map<MahjongKey, number>()
  const releaseTimers = new Map<MahjongKey, number>()
  let dead = false

  const dispatch = (key: MahjongKey, down: boolean) => {
    const def = MAHJONG_KEY_DEFS[key]
    const KE = (win as Window & typeof globalThis).KeyboardEvent ?? KeyboardEvent
    const ev = new KE(down ? 'keydown' : 'keyup', {
      code: def.code,
      key: def.key,
      keyCode: def.keyCode,
      which: def.keyCode,
      bubbles: true,
      cancelable: true,
    } as KeyboardEventInit)
    synthetic.add(ev)
    parent.dispatchEvent(ev)
  }

  const emitDown = (key: MahjongKey) => {
    const pending = releaseTimers.get(key)
    if (pending !== undefined) {
      // 上一下还没来得及真松开（最短按压时间内）就又按下：在核心眼里它一直按着，不重发
      win.clearTimeout(pending)
      releaseTimers.delete(key)
      return
    }
    downAt.set(key, now())
    dispatch(key, true)
  }

  const emitUp = (key: MahjongKey) => {
    const wait = MAHJONG_MIN_HOLD_MS - (now() - (downAt.get(key) ?? 0))
    if (wait > 0 && !dead) {
      releaseTimers.set(key, win.setTimeout(() => {
        releaseTimers.delete(key)
        dispatch(key, false)
      }, wait))
      return
    }
    dispatch(key, false)
  }

  const press = (key: MahjongKey, down: boolean, source = 'pad') => {
    if (dead && down) return
    let set = holders.get(key)
    if (!set) holders.set(key, (set = new Set()))
    if (down) {
      if (set.has(source)) return
      set.add(source)
      if (set.size === 1) emitDown(key)
    } else {
      if (!set.delete(source)) return
      if (set.size === 0) emitUp(key)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (synthetic.has(e) || opts.passThrough?.(e)) return
    const key = mahjongKeyForCode(e.code)
    const ctrlCode = e.code === 'ControlLeft' || e.code === 'ControlRight'
    /*
      Cmd / Ctrl 组合键是浏览器的（Cmd+R 刷新、Ctrl+C 复制）：不给 MAME，也不 preventDefault。
      单按 Ctrl 本身是杠 / 得分，照常放行。
    */
    if (!key || e.metaKey || (e.ctrlKey && !ctrlCode)) {
      e.stopImmediatePropagation()
      return
    }
    // 这些键在网页里各有默认行为：空格滚页、Backspace、Alt 唤出浏览器菜单
    e.preventDefault()
    if (e.type === 'keypress') return
    if (isNativeMahjongCode(e.code)) {
      if (e.type === 'keydown') nativeHeld.add(e.code)
      else nativeHeld.delete(e.code)
      return // 原样交给 RetroArch
    }
    // 别名：换成原生键码重发，原事件不让 MAME 看见（P 在 MAME 里是暂停）
    e.stopImmediatePropagation()
    if (e.repeat) return
    press(key, e.type === 'keydown', `kb:${e.code}`)
  }

  const releaseKeyboard = () => {
    for (const [key, set] of holders) {
      // 边遍历边删当前元素对 Set 是安全的（规范保证），不必先拷一份
      for (const source of set) if (source.startsWith('kb:')) press(key, false, source)
    }
    for (const code of nativeHeld) {
      const key = mahjongKeyForCode(code)
      if (key) dispatch(key, false)
    }
    nativeHeld.clear()
  }

  const types = ['keydown', 'keyup', 'keypress'] as const
  // 用对象写法：有的 EventTarget 实现（Node）拿布尔第三参移除不掉捕获监听
  const CAPTURE = { capture: true } as const
  for (const type of types) parent.addEventListener(type, onKey as EventListener, CAPTURE)
  win.addEventListener('blur', releaseKeyboard)

  return {
    press,
    dispose: () => {
      if (dead) return
      releaseKeyboard()
      for (const [key, set] of holders) {
        for (const source of set) press(key, false, source)
      }
      dead = true
      for (const [key, timer] of releaseTimers) {
        win.clearTimeout(timer)
        dispatch(key, false)
      }
      releaseTimers.clear()
      for (const type of types) parent.removeEventListener(type, onKey as EventListener, CAPTURE)
      win.removeEventListener('blur', releaseKeyboard)
    },
  }
}

/* ---------------- 手柄 ---------------- */

/**
 * 手柄上的「选牌光标」。
 *
 * 手柄只有十几颗键，放不下 14 张手牌各一颗。实机面板上牌下面就印着 A–N，
 * 所以给一个光标：左右（十字键或左摇杆）在 A–N 之间挪，A 键打出光标那张。
 * EmulatorJS 自己仍把手柄翻成 RetroPad：Start → 开始、Select → 投币照旧走那一路
 * （libretro-mame 的 JOYCODE_START / JOYCODE_SELECT），这里不再重复映射它们。
 */
type PadToken = Exclude<MahjongKey, MahjongTileKey> | 'discard' | 'prev' | 'next'

export const MAHJONG_GAMEPAD_MAP: Readonly<Record<number, PadToken>> = {
  [GP.A]: 'discard',
  [GP.B]: 'chi',
  [GP.X]: 'pon',
  [GP.Y]: 'kan',
  [GP.L1]: 'reach',
  [GP.R1]: 'ron',
  [GP.L2]: 'bet',
  [GP.R2]: 'score',
  [GP.L3]: 'double',
  [GP.UP]: 'big',
  [GP.DOWN]: 'small',
  [GP.LEFT]: 'prev',
  [GP.RIGHT]: 'next',
}

export interface MahjongGamepad {
  stop: () => void
}

/**
 * @param onCursor 光标动了（或刚打出一张）—— 调用方据此在画面上提示当前选中的是哪张
 */
export function startMahjongGamepad(
  keyboard: MahjongKeyboard,
  getPads: () => readonly (Gamepad | null)[],
  onCursor: (tile: MahjongTileKey) => void,
): MahjongGamepad {
  let cursor = 0
  /** A 键按下时选中的那张：松开必须松同一张，期间光标被挪走也一样 */
  let discarding: MahjongTileKey | null = null
  const bridge: GamepadBridge = startGamepadBridge<PadToken>(
    MAHJONG_GAMEPAD_MAP as Record<number, PadToken>,
    (token, pressed) => {
      if (token === 'prev' || token === 'next') {
        if (!pressed) return
        cursor = (cursor + (token === 'next' ? 1 : MAHJONG_TILE_KEYS.length - 1)) % MAHJONG_TILE_KEYS.length
        onCursor(MAHJONG_TILE_KEYS[cursor])
        return
      }
      if (token === 'discard') {
        if (pressed) {
          discarding = MAHJONG_TILE_KEYS[cursor]
          onCursor(discarding)
          keyboard.press(discarding, true, 'gamepad')
        } else if (discarding) {
          keyboard.press(discarding, false, 'gamepad')
          discarding = null
        }
        return
      }
      keyboard.press(token, pressed, 'gamepad')
    },
    { getPads },
  )
  return { stop: () => bridge.stop() }
}
