/**
 * 播放器相关的通用小工具。运行时（EmulatorJS / Ruffle）的挂载逻辑见 src/runtimes/。
 */
import { getT } from '@/services/i18n'
import type { PlatformId } from '@/types'
export { EJS_PATH, RUFFLE_PATH } from '@/emulator'


/** 判断文件后缀是否在允许的 ROM 类型内 */
export function isRomFileAccepted(file: File, extensions: string[]): boolean {
  const name = file.name.toLowerCase()
  return extensions.some((ext) => name.endsWith(ext))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 默认键位表。
 *
 * ── 为什么要按运行时 + 平台分 ───────────────────────────────
 * 以前不管什么游戏都摆同一张 A/B/X/Y/L/R 的表。对 SNES 是对的，
 * 对别的全是错的，而且是**看起来很像真的**那种错：
 *
 *   · **红白机 / GB** 根本没有 X/Y/L/R 这四个键，摆出来玩家会去按，按了没反应；
 *   · **街机**（拳皇、街霸）是六个拳脚键，不是手柄的 ABXY —— 玩家真正想知道的是
 *     「哪个键是轻拳」，而表上写着「A」对他毫无用处；
 *   · **DOS / Flash / J2ME** 压根不经过手柄映射，键盘是直接给游戏的，
 *     键位由游戏自己定（毁灭战士按 Ctrl 开枪，那是游戏的事，不是我们的）——
 *     给它摆一张手柄表是纯粹的误导；
 *   · **世嘉MD** 是 A/B/C 三键，不是 A/B/X/Y。
 *
 * 表里的键位不是猜的，都对着引擎的源码核过（2026-09-04）：
 *   EmulatorJS  public/emulatorjs/emulator.min.js 的 defaultControllers
 *               （libretro 手柄下标：0=B 8=A 1=Y 9=X 2=Select 3=Start 10=L 11=R）
 *   jsnes       node_modules/jsnes/src/browser/keyboard.js 的 KEYS
 *   js-dos      adapters/jsdos.ts 的 DOS_PAD_MAP（那是**手柄**映射，键盘是直通的）
 *
 * ⚠️ 改任何一行之前先回去看那三处，别照着别的站抄。
 */

export interface KeymapRow {
  button: string
  key: string
}

export interface KeymapInfo {
  rows: KeymapRow[]
  /** 这一段要在表下面补一句什么（键盘直通、街机六键之类）。空串就不显示 */
  note: string
  /** 能不能在引擎自己的设置里改键 —— 只有 EmulatorJS 有这个菜单 */
  customizable: boolean
}

/** EmulatorJS 的默认键位，按 libretro 手柄下标核对过 */
const EJS = {
  a: 'Z',
  b: 'X',
  x: 'A',
  y: 'S',
  l: 'Q',
  r: 'E',
  l2: 'Tab',
  r2: 'R',
  start: 'Enter',
  select: 'V',
} as const

/** 哪些平台有哪些键。没有的键不摆出来 —— 摆了玩家会去按 */
const EJS_BUTTONS: Partial<Record<PlatformId, Array<[string, string]>>> = {
  // 两键机：红白机、GB / GBC、万代 WonderSwan
  nes: [['A', EJS.a], ['B', EJS.b]],
  gb: [['A', EJS.a], ['B', EJS.b]],
  gbc: [['A', EJS.a], ['B', EJS.b]],
  ws: [['A', EJS.a], ['B', EJS.b]],
  // 四键 + 肩键
  snes: [['A', EJS.a], ['B', EJS.b], ['X', EJS.x], ['Y', EJS.y], ['L', EJS.l], ['R', EJS.r]],
  gba: [['A', EJS.a], ['B', EJS.b], ['L', EJS.l], ['R', EJS.r]],
  nds: [['A', EJS.a], ['B', EJS.b], ['X', EJS.x], ['Y', EJS.y], ['L', EJS.l], ['R', EJS.r]],
  // 世嘉 MD 是 A/B/C 三键。核心把它们映到 libretro 的 Y/B/A 上
  segaMD: [['A', EJS.y], ['B', EJS.b], ['C', EJS.a], ['Start', EJS.start]],
  psx: [
    ['○', EJS.a], ['✕', EJS.b], ['△', EJS.x], ['□', EJS.y],
    ['L1', EJS.l], ['R1', EJS.r], ['L2', EJS.l2], ['R2', EJS.r2],
  ],
  n64: [['A', EJS.a], ['B', EJS.b], ['L', EJS.l], ['R', EJS.r], ['Z', EJS.l2]],
}

export function getDefaultKeymap(runtimeId?: string, platform?: PlatformId): KeymapInfo {
  const t = getT()
  const dpad: KeymapRow = { button: t.keymap.dpad, key: '↑ ↓ ← →' }

  // 红白机实际跑的是 jsnes（见 config/emulators.ts 的扩展名覆盖表），它的键位和 EmulatorJS 不一样
  if (runtimeId === 'jsnes') {
    return {
      rows: [
        dpad,
        { button: 'A', key: 'X' },
        { button: 'B', key: 'Z' },
        { button: t.keymap.turboA, key: 'S' },
        { button: t.keymap.turboB, key: 'A' },
        { button: 'Start', key: 'Enter' },
        { button: 'Select', key: t.keymap.rightCtrl },
      ],
      note: '',
      customizable: false,
    }
  }

  /**
   * 键盘直通的那几种：DOS、Flash、J2ME、以及第三方 HTML5 游戏页。
   * 键位是游戏自己定的，我们给不出一张表 —— 与其编一张，不如说清楚去哪儿找。
   */
  if (runtimeId === 'jsdos' || runtimeId === 'ruffle' || runtimeId === 'j2me' || runtimeId === 'html5') {
    return { rows: [], note: t.keymap.passthrough, customizable: false }
  }

  // 街机：六个拳脚键，玩家要的是「哪个键是轻拳」，写 A/B/X/Y 对他没用
  if (platform === 'arcade') {
    return {
      rows: [
        dpad,
        { button: t.keymap.punchL, key: EJS.a },
        { button: t.keymap.punchM, key: EJS.x },
        { button: t.keymap.punchH, key: EJS.l },
        { button: t.keymap.kickL, key: EJS.b },
        { button: t.keymap.kickM, key: EJS.y },
        { button: t.keymap.kickH, key: EJS.r },
        { button: t.keymap.coin, key: EJS.select },
        { button: 'Start', key: EJS.start },
      ],
      note: t.keymap.arcadeNote,
      customizable: true,
    }
  }

  const buttons = (platform && EJS_BUTTONS[platform]) ?? [
    ['A', EJS.a], ['B', EJS.b], ['X', EJS.x], ['Y', EJS.y], ['L', EJS.l], ['R', EJS.r],
  ]
  return {
    rows: [
      dpad,
      ...buttons.map(([button, key]) => ({ button, key })),
      ...(platform === 'segaMD' ? [] : [{ button: 'Start', key: EJS.start }, { button: 'Select', key: EJS.select }]),
    ],
    note: '',
    customizable: true,
  }
}
