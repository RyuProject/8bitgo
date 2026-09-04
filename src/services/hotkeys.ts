/**
 * 存 / 读档的快捷键：绑定表、按键组合的规范化、冲突处理。
 *
 * ── 为什么单独一个文件、而且没有任何 import ─────────────────
 * 和 saveTarget.ts 一样：**node 侧能直接跑测试**。
 * 快捷键这种东西最容易坏在「同一个键被绑了两次」「大小写/布局不同就认不出」上，
 * 这些都是纯逻辑，值得用测试钉死。真正跟 DOM 打交道的部分在 emulator/hotkeyBridge.ts。
 *
 * ── 为什么用 KeyboardEvent.code 而不是 key ─────────────────
 * `key` 跟着键盘布局和输入法走：法语 AZERTY 上按同一个物理键 `key` 是 'a' 还是 'q'
 * 取决于布局，中文输入法开着的时候 `key` 还可能是 'Process'。`code` 是**物理位置**，
 * 绑了就永远是那个键 —— 游戏按键从来都该按位置绑。
 * 代价是显示时要把 'KeyS' / 'Digit1' 这种内部名翻译回人看的 'S' / '1'（见 comboLabel）。
 */

/** 能绑快捷键的动作。和存档面板那三张卡一一对应，每张卡两个 */
export type HotkeyAction =
  | 'save:cloud'
  | 'load:cloud'
  | 'save:local'
  | 'load:local'
  | 'save:file'
  | 'load:file'

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  'save:cloud',
  'load:cloud',
  'save:local',
  'load:local',
  'save:file',
  'load:file',
]

/**
 * 默认键位。
 *
 * F2 存 / F4 读是模拟器界几十年的老规矩（从 ZSNES 那个年代就是），
 * 老玩家不用学。本地那份占掉这两个最顺手的，云端加 Shift，文件走 F9。
 *
 * ⚠️ 刻意避开 F1（帮助）、F5（刷新）、F11（全屏）、F12（开发者工具）——
 * 这几个 preventDefault 也未必拦得住，绑上去就是个时灵时不灵的键。
 */
export const DEFAULT_HOTKEYS: Readonly<Record<HotkeyAction, string>> = {
  'save:local': 'F2',
  'load:local': 'F4',
  'save:cloud': 'Shift+F2',
  'load:cloud': 'Shift+F4',
  'save:file': 'F9',
  'load:file': 'Shift+F9',
}

const STORE_KEY = '8bitgo.hotkeys'

/** 修饰键的固定顺序。不固定的话 'Shift+Ctrl+F2' 和 'Ctrl+Shift+F2' 会被当成两个键 */
export interface ComboParts {
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  code: string
}

/** 组合成规范写法：修饰键按固定顺序在前，物理键码在后 */
export function comboOf(e: ComboParts): string {
  if (!e.code) return ''
  const out: string[] = []
  if (e.ctrl) out.push('Ctrl')
  if (e.alt) out.push('Alt')
  if (e.shift) out.push('Shift')
  if (e.meta) out.push('Meta')
  out.push(e.code)
  return out.join('+')
}

/**
 * 这个组合能不能拿来绑。
 *
 * 光按住修饰键不算（'Shift' 本身不是一个键位）；F5 / F11 / F12 这类浏览器抢走的也不收 ——
 * 收下来的结果是玩家绑了个按下去刷新页面的「快捷键」。
 */
const RESERVED = new Set(['F5', 'F11', 'F12', 'F1', 'Tab', 'Escape'])
const MOD_CODES = /^(Shift|Control|Alt|Meta)(Left|Right)$/

export function isBindable(combo: string): boolean {
  if (!combo) return false
  const code = combo.split('+').pop() ?? ''
  if (!code || MOD_CODES.test(code)) return false
  if (RESERVED.has(code)) return false
  return true
}

/** 内部键码翻译成人看的：KeyS → S，Digit1 → 1，ArrowUp → ↑ */
export function comboLabel(combo: string): string {
  if (!combo) return ''
  const parts = combo.split('+')
  const code = parts.pop() ?? ''
  const pretty = code
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
    .replace(/^Space$/, 'Space')
  return [...parts, pretty].join(' + ')
}

type Bindings = Record<HotkeyAction, string>

/**
 * 改完键要让页面上别的地方跟着重画 —— 游戏详情页底下那张「操作说明」表也在读这份绑定，
 * 玩家在播放器里改了键，那张表却还写着旧的，比不显示更糟。
 *
 * 用最小的一个订阅器（没有 import，node 侧照样能跑测试）。
 */
const listeners = new Set<() => void>()

/** 订阅改键。返回退订函数 */
export function onHotkeysChange(fn: () => void): () => void {
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

function isAction(v: string): v is HotkeyAction {
  return (HOTKEY_ACTIONS as readonly string[]).includes(v)
}

/**
 * 当前绑定 = 默认值叠上玩家改过的那几个。
 *
 * 存的是**差量**而不是整张表：以后加新动作、或者改默认键位时，
 * 老玩家不会因为本地存着一张旧的完整表而收不到新键位。
 */
export function getHotkeys(): Bindings {
  const out = { ...DEFAULT_HOTKEYS }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return out
    const saved = JSON.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(saved)) {
      // 玩家可以把某个动作解绑（存空串），所以空串是合法值，不能当没配
      if (isAction(k) && typeof v === 'string' && (v === '' || isBindable(v))) out[k] = v
    }
  } catch {
    /* 无痕模式 / 存的是坏 JSON：用默认值 */
  }
  return out
}

/**
 * 绑一个键。返回**被这一下抢走键位的那个动作**（没有就是 null），调用方好告诉玩家。
 *
 * 冲突处理选的是「抢过来 + 说一声」而不是「拒绝」：拒绝的话玩家得先去把占着的那个
 * 解绑再回来绑一次，两步；而抢过来是一步，且看得见发生了什么、随时能改回去。
 *
 * combo 传空串 = 解绑这个动作。
 */
export function setHotkey(action: HotkeyAction, combo: string): HotkeyAction | null {
  if (combo && !isBindable(combo)) return null
  const now = getHotkeys()
  let stolenFrom: HotkeyAction | null = null
  if (combo) {
    for (const a of HOTKEY_ACTIONS) {
      if (a !== action && now[a] === combo) {
        now[a] = ''
        stolenFrom = a
      }
    }
  }
  now[action] = combo

  // 只存和默认值不一样的那几条
  const diff: Record<string, string> = {}
  for (const a of HOTKEY_ACTIONS) if (now[a] !== DEFAULT_HOTKEYS[a]) diff[a] = now[a]
  try {
    if (Object.keys(diff).length) localStorage.setItem(STORE_KEY, JSON.stringify(diff))
    else localStorage.removeItem(STORE_KEY)
  } catch {
    /* 存不下就这一次生效，下次回默认 */
  }
  emitChange()
  return stolenFrom
}

/** 全部恢复默认 */
export function resetHotkeys(): void {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* ignore */
  }
  emitChange()
}

/** 这个组合对应哪个动作；没绑就是 null */
export function actionForCombo(combo: string, bindings: Bindings = getHotkeys()): HotkeyAction | null {
  if (!combo) return null
  for (const a of HOTKEY_ACTIONS) if (bindings[a] === combo) return a
  return null
}

