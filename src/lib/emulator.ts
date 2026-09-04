/**
 * 播放器相关的通用小工具。运行时（EmulatorJS / Ruffle）的挂载逻辑见 src/runtimes/。
 */
import { getT } from '@/services/i18n'
import type { PlatformId } from '@/types'
import { EJS_KEYS, JSNES_KEYS } from './keymapData'
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

/** 哪些平台有哪些键。没有的键不摆出来 —— 摆了玩家会去按 */
const EJS_BUTTONS: Partial<Record<PlatformId, Array<[string, string]>>> = {
  // 两键机：红白机、GB / GBC、万代 WonderSwan
  nes: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b]],
  gb: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b]],
  gbc: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b]],
  ws: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b]],
  // 四键 + 肩键
  snes: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b], ['X', EJS_KEYS.x], ['Y', EJS_KEYS.y], ['L', EJS_KEYS.l], ['R', EJS_KEYS.r]],
  gba: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b], ['L', EJS_KEYS.l], ['R', EJS_KEYS.r]],
  nds: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b], ['X', EJS_KEYS.x], ['Y', EJS_KEYS.y], ['L', EJS_KEYS.l], ['R', EJS_KEYS.r]],
  // 世嘉 MD 是 A/B/C 三键。核心把它们映到 libretro 的 Y/B/A 上
  segaMD: [['A', EJS_KEYS.y], ['B', EJS_KEYS.b], ['C', EJS_KEYS.a], ['Start', EJS_KEYS.start]],
  psx: [
    ['○', EJS_KEYS.a], ['✕', EJS_KEYS.b], ['△', EJS_KEYS.x], ['□', EJS_KEYS.y],
    ['L1', EJS_KEYS.l], ['R1', EJS_KEYS.r], ['L2', EJS_KEYS.l2], ['R2', EJS_KEYS.r2],
  ],
  n64: [['A', EJS_KEYS.a], ['B', EJS_KEYS.b], ['L', EJS_KEYS.l], ['R', EJS_KEYS.r], ['Z', EJS_KEYS.l2]],
}

export function getDefaultKeymap(runtimeId?: string, platform?: PlatformId): KeymapInfo {
  const t = getT()
  const dpad: KeymapRow = { button: t.keymap.dpad, key: '↑ ↓ ← →' }

  // 红白机实际跑的是 jsnes（见 config/emulators.ts 的扩展名覆盖表），它的键位和 EmulatorJS 不一样
  if (runtimeId === 'jsnes') {
    return {
      rows: [
        dpad,
        { button: 'A', key: JSNES_KEYS.a },
        { button: 'B', key: JSNES_KEYS.b },
        { button: t.keymap.turboA, key: JSNES_KEYS.turboA },
        { button: t.keymap.turboB, key: JSNES_KEYS.turboB },
        { button: 'Start', key: JSNES_KEYS.start },
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
        { button: t.keymap.punchL, key: EJS_KEYS.a },
        { button: t.keymap.punchM, key: EJS_KEYS.x },
        { button: t.keymap.punchH, key: EJS_KEYS.l },
        { button: t.keymap.kickL, key: EJS_KEYS.b },
        { button: t.keymap.kickM, key: EJS_KEYS.y },
        { button: t.keymap.kickH, key: EJS_KEYS.r },
        { button: t.keymap.coin, key: EJS_KEYS.select },
        { button: 'Start', key: EJS_KEYS.start },
      ],
      note: t.keymap.arcadeNote,
      customizable: true,
    }
  }

  const buttons = (platform && EJS_BUTTONS[platform]) ?? [
    ['A', EJS_KEYS.a], ['B', EJS_KEYS.b], ['X', EJS_KEYS.x], ['Y', EJS_KEYS.y], ['L', EJS_KEYS.l], ['R', EJS_KEYS.r],
  ]
  return {
    rows: [
      dpad,
      ...buttons.map(([button, key]) => ({ button, key })),
      ...(platform === 'segaMD' ? [] : [{ button: 'Start', key: EJS_KEYS.start }, { button: 'Select', key: EJS_KEYS.select }]),
    ],
    note: '',
    customizable: true,
  }
}
