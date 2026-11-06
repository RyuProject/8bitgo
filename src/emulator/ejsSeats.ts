/**
 * EmulatorJS 的多人座位与「方案外按钮」修补。
 *
 * ── 为什么（2026-11-03《魂斗罗》）──────────────────────────────
 * `.8bg` 的红白机默认走 EmulatorJS（FCEUmm）之后，jsnes 原有的两样东西跟着没了：
 *
 * 1. **2P 完全按不动。** 引擎出厂的 `defaultControllers[1..3]` 是空对象：2P~4P 既没有键盘
 *    也没有手柄映射。第二个手柄插上会被分到 2P 槽（gamepadSelection[1]），可 gamepadEvent
 *    只认 `controls[1][i].value2`，一条都没有 —— 双人游戏选了，2P 怎么按都不动。
 *    所有 EmulatorJS 平台都一样（街机双打、SFC、MD……），红白机最显眼。
 * 2. **连发没了。** FCEUmm 把 RetroPad X / Y 当连发 A / B（核心选项 fceumm_turbo_enable），
 *    但引擎的 nes 控制方案里没有 X / Y，建改键面板时把这两个下标从 controls 里整个删掉。
 *    魂斗罗默认枪不按住连射，没有连发就得狂点。
 *
 * 修法：开局（引擎已经读完存档里的控制设置）后，按下面的规则**只补缺的**：
 * - 2P~4P 某个座位一条手柄映射都没有 → 照引擎 1P 的出厂手柄映射补一份；
 * - 2P 一颗键盘键都没绑 → 补小键盘（EJS_P2_KEYS），撞上任何已绑的键就跳过那颗；
 *   已有 2P 键位的旧记录只补新增的 Y / X / L / R 里空着的几颗（EJS_P2_EXTRA_KEY_OVERRIDE）；
 * - 方案外但核心会用的按钮（EJS_RESTORED_BUTTONS）→ 补回 defaultControllers 和 controls。
 * 玩家自己配过的座位一律不动。defaultControllers 也一起补，引擎的「重置」才不会又删光。
 */
import {
  EJS_KEY_OVERRIDE,
  EJS_P2_EXTRA_KEY_OVERRIDE,
  EJS_P2_KEYS,
  EJS_RESTORED_BUTTONS,
  EJS_STOCK_PAD_BY_ID,
} from '@/lib/keymapData'

interface EjsControl {
  value?: string | number
  /** 手柄键名（"BUTTON_1"、"LEFT_STICK_X:+1"）或按钮序号 */
  value2?: unknown
  [key: string]: unknown
}
type EjsSeat = Record<number, EjsControl | undefined>
type EjsSeats = Record<number, EjsSeat | undefined>

export interface EjsSeatTarget {
  controls?: EjsSeats
  defaultControllers?: EjsSeats
  /** 引擎的键名 → keyCode（认不得返回 -1） */
  keyLookup?: (key: string | number) => string | number
}

export interface EjsSeatRepair {
  /** 补回来的方案外按钮（libretro 下标） */
  restored: number[]
  /** 补了手柄映射的座位（1~3） */
  seatPads: number[]
  /** 2P 补上的键盘键数 */
  p2Keys: number
}

const SEATS = [1, 2, 3] as const

/** 这台平台 + 核心要补回来的方案外按钮。核心对不上（比如后台把红白机钉成 nestopia）就不补 */
export function restoredButtonIds(platform: string, core: string | undefined): number[] {
  const entry = EJS_RESTORED_BUTTONS[platform]
  if (!entry || entry.core !== core) return []
  return entry.rows.flatMap(([, id]) => (Array.isArray(id) ? [...id] : [id as number]))
}

/** 核心选项默认值。只给玩家没改过的那份；玩家在引擎菜单里改过的照旧以玩家为准 */
export function ejsInputDefaultOptions(platform: string, core: string | undefined): Record<string, string> {
  // 两个座位都开：1P / 2P 的 X / Y 都是连发。不按 X / Y 时和关着没区别，零副作用
  return restoredButtonIds(platform, core).length && core === 'fceumm' ? { fceumm_turbo_enable: 'Both' } : {}
}

const hasKey = (c: EjsControl | undefined) => c?.value !== undefined && c.value !== '' && c.value !== 0
const hasPad = (c: EjsControl | undefined) => c?.value2 !== undefined && c.value2 !== ''

export function repairEjsSeats(emu: EjsSeatTarget, platform: string, core: string | undefined): EjsSeatRepair {
  const result: EjsSeatRepair = { restored: [], seatPads: [], p2Keys: 0 }
  const controls = emu.controls
  const defaults = emu.defaultControllers
  if (!controls || !defaults?.[0]) return result
  const seat = (all: EjsSeats, p: number): EjsSeat => (all[p] ??= {})

  const codeOf = (key: string | number | undefined): number => {
    if (key === undefined || key === '') return -1
    if (typeof key === 'number') return key
    const code = Number(emu.keyLookup?.(key) ?? -1)
    return Number.isFinite(code) ? code : -1
  }
  const usedCodes = new Set<number>()
  for (const p of [0, ...SEATS]) {
    for (const c of Object.values(controls[p] ?? {})) if (hasKey(c)) usedCodes.add(codeOf(c!.value))
  }
  usedCodes.delete(-1)

  // 1. 方案外按钮补回来（先补，后面 2P~4P 的手柄映射才会连它一起抄）
  for (const id of restoredButtonIds(platform, core)) {
    const key = EJS_KEY_OVERRIDE[id]?.[0]
    const pad = EJS_STOCK_PAD_BY_ID[id]
    const d0 = seat(defaults, 0)
    if (!d0[id]) d0[id] = { ...(key ? { value: key } : {}), ...(pad ? { value2: pad } : {}) }
    const c0 = seat(controls, 0)
    if (!c0[id]) {
      const code = codeOf(key)
      // 玩家把这颗键挪给了别的按钮：只补手柄，键盘留空，绝不让一颗键触发两路
      c0[id] = { ...(code > 0 && !usedCodes.has(code) ? { value: key } : {}), ...(pad ? { value2: pad } : {}) }
      if (code > 0 && !usedCodes.has(code)) usedCodes.add(code)
      result.restored.push(id)
    }
  }

  // 2. 2P~4P 的手柄映射：照引擎 1P 出厂那份（此时已只剩本方案的下标 + 上面补回的）
  const stockPads = Object.entries(seat(defaults, 0))
    .map(([id, c]) => [Number(id), c?.value2] as const)
    .filter(([, pad]) => pad !== undefined && pad !== '')
  for (const p of SEATS) {
    const d = seat(defaults, p)
    for (const [id, pad] of stockPads) if (!hasPad(d[id])) d[id] = { ...d[id], value2: pad }
    const c = seat(controls, p)
    if (Object.values(c).some(hasPad)) continue
    for (const [id, pad] of stockPads) c[id] = { ...c[id], value2: pad }
    if (stockPads.length) result.seatPads.push(p)
  }

  // 3. 2P 键盘：一颗都没绑过才补全套小键盘；方案里没有的下标不补（引擎会删）。
  //    已经有 2P 键位的旧记录（存档里是只有两颗面键的老默认）只补那四颗新增键里**空着**的，
  //    不碰玩家绑过的任何一颗 —— 否则老玩家的铁拳 2P 依旧踢不出脚（2026-11-06）。
  const c1 = seat(controls, 1)
  const d0 = seat(defaults, 0)
  const fresh = !Object.values(c1).some(hasKey)
  const fill = fresh ? EJS_P2_KEYS : EJS_P2_EXTRA_KEY_OVERRIDE
  for (const [idText, [key]] of Object.entries(fill)) {
    const id = Number(idText)
    if (!d0[id] || hasKey(c1[id])) continue
    const code = codeOf(key)
    if (code <= 0 || usedCodes.has(code)) continue
    c1[id] = { ...c1[id], value: key }
    usedCodes.add(code)
    result.p2Keys++
  }
  return result
}

/**
 * 红白机的屏幕手柄：引擎自带 nes 布局 + 一排连发（TB / TA 在 B / A 正上方）。
 * 几何照抄引擎（emulator.min.js 的 nes 分支），连发两颗用街机四键那套已经实测过的坐标。
 * 自己给了 VirtualGamepadSettings 引擎就不再追加 Fast / Slow，所以这里照它的样子补上。
 */
export function nesVirtualPad(): readonly Record<string, unknown>[] {
  return [
    { type: 'button', text: 'TB', id: 'turbo_b', location: 'right', right: 75, top: 0, bold: true, input_value: 1 },
    { type: 'button', text: 'TA', id: 'turbo_a', location: 'right', right: 5, top: 0, bold: true, input_value: 9 },
    { type: 'button', text: 'B', id: 'b', location: 'right', right: 75, top: 70, bold: true, input_value: 0 },
    { type: 'button', text: 'A', id: 'a', location: 'right', right: 5, top: 70, bold: true, input_value: 8 },
    { type: 'dpad', id: 'dpad', location: 'left', left: '50%', right: '50%', joystickInput: false, inputValues: [4, 5, 6, 7] },
    { type: 'button', text: 'Start', id: 'start', location: 'center', left: 60, fontSize: 15, block: true, input_value: 3 },
    { type: 'button', text: 'Select', id: 'select', location: 'center', left: -5, fontSize: 15, block: true, input_value: 2 },
    { type: 'button', text: 'Fast', id: 'speed_fast', location: 'center', left: -35, top: 50, fontSize: 15, block: true, input_value: 27 },
    { type: 'button', text: 'Slow', id: 'speed_slow', location: 'center', left: 95, top: 50, fontSize: 15, block: true, input_value: 29 },
  ]
}
