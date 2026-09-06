/**
 * 播放器相关的通用小工具。运行时（EmulatorJS / Ruffle）的挂载逻辑见 src/runtimes/。
 */
import { getT } from '@/services/i18n'
import type { PlatformId } from '@/types'
import { EJS_KEYS } from './keymapData'
import { bindingOf, getPadKeys, padKeyFor, padKeyLabel, type PadAction, type Seat } from '@/services/padKeys'
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
 * 下载速度。加载遮罩上显示在百分比后面，让「下得慢」和「卡死了」分得清 ——
 * 这是这个读数唯一的用处，所以慢的时候要看得出在动，快的时候不必精确到小数点。
 *
 * 1 MB/s 以下给整数 KB/s：慢网络下 `312 KB/s` 每秒都在变，一眼就知道还活着；
 * 写成 `0.3 MB/s` 反而看起来像不动。
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1024 * 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
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
  /** 2P 键位。空 / 缺省就不显示第二组，也不显示「1P」那个小标题 */
  player2?: KeymapRow[]
  /** 2P 那一组下面补的话（小键盘、NumLock 这些前提条件） */
  player2Note?: string
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
  // PS2 和 PS1 是同一套手柄按键（多的是两根摇杆和 L3/R3）。
  // ⚠️ 键位由 Play! 自己定，不走 EmulatorJS 那套 —— 这张表只是**展示**给玩家看的，
  // 改这里不会真的改掉按键映射（见 adapters/play.ts）。
  ps2: [
    ['○', EJS_KEYS.a], ['✕', EJS_KEYS.b], ['△', EJS_KEYS.x], ['□', EJS_KEYS.y],
    ['L1', EJS_KEYS.l], ['R1', EJS_KEYS.r], ['L2', EJS_KEYS.l2], ['R2', EJS_KEYS.r2],
  ],
}

export function getDefaultKeymap(runtimeId?: string, platform?: PlatformId): KeymapInfo {
  const t = getT()
  const dpad: KeymapRow = { button: t.keymap.dpad, key: '↑ ↓ ← →' }

  // 红白机实际跑的是 jsnes（见 config/emulators.ts 的扩展名覆盖表），它的键位和 EmulatorJS 不一样
  if (runtimeId === 'jsnes') {
    /**
     * 红白机的键位现在是**玩家可改的**（services/padKeys.ts），所以这张表不能再写死常量 ——
     * 得读当前生效的那份，否则玩家在播放器里改完键，详情页底下这张表还写着出厂值，
     * 比不显示更糟。KeymapCards 订阅了 onPadKeysChange，改完会自己重画。
     *
     * 2P 那一组是 jsnes 默认表里本来就有的小键盘键位 —— 一直能用，只是以前没显示过。
     */
    const map = getPadKeys()

    /** 一颗键的显示名。「右 Ctrl」和「小键盘」这两个词要按语言走，其余是键名不用翻 */
    const label = (seat: Seat, action: PadAction): string => {
      const code = padKeyFor(bindingOf(seat, action), map)
      if (!code) return ''
      if (code === 'ControlRight') return t.keymap.rightCtrl
      if (code.startsWith('Numpad')) return `${t.keymap.numpad} ${code.slice('Numpad'.length)}`
      return padKeyLabel(code)
    }

    /**
     * 方向键那一格。四颗都在小键盘上时合成「小键盘 8 2 4 6」——
     * 逐个写成「小键盘 8 小键盘 2 …」会把这一格撑爆。
     */
    const dpadOf = (seat: Seat): string => {
      const dirs: PadAction[] = ['up', 'down', 'left', 'right']
      const codes = dirs.map((d) => padKeyFor(bindingOf(seat, d), map))
      if (codes.some((c) => !c)) return codes.map((c, i) => (c ? label(seat, dirs[i]) : '—')).join(' ')
      if (codes.every((c) => c.startsWith('Numpad'))) {
        return `${t.keymap.numpad} ${codes.map((c) => c.slice('Numpad'.length)).join(' ')}`
      }
      return codes.map((c) => padKeyLabel(c)).join(' ')
    }

    /** 没绑键的动作不摆出来 —— 画一格按下去没反应的比不画更糟 */
    const seatRows = (seat: Seat): KeymapRow[] =>
      [
        { button: t.keymap.dpad, key: dpadOf(seat) },
        { button: 'A', key: label(seat, 'a') },
        { button: 'B', key: label(seat, 'b') },
        { button: t.keymap.turboA, key: label(seat, 'turboA') },
        { button: t.keymap.turboB, key: label(seat, 'turboB') },
        { button: 'Start', key: label(seat, 'start') },
        { button: 'Select', key: label(seat, 'select') },
      ].filter((r) => r.key)

    return {
      rows: seatRows(0),
      note: '',
      customizable: true,
      player2: seatRows(1),
      player2Note: t.keymap.player2Note,
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
