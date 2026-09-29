/**
 * DOS 屏幕手柄的键位表 —— 默认值、玩家自定义（按游戏记）、以及浏览器按键 → DOSBox 键码的换算。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────
 * 主机模拟器（红白机、街机）的按钮就那么几个，屏幕手柄画死就行。DOS 不一样：
 * 游戏读的是**键盘**，而「哪颗键干什么」完全是每款游戏自己定的 ——
 * 毁灭战士是方向键 + Ctrl 开火，波斯王子是 Shift 抓，一堆老游戏是 WASD 走。
 * 写死一套通用键位的结果就是「手机上除了看什么都干不了」，所以要让玩家自己绑。
 *
 * ── 键码为什么是这些数字 ──────────────────────────────────
 * js-dos 的 sendKeyEvent 收的是 **GLFW 键码**（Emscripten 那套，见 windowsLaunch.ts 的
 * WIN_KEY 注释）。它和我们平时用的 KeyboardEvent.code / keyCode **都不是一回事**，
 * 所以在 ui 层拿到的按键必须过一遍下面这张表才能喂给引擎。
 * 表里的数字只在这里出现一次，别的地方一律用 CODE_TO_GLFW.xxx 引用。
 *
 * ── 存哪儿 ────────────────────────────────────────────────
 * localStorage，**按游戏分开**（键是 slug，本地文件退回文件名）。
 * 合成一份全局的会很难用：给毁灭战士绑的 WASD 到了波斯王子里全是错的，
 * 而玩家不会意识到「昨天那套键位还留着」。
 */
import type { PadButton } from './types'

/* ---------------- GLFW 键码表 ---------------- */

/**
 * KeyboardEvent.code → GLFW 键码。
 *
 * 只收「DOS 游戏可能用得上」的键：字母 / 数字 / 常见符号 / 方向键 / 功能键 / 小键盘 / 修饰键。
 * 故意不收的：浏览器自己占用的（Tab 前后的 F11、Meta 组合）、以及 DOS 时代不存在的
 * 多媒体键 —— 绑上去引擎也不认，不如让玩家当场看到「这个键不支持」。
 */
export const CODE_TO_GLFW: Record<string, number> = {}
/** GLFW 键码 → 显示给玩家的短标签。改键面板和手柄都用它 */
const GLFW_TO_LABEL: Record<number, string> = {}

function put(code: string, glfw: number, label: string) {
  CODE_TO_GLFW[code] = glfw
  GLFW_TO_LABEL[glfw] = label
}

for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i)
  put(`Key${ch}`, 65 + i, ch)
}
for (let i = 0; i < 10; i++) {
  put(`Digit${i}`, 48 + i, String(i))
  put(`Numpad${i}`, 320 + i, `Num${i}`)
}

put('Backquote', 96, '`')
put('Minus', 45, '-')
put('Equal', 61, '=')
put('BracketLeft', 91, '[')
put('BracketRight', 93, ']')
put('Backslash', 92, '\\')
put('Semicolon', 59, ';')
put('Quote', 39, "'")
put('Comma', 44, ',')
put('Period', 46, '.')
put('Slash', 47, '/')
put('Space', 32, 'Space')

put('Escape', 256, 'Esc')
put('Enter', 257, 'Enter')
put('Tab', 258, 'Tab')
put('Backspace', 259, 'Back')
put('Insert', 260, 'Ins')
put('Delete', 261, 'Del')
put('ArrowRight', 262, '→')
put('ArrowLeft', 263, '←')
put('ArrowDown', 264, '↓')
put('ArrowUp', 265, '↑')
put('PageUp', 266, 'PgUp')
put('PageDown', 267, 'PgDn')
put('Home', 268, 'Home')
put('End', 269, 'End')
put('CapsLock', 280, 'Caps')
put('PrintScreen', 283, 'PrtSc')
put('Pause', 284, 'Pause')
for (let i = 1; i <= 25; i++) put(`F${i}`, 289 + i, `F${i}`)
put('NumpadDecimal', 330, 'Num.')
put('NumpadDivide', 331, 'Num/')
put('NumpadMultiply', 332, 'Num*')
put('NumpadSubtract', 333, 'Num-')
put('NumpadAdd', 334, 'Num+')
put('NumpadEnter', 335, 'Num⏎')
put('NumpadEqual', 336, 'Num=')
put('ShiftLeft', 340, 'Shift')
put('ControlLeft', 341, 'Ctrl')
put('AltLeft', 342, 'Alt')
put('MetaLeft', 343, 'Meta')
put('ShiftRight', 344, 'RShift')
put('ControlRight', 345, 'RCtrl')
put('AltRight', 346, 'RAlt')
put('MetaRight', 347, 'RMeta')

/**
 * 单个字符 → GLFW 键码（从上面那张表反推）。
 *
 * 干什么用的：**手机上的虚拟键盘大多不给靠谱的 `code`** —— 安卓输入法常常报空串或
 * "Unidentified"，只有 `key` 里那个字符是真的。所以 code 查不到时退回按字符查，
 * 否则「用手机键盘绑一个 W」这件事根本做不到。
 */
const CHAR_TO_GLFW: Record<string, number> = {}
for (const [glfw, label] of Object.entries(GLFW_TO_LABEL)) {
  if (label.length === 1) CHAR_TO_GLFW[label] = Number(glfw)
}

/** `KeyboardEvent.key` 里的具名键 → code（只有这几个值得认，其余靠单字符那条路） */
const NAME_TO_CODE: Record<string, string> = {
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CapsLock: 'CapsLock',
  ' ': 'Space',
  Shift: 'ShiftLeft',
  Control: 'ControlLeft',
  Alt: 'AltLeft',
  Meta: 'MetaLeft',
}

/**
 * 把玩家刚按下的那个键换成 GLFW 键码。认不出来返回 null（界面要说「这个键不支持」）。
 *
 * 顺序不能反：先看 code（桌面浏览器上它是物理键位，最准），code 认不出再看 key。
 * 反过来做的话，AZERTY 键盘上按物理位置的 W 会被 key='z' 带到 Z 上去。
 */
export function glfwKeyForPress(press: { code?: string; key?: string }): number | null {
  const code = press.code ?? ''
  if (code && CODE_TO_GLFW[code] !== undefined) return CODE_TO_GLFW[code]
  const name = press.key ?? ''
  if (!name) return null
  const mapped = NAME_TO_CODE[name]
  if (mapped) return CODE_TO_GLFW[mapped] ?? null
  // 'w' / 'W' / '1' / '-' 这类单字符：统一转大写再查（表里的标签就是大写的）
  if (name.length === 1) return CHAR_TO_GLFW[name.toUpperCase()] ?? null
  return null
}

/** GLFW 键码 → 显示标签。表里没有的（手改坏的存档）退回 `#数字`，不至于显示成空白 */
export function glfwKeyLabel(glfw: number): string {
  return GLFW_TO_LABEL[glfw] ?? `#${glfw}`
}

/* ---------------- 默认键位 ---------------- */

/** 屏幕手柄上的八颗键，固定这个顺序（改键面板按它排） */
export const DOS_PAD_BUTTONS: readonly PadButton[] = ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start']

/**
 * 出厂键位：方向键 + 左 Ctrl / 左 Alt / 回车 / Esc。
 *
 * 这是「大部分 DOS 动作游戏都在这一套上」的最大公约数（毁灭战士、波斯王子之类），
 * 也是这一路一直以来的行为 —— 加自定义键位**没有**动它，没绑过的玩家体验完全不变。
 * Esc 给 SELECT 而不是别的：DOS 游戏的暂停 / 退出菜单基本都在 Esc，
 * 手机玩家最容易卡住的地方就是「进了游戏出不来」。
 */
export const DOS_PAD_DEFAULT: Record<PadButton, number> = {
  up: CODE_TO_GLFW.ArrowUp,
  down: CODE_TO_GLFW.ArrowDown,
  left: CODE_TO_GLFW.ArrowLeft,
  right: CODE_TO_GLFW.ArrowRight,
  a: CODE_TO_GLFW.ControlLeft,
  b: CODE_TO_GLFW.AltLeft,
  start: CODE_TO_GLFW.Enter,
  select: CODE_TO_GLFW.Escape,
}

export type DosPadKeys = Record<PadButton, number>

/* ---------------- 热门游戏预设键位 ---------------- */

/**
 * 热门 DOS 游戏的出厂键位种子表，按 slug 命中（本地文件退回 `local:文件名`，命中不到就回落默认）。
 *
 * ⚠️ 只覆盖八颗屏幕按键（方向 + A/B/SELECT/START），超出这八个的键（数字、功能键、打字）
 * 一律走「屏幕键盘」（见 RuntimeHandle.sendKey）。所以这里只挑每款游戏最关键的那几个动作：
 * 移动方向、开火、菜单。其余交给玩家在「按键映射」里改，或屏幕键盘补。
 *
 * 为什么是种子而不是写死默认：毁灭战士和波斯王子需要的键位完全不同，给所有游戏一套
 * 通用默认键位，结果就是「手机上除了看什么都干不了」（这正是当初做自定义键位的原因）。
 * 命中这里的游戏开箱即玩，没命中的走 DOS_PAD_DEFAULT，行为不变。
 */
export const DOS_PAD_PRESETS: Record<string, Partial<DosPadKeys>> = {
  // 毁灭战士 / 毁灭战士 2 / 赫雷提克 / 六角使者：方向键转身移动，Ctrl 开火，Alt Strafe
  doom: { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  'doom-2': { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  doom2: { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  heretic: { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  hexen: { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  // 沃尔芬斯坦 3D：方向键转身，Ctrl 开火
  wolf3d: { a: CODE_TO_GLFW.ControlLeft },
  'wolfenstein-3d': { a: CODE_TO_GLFW.ControlLeft },
  // 毁灭公爵 3D / Build 引擎：Ctrl 开火，Alt 蹲下 / 平移，空格跳
  'duke-nukem-3d': { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  duke3d: { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  'blood': { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  'shadow-warrior': { a: CODE_TO_GLFW.ControlLeft, b: CODE_TO_GLFW.AltLeft },
  // 雷神之锤：鼠标看向，键盘只负责移动，默认方向键即可，无需特别覆盖
  quake: {},
  // 主题医院 / 模拟城市 / 文明 等点选经营类：主要靠鼠标，键盘用默认
  'theme-hospital': {},
  simcity: {},
  civilization: {},
  // 波斯王子：方向键移动，Shift 抓扶，Ctrl 快走（默认 Ctrl 已被 A 占，这里不动，玩家可改）
  'prince-of-persia': {},
}

/**
 * 这款游戏的出厂键位（默认或预设）。`loadDosPadKeys` 拿它当底，再叠玩家自己的改动。
 * 把「算默认」抽出来：改键面板的「恢复默认」也要拿到同一份（否则预设游戏恢复后会丢掉预设）。
 */
export function dosPadDefault(gameKey: string): DosPadKeys {
  const preset = DOS_PAD_PRESETS[gameKey]
  return preset ? { ...DOS_PAD_DEFAULT, ...preset } : { ...DOS_PAD_DEFAULT }
}

/* ---------------- 按游戏存取 ---------------- */

/** 键位是按游戏存的，前缀 + slug。改前缀等于把所有玩家的自定义键位丢掉 */
const PREFIX = '8bitgo.dospad.'

/**
 * localStorage 的存取代。读不到的场合有三种：隐私模式、被策略禁用、以及**服务端 / node**
 * （这个模块会被 scripts/test-*.mjs 直接 import）。三种都返回 null，让调用方走默认键位。
 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function keyOf(gameKey: string) {
  return PREFIX + gameKey
}

/**
 * 读这个游戏的键位。**永远返回一份完整可用表**（缺的补默认、坏值丢掉），
 * 调用方不需要再判空 —— 少一颗键的手柄比一套默认键位糟得多。
 */
export function loadDosPadKeys(gameKey: string): DosPadKeys {
  const out: DosPadKeys = dosPadDefault(gameKey)
  const s = store()
  if (!s || !gameKey) return out
  try {
    const raw = s.getItem(keyOf(gameKey))
    if (!raw) return out
    const parsed = JSON.parse(raw) as Partial<Record<PadButton, unknown>>
    for (const b of DOS_PAD_BUTTONS) {
      const v = parsed[b]
      // 只认表里有的键码：存档被手改坏、或者以后从表里删掉过某个键时，
      // 宁可退回默认，也不能塞一个引擎不认的数字进去（那会变成一颗死键，还查不出来）
      if (typeof v === 'number' && GLFW_TO_LABEL[v] !== undefined) out[b] = v
    }
  } catch {
    /* 解析失败当没存过 */
  }
  return out
}

export function saveDosPadKeys(gameKey: string, keys: DosPadKeys) {
  const s = store()
  if (!s || !gameKey) return
  try {
    s.setItem(keyOf(gameKey), JSON.stringify(keys))
  } catch {
    /* 配额满 / 隐私模式：这一局照样是自定义键位，只是下次记不住 */
  }
}

export function resetDosPadKeys(gameKey: string) {
  const s = store()
  if (!s || !gameKey) return
  try {
    s.removeItem(keyOf(gameKey))
  } catch {
    /* 同上 */
  }
}

/** 改过没有。「恢复默认」按钮和面板上的提示按它显示 */
export function dosPadCustomized(gameKey: string): boolean {
  const s = store()
  if (!s || !gameKey) return false
  try {
    return s.getItem(keyOf(gameKey)) !== null
  } catch {
    return false
  }
}
