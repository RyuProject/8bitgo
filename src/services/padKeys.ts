/**
 * 红白机（jsnes）的键盘键位：默认表、改键、持久化。
 *
 * **零 import** —— 和 services/hotkeys.ts 一个道理，这样 scripts/test-pad-keys.mjs
 * 能在 node 里直接把它跑起来，不需要浏览器也不需要 esbuild。
 *
 * ## 为什么不用 jsnes 自带那套
 *
 * jsnes 的 `Browser` 确实暴露了 `keyboard.setKeys()`，能改键、还会自动存。但它有三个
 * 对不上本站的地方：
 *
 *  1. **它读 `e.keyCode`。** 而站里的快捷键系统（hotkeys.ts）是**刻意**用
 *     `KeyboardEvent.code` 的：`key` / `keyCode` 跟键盘布局走，AZERTY 上同一个物理位置
 *     压根不是同一个值，而游戏按键从来都该按物理位置绑。两套并存的话，改键界面上显示的
 *     和玩家实际按的，在非 US 布局上会对不上。
 *     换成 `code` 还白捡一个好处：小键盘那八个键**不再依赖 NumLock** ——
 *     `Numpad8` 是物理位置，NumLock 关着照样报这个 code（只是 `key` 变成 ArrowUp）。
 *  2. **它存在裸的 `localStorage['keys']` 里**，没有 `8bitgo.` 前缀，而且是无脑
 *     `JSON.parse` 之后直接当映射表用 —— 格式不对就是一份坏值常驻玩家浏览器。
 *     这和 `gamepadConfig` 那个「每帧抛异常」的坑是同一类（见 adapters/jsnes.ts 的
 *     clearBrokenGamepadConfig）。这里存差量 + 逐条校验形状，坏值只会被忽略。
 *  3. 它的 `onButtonDown` 被 `disableIfGamepadEnabled` 包着：一旦 `gamepadConfig`
 *     存在且给这个玩家配了手柄，键盘就**静默失效**。我们绕开它，就不会踩到。
 *
 * ## 数据结构
 *
 * 运行期要的是「按下这个物理键 → 谁的哪个动作」，所以生效的表是 `code → '座位:动作'`。
 * 而**存**的是反过来的差量（`'座位:动作' → code`），理由和 hotkeys.ts 一样：以后改默认
 * 键位或加动作时，老玩家不会被本地一张旧的完整表钉死。
 *
 * 默认表里允许一个动作挂**多个**键（QWERTZ 键盘上物理 `KeyY` 就是印着 Z 的那颗，
 * 所以 Z / Y 两个位置都给 B）。玩家一改这个动作，它原有的那几个键一起让位。
 */

/** 手柄动作。前八个是红白机手柄上真有的键，两个 turbo 是 jsnes 内置的连发（Controller 8 / 9） */
export type PadAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'a'
  | 'b'
  | 'select'
  | 'start'
  | 'turboA'
  | 'turboB'

export const PAD_ACTIONS: readonly PadAction[] = [
  'up',
  'down',
  'left',
  'right',
  'a',
  'b',
  'select',
  'start',
  'turboA',
  'turboB',
]

/** 0 = 1P，1 = 2P。和 RuntimeHandle.sendButton 的 player 参数同一套编号 */
export type Seat = 0 | 1
export const SEATS: readonly Seat[] = [0, 1]

/** 一条绑定的标识：`座位:动作`，例如 '0:a'、'1:up' */
export type PadBinding = `${Seat}:${PadAction}`

export function bindingOf(seat: Seat, action: PadAction): PadBinding {
  return `${seat}:${action}`
}

export function parseBinding(b: string): { seat: Seat; action: PadAction } | null {
  const [s, a] = b.split(':')
  const seat = s === '0' ? 0 : s === '1' ? 1 : null
  if (seat === null) return null
  if (!(PAD_ACTIONS as readonly string[]).includes(a)) return null
  return { seat, action: a as PadAction }
}

/**
 * 默认键位。1P 那一半照抄 jsnes 的默认表（node_modules/jsnes/src/browser/keyboard.js
 * 的 KEYS），2P 是它默认表里本来就有的小键盘那一半 —— 一直能用，只是站里以前没显示过。
 *
 * ⚠️ 顺序有意义：显示键位时取**第一个**匹配的键，所以 KeyZ 必须排在 KeyY 前面
 *    （表里写 Z，Y 只是 QWERTZ 的后路）。
 * ⚠️ 2P 默认没有连发键 —— jsnes 的默认表里就没给。但连发是按玩家算的，
 *    所以留着可绑，玩家想给 2P 配就配。
 */
export const DEFAULT_PAD_KEYS: Readonly<Record<string, PadBinding>> = {
  /*
    1P 用左手 WASD + 右手 UIJK（2026-09-12 改的），和 EmulatorJS 那边的
    EJS_KEY_OVERRIDE 是同一套 —— 站里只该有一种默认键位，红白机和别的平台
    按起来不一样才是最容易让人骂街的那种不一致。

    ⚠️ 原来 1P 是方向键 + X/Z，连发在 S/A。改成 WASD 之后 S 和 A 被方向占了，
       连发只能跟着挪（挪到 I / U，正好和面键 K / J 同一只手）。
    ⚠️ 原来还有一条 `KeyY: '0:b'` 的后路 —— QWERTZ 键盘上印着 Z 的物理键报的是 KeyY。
       现在 B 键是 J，J 在 QWERTZ 上不挪位置，这条后路没有存在的理由了，删掉。
    ⚠️ 2P 那一组（小键盘）不动：它本来就不和任何字母键冲突。
  */
  KeyW: '0:up',
  KeyS: '0:down',
  KeyA: '0:left',
  KeyD: '0:right',
  KeyK: '0:a',
  KeyJ: '0:b',
  ShiftLeft: '0:select',
  Enter: '0:start',
  KeyI: '0:turboA',
  KeyU: '0:turboB',

  Numpad8: '1:up',
  Numpad2: '1:down',
  Numpad4: '1:left',
  Numpad6: '1:right',
  Numpad7: '1:a',
  Numpad9: '1:b',
  Numpad3: '1:select',
  Numpad1: '1:start',
}

const STORE_KEY = '8bitgo.nes.keys'

/**
 * 不给绑的键。
 *
 * F1 / F5 / F11 / F12 是浏览器自己的（帮助、刷新、全屏、开发者工具）——
 * preventDefault 也未必拦得住，绑上去就是个时灵时不灵的键，这条和 hotkeys.ts 一致。
 * Tab / Escape 是页面自己要用的（焦点、关面板）。
 * Meta（⌘ / Win）由操作系统抢，网页拦不住。
 *
 * 注意**修饰键本身是可以绑的**：红白机的 Select 默认就是右 Ctrl。这跟 hotkeys.ts 的
 * isBindable 不一样 —— 那边修饰键只能当前缀，这边它就是一颗普通按钮。
 */
const RESERVED_CODES = new Set([
  'F1',
  'F5',
  'F11',
  'F12',
  'Tab',
  'Escape',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
])

/** 这个物理键能不能当游戏按键 */
export function isPadBindable(code: string): boolean {
  if (!code || typeof code !== 'string') return false
  return !RESERVED_CODES.has(code)
}

/** 键位牌子上显示什么。和 hotkeys.ts 的 comboLabel 一套写法，另外认修饰键的左右 */
export function padKeyLabel(code: string): string {
  if (!code) return ''
  const side = /^(Control|Shift|Alt|Meta)(Left|Right)$/.exec(code)
  if (side) {
    const name = side[1] === 'Control' ? 'Ctrl' : side[1]
    return `${side[2] === 'Left' ? 'L' : 'R'} ${name}`
  }
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace(/^Arrow(Up|Down|Left|Right)$/, (_m, d: string) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' })[d] ?? d)
    .replace(/^Semicolon$/, ';')
    .replace(/^Comma$/, ',')
    .replace(/^Period$/, '.')
    .replace(/^Slash$/, '/')
    .replace(/^Backquote$/, '`')
    .replace(/^Minus$/, '-')
    .replace(/^Equal$/, '=')
}

/* ---------------- 订阅 ---------------- */

const listeners = new Set<() => void>()

/** 订阅改键。返回退订函数 */
export function onPadKeysChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function emitChange(): void {
  // 拷一份再遍历：监听者在回调里退订是常事（React 的 cleanup 就会）
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      /* 一个监听者炸了不该连累其他人 */
    }
  }
}

/* ---------------- 读写 ---------------- */

/** 玩家改过的那几条（差量）。坏值逐条忽略，不整份丢掉 */
function readOverrides(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return out
    const saved = JSON.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(saved)) {
      if (!parseBinding(k)) continue
      // 空串 = 玩家把这个动作解绑了，是合法值
      if (typeof v === 'string' && (v === '' || isPadBindable(v))) out[k] = v
    }
  } catch {
    /* 无痕模式 / 坏 JSON：当没改过 */
  }
  return out
}

function writeOverrides(next: Record<string, string>): void {
  try {
    if (Object.keys(next).length) localStorage.setItem(STORE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORE_KEY)
  } catch {
    /* 存不下就只在本次会话生效，不该让改键这个操作失败 */
  }
  emitChange()
}

/**
 * 生效的键位表：`物理键 code → '座位:动作'`。运行期查的就是这张。
 *
 * 叠加规则：默认表打底，然后按玩家改过的每一条 ——
 * 先把这个动作原有的键**全部**摘掉（默认表里一个动作可能挂两个键），
 * 再把新键装上；新键原来属于谁，谁就让位（抢过来，见 setPadKey）。
 */
export function getPadKeys(): Record<string, PadBinding> {
  const map: Record<string, PadBinding> = { ...DEFAULT_PAD_KEYS }
  for (const [binding, code] of Object.entries(readOverrides())) {
    for (const [c, b] of Object.entries(map)) {
      if (b === binding) delete map[c]
    }
    if (code) map[code] = binding as PadBinding
  }
  return map
}

/** 某条绑定当前用的键（没有就是空串）。一个动作挂多个键时取第一个 —— 显示用 */
export function padKeyFor(binding: PadBinding, map: Record<string, PadBinding> = getPadKeys()): string {
  for (const [code, b] of Object.entries(map)) {
    if (b === binding) return code
  }
  return ''
}

/** 这个物理键现在归谁（没人用就是 null） */
export function bindingForCode(code: string, map: Record<string, PadBinding> = getPadKeys()): PadBinding | null {
  return map[code] ?? null
}

/**
 * 绑一个键。返回**被这一下抢走键位的那条绑定**（没有就是 null），调用方好告诉玩家。
 *
 * 冲突处理和 hotkeys.ts 一致：**抢过来 + 说一声**，不是拒绝。拒绝的话玩家得先去把占着的
 * 那个解绑再回来绑一次，两步；抢过来是一步、看得见发生了什么、随时改得回去。
 *
 * code 传空串 = 解绑这条。
 */
export function setPadKey(binding: PadBinding, code: string): PadBinding | null {
  if (!parseBinding(binding)) return null
  if (code && !isPadBindable(code)) return null

  const stolen = code ? (getPadKeys()[code] ?? null) : null
  const overrides = readOverrides()

  /*
    ⚠️ 先 delete 再赋值，让这一条排到**最后**。

    getPadKeys() 是按存进来的顺序一条条叠的，后叠的赢。如果这条以前就存过，
    直接赋值会让它留在原来的位置 —— 玩家「把 A 改成 W」可能因为 A 那条排在
    B 前面，结果 W 被 B 抢回去，按下 W 出来的是 B。
    重新插一遍就保证「最后改的那次说了算」。

    被抢键位的那条**不用**记成空串：叠加时后面这条会把那个键从前一条手里拿走，
    前一条自然就没键了。反过来，玩家把键还回去时那条记录一清，被抢的也自动回来。
  */
  delete overrides[binding]
  overrides[binding] = code

  // 改回默认值的那条记录就清掉 —— 不清的话以后改默认键位，这个玩家会被旧值钉住
  for (const [b, c] of Object.entries({ ...overrides })) {
    const isDefault = c ? DEFAULT_PAD_KEYS[c] === b && padKeyFor(b as PadBinding, { ...DEFAULT_PAD_KEYS }) === c : false
    if (isDefault) delete overrides[b]
  }

  writeOverrides(overrides)
  return stolen && stolen !== binding ? stolen : null
}

/** 全部恢复默认 */
export function resetPadKeys(): void {
  writeOverrides({})
}

/** 玩家动过键位没有 —— 界面上据此决定要不要显示「恢复默认」 */
export function padKeysCustomized(): boolean {
  return Object.keys(readOverrides()).length > 0
}
