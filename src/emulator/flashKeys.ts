/**
 * Flash 游戏的键位表。
 *
 * 主机模拟器有统一的手柄映射（十字键就是十字键），Flash 没有 —— 每款 SWF 自己决定读哪几个键：
 * 森林冰火人是 1P WASD、2P 方向键；别的游戏可能是方向键 + 空格，或者 IJKL。
 * 所以「屏幕上这颗按钮对应哪个键」在 Flash 这边只能是**逐游戏的数据**，
 * 跟街机那张改版包指纹表一个性质（见 arcadeHack.ts）。
 *
 * 为什么先写在代码里而不是 games 表上：这一版要先验证「合成键盘事件能不能被 Ruffle 吃到」。
 * 等表长起来、或者要让后台能配了，再挪成一个字段 —— 读的那头（ruffle.ts）不用动，
 * 只是 flashKeysFor() 从查表变成读 options。
 *
 * ── 为什么合成事件这条路成立 ──
 *   1. Ruffle 自己就是这么干的：它的虚拟键盘（发行包 ruffle.js 里的 virtualKeyboardInput）
 *      就是 `this.element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))`。
 *   2. 发行包里 `isTrusted` 出现 0 次（ruffle.js 和两个 .wasm 都查过）——
 *      它不区分真按键和合成事件。
 */
import type { PadButton } from './types'

/**
 * 一个键在 KeyboardEvent 上的三副面孔。
 * Ruffle 内部读哪一副没有公开承诺，三个都给最省事，也不花什么。
 */
export interface KeyDesc {
  /** event.key —— 字母键是小写字母本身，功能键是名字 */
  key: string
  /** event.code —— 物理键位，和键盘布局无关 */
  code: string
  /** event.keyCode —— 早废弃了，但 Flash 时代的老路径还在看它（浏览器的 which 也跟着它走） */
  keyCode: number
}

const NAMED: Record<string, KeyDesc> = {
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  // ⚠️ 空格的 key 是一个空格字符，不是 'Space'。写成 'Space' 游戏收到的是个不存在的键
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  ControlLeft: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
}

/**
 * 键名 → 三副面孔。字母键和数字键按名字推，不用一个个列：
 * KeyW 的 key 是 'w'、keyCode 是 'W' 的 ASCII（87）；Digit1 的 key 是 '1'、keyCode 是 49。
 */
export function keyDesc(name: string): KeyDesc | null {
  const named = NAMED[name]
  if (named) return named
  const letter = /^Key([A-Z])$/.exec(name)
  if (letter) return { key: letter[1].toLowerCase(), code: name, keyCode: letter[1].charCodeAt(0) }
  const digit = /^Digit([0-9])$/.exec(name)
  if (digit) return { key: digit[1], code: name, keyCode: digit[1].charCodeAt(0) }
  return null
}

/** 一个玩家的键位：屏幕手柄的按钮 → 键名。没列的按钮就是这款游戏用不上 */
export type FlashPad = Partial<Record<PadButton, string>>

export interface FlashKeys {
  p1: FlashPad
  /** 同屏双打才有第二套。以后把观众提成 2P，用的就是它 */
  p2?: FlashPad
}

const ARROWS: FlashPad = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }
const WASD: FlashPad = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }

/**
 * 现成的键位，写表的时候拼一下就行。
 *
 * `arrowsSpace` 是最常见的一套（方向键走位 + 空格开火 / 跳）。
 */
export const PRESET = {
  arrows: ARROWS,
  wasd: WASD,
  arrowsSpace: { ...ARROWS, a: 'Space' } as FlashPad,
} as const

/**
 * 逐游戏键位，键是游戏 slug。导出是为了让 test:flash-keys 能整张表走一遍
 * （键名拼错、按钮名拼错、两个玩家撞键，这三种错在界面上都是**静默**的）。
 *
 * ⚠️ slug 必须和库里的一模一样。写错了这款游戏就**静默地**没有屏幕手柄
 * （查不到不发默认键位，见下面 flashKeysFor），界面上什么提示都没有 ——
 * 加一款之前先去后台确认 slug。
 */
export const FLASH_KEYS: Record<string, FlashKeys> = {
  // 森林冰火人：同屏双打，1P = WASD、2P = 方向键，没有动作键（上就是跳）
  // ⚠️ 这个 slug 是占位的，按库里的实际值改
  'senlin-binghuoren': { p1: PRESET.wasd, p2: PRESET.arrows },
}

/**
 * 查不到就返回 null，**不给默认键位**。
 *
 * 这一条很重要：Flash 游戏里有一大半是纯鼠标的（点击解谜、塔防、换装、小游戏合集），
 * Ruffle 本来就会把触屏的点按翻成鼠标事件，它们在手机上是能玩的。
 * 要是给不认识的游戏也发一套「方向键 + 空格」，等于在这些游戏上画一个按下去
 * 什么都不会发生的十字键，而且开局提示还会跟着说一句「手柄在下面 👇」——
 * 比不画糟得多。宁可漏画，不可瞎画（和 html5 那一路不声明能力是同一个道理）。
 *
 * 也就是说：**表里没有的 Flash 游戏没有屏幕手柄**。加一款就往上面 FLASH_KEYS 里加一行，
 * 然后跑一遍 `npm run test:flash-keys`（键名 / 按钮名 / 两个玩家撞键都会被它拦下来）。
 */
export function flashKeysFor(slug?: string): FlashKeys | null {
  return (slug && FLASH_KEYS[slug]) || null
}
