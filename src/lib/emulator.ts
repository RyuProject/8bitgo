/**
 * 播放器相关的通用小工具。运行时（EmulatorJS / Ruffle）的挂载逻辑见 src/runtimes/。
 */
import { getT, fmt } from '@/services/i18n'
import type { PlatformId } from '@/types'
import {
  ARCADE_FIGHTER_BUTTONS,
  ARCADE_GENERIC_BUTTONS,
  EJS_INDEX,
  EJS_DPAD,
  EJS_KEY_BY_ID,
  EJS_PLATFORM_BUTTONS,
  PASSTHROUGH_RUNTIMES,
  QUICK_SAVE_RUNTIMES,
  type EjsButton,
} from './keymapData'
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
 *   · **街机**在现实里是几十种按键数不同的板子（拳皇四键、街霸六键、吃豆人只有摇杆），
 *     摆一张固定的「三拳三脚」对大多数游戏都是错的；
 *   · **DOS / Flash / 第三方 HTML5** 压根不经过手柄映射，键盘是直接给游戏的，
 *     键位由游戏自己定（毁灭战士按 Ctrl 开枪，那是游戏的事，不是我们的）；
 *   · **J2ME** 相反 —— FreeJ2ME 的键盘映射是**固定**的（方向键 + 数字键 + 软键），
 *     说成「游戏自己定」等于把已知的事推给玩家去猜；
 *   · **PS2** 跑的是 Play!，EmulatorJS 那套键位一个字都传不进去（adapters/play.ts
 *     里根本没有键位映射），摆出来是纯粹编的；
 *   · **世嘉MD** 是 A/B/C（六键手柄再加 X/Y/Z 和 MODE），不是 A/B/X/Y。
 *
 * 表里的键位不是猜的，都对着引擎 / 核心的源码核过（2026-09-07）：
 *   EmulatorJS  public/emulatorjs/emulator.min.js 的 defaultControllers（默认键）
 *               + createControlSettingMenu（**每个平台有哪几颗键**，不在方案里的
 *                 下标会被引擎从映射表里删掉，摆出来就是死键）
 *   FBNeo       src/burner/libretro/retro_input.{cpp,h} 的 FIRE01..06 与 COL_TOP/BOTTOM
 *   jsnes       services/padKeys.ts 的 DEFAULT_PAD_KEYS（玩家可改，读当前生效的那份）
 *   js-dos      adapters/jsdos.ts 的 DOS_PAD_MAP（那是**手柄**映射，键盘是直通的）
 *   FreeJ2ME    public/j2me/src/key.js 的 codeMap
 *
 * ⚠️ 改任何一行之前先跑 `npm run test:keymap` —— 它会拿 emulator.min.js 逐条核。
 */

/**
 * 手柄上的槽位。**语言无关**，专给开局前那张手柄图（PadDiagram）用。
 *
 * ⚠️ 别拿 `button` 那个字段去认按钮 —— 它是**翻译过的**（'#dpad' → 「方向键」/「十字キー」/
 * 「Steuerkreuz」…）。按文本认，八种语言里必然有一种认不出来，而认不出来的表现是
 * 那颗按钮从图上**静默消失**，不是报错。所以身份走这个字段，文字只用来显示。
 *
 * 没有槽位的行（街机的「按键 1~6」、J2ME 的数字键、红白机的连发）不是遗漏：
 * 它们在手柄上没有固定位置，PadDiagram 会把它们画成键帽，多到一定程度整张图退回键帽列。
 */
export type KeySlot = 'dpad' | 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'start' | 'select'

/** data 里的原始 label（没翻译过的那个）→ 槽位。认不出来的返回 undefined，不是错误 */
const SLOT_OF_LABEL: Readonly<Record<string, KeySlot>> = {
  '#dpad': 'dpad',
  // 万代那台有两组方向键：X 组当十字键画，Y 组没有对应位置，落到键帽里
  '#xPad': 'dpad',
  A: 'a', B: 'b', X: 'x', Y: 'y', L: 'l', R: 'r',
  Start: 'start', Select: 'select',
}

export interface KeymapRow {
  button: string
  key: string
  /** 见 KeySlot。认不出来就不给 —— 调用方据此决定画不画得成一张手柄图 */
  slot?: KeySlot
  /**
   * 一组方向键拆开之后的四颗键，顺序是**上 下 左 右**。
   *
   * `key` 是拼好给人读的那一串（「↑ ↓ ← →」），画十字的时候需要一颗一颗放，
   * 而拿 `key.split(' ')` 去拆是错的：红白机绑到小键盘时那一格是「小键盘 8 2 4 6」，
   * 拆出来是五段。所以拆开的那份在这里单独给。
   */
  parts?: string[]
}

/** 改键入口在哪儿。三档各有各的话要说，混成一句话就一定有一档是错的 */
export type RebindKind =
  /**
   * 播放器底部工具条的 🎮 面板。
   *
   * 改键分两路：红白机走我们自己的 NesKeyBinder（映射是自己实现的），
   * EmulatorJS 走引擎自带那套（面板更全，我们只在同一个 🎮 面板里补了个入口 ——
   * 见 adapters/emulatorjs.ts 的 openControls）。DOS / Flash / J2ME 键盘直通游戏，没有。
   */
  | 'ours'
  /** 引擎自带的设置菜单（EmulatorJS 画面内那条工具条上的手柄图标 → Control Settings） */
  | 'engine'
  /** 改不了 */
  | 'none'

export interface KeymapInfo {
  rows: KeymapRow[]
  /** 这一段要在表下面补一句什么（键盘直通、街机分板子之类）。空串就不显示 */
  note: string
  rebind: RebindKind
  /**
   * 这一档支不支持站里的快速存 / 读档（F2 / F4）。
   *
   * ⚠️ 必须和 EmulatorTools 那句 `if (!caps.has('saveState')) return` 对得上：
   * 快捷键只在运行时有 saveState 时才装。以前这张表**无条件**摆出 F2 / F4，
   * 于是 DOS / Java / 第三方 HTML5 的「操作说明」整段只有两张卡、而且两张都是死键；
   * Java 更糟 —— F2 在 FreeJ2ME 的 codeMap 里是右软键，按下去等于替玩家按了游戏的软键。
   */
  quickSave: boolean
  /** 插手柄能不能自动识别 */
  pad: boolean
  /** 手机上有没有虚拟按键：'all' 全都有、'some' 只有认得的那些游戏有、'none' 没有 */
  touch: 'none' | 'some' | 'all'
  /** 2P 键位。空 / 缺省就不显示第二组，也不显示「1P」那个小标题 */
  player2?: KeymapRow[]
  /** 2P 那一组下面补的话（小键盘、NumLock 这些前提条件） */
  player2Note?: string
}

/* 名单本体在 keymapData.ts —— 那个文件不 import 任何东西，测试才能在 node 里直接核 */
const QUICK_SAVE = new Set(QUICK_SAVE_RUNTIMES)
const PASSTHROUGH = new Set(PASSTHROUGH_RUNTIMES)

/** 一颗（或一组方向）按钮的默认键。一组会连起来显示成「↑ ↓ ← →」 */
function keysOf(id: number | readonly number[]): string {
  return Array.isArray(id)
    ? (id as readonly number[]).map((i) => EJS_KEY_BY_ID[i] ?? '—').join(' ')
    : (EJS_KEY_BY_ID[id as number] ?? '—')
}

export function getDefaultKeymap(runtimeId?: string, platform?: PlatformId): KeymapInfo {
  const t = getT()
  const quickSave = Boolean(runtimeId && QUICK_SAVE.has(runtimeId))
  /** `#xxx` 是要翻译的行名（见 keymapData 的 EjsButton），其余是键名 / 符号，不用翻 */
  const label = (name: string): string =>
    name.startsWith('#') ? ((t.keymap as unknown as Record<string, string>)[name.slice(1)] ?? name.slice(1)) : name
  const rowsOf = (buttons: readonly EjsButton[]): KeymapRow[] =>
    buttons.map(([name, id]) => ({
      button: label(name),
      key: keysOf(id),
      slot: SLOT_OF_LABEL[name],
      parts: Array.isArray(id) ? (id as readonly number[]).map((i) => EJS_KEY_BY_ID[i] ?? '—') : undefined,
    }))

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
    const keyLabel = (seat: Seat, action: PadAction): string => {
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
      if (codes.some((c) => !c)) return codes.map((c, i) => (c ? keyLabel(seat, dirs[i]) : '—')).join(' ')
      if (codes.every((c) => c.startsWith('Numpad'))) {
        return `${t.keymap.numpad} ${codes.map((c) => c.slice('Numpad'.length)).join(' ')}`
      }
      return codes.map((c) => padKeyLabel(c)).join(' ')
    }

    /** 拆开的四颗方向键（上 下 左 右）。dpadOf 那一串是给人读的，这一份是给手柄图摆位置的 */
    const dpadParts = (seat: Seat): string[] =>
      (['up', 'down', 'left', 'right'] as PadAction[]).map((d) => keyLabel(seat, d) || '—')

    /** 没绑键的动作不摆出来 —— 画一格按下去没反应的比不画更糟 */
    const seatRows = (seat: Seat): KeymapRow[] =>
      (
        [
          // parts 是拆开的四颗（上 下 左 右）；连发那两颗在手柄上没有固定位置，不给槽位
          { button: t.keymap.dpad, key: dpadOf(seat), slot: 'dpad', parts: dpadParts(seat) },
          { button: 'A', key: keyLabel(seat, 'a'), slot: 'a' },
          { button: 'B', key: keyLabel(seat, 'b'), slot: 'b' },
          { button: t.keymap.turboA, key: keyLabel(seat, 'turboA') },
          { button: t.keymap.turboB, key: keyLabel(seat, 'turboB') },
          { button: 'Start', key: keyLabel(seat, 'start'), slot: 'start' },
          { button: 'Select', key: keyLabel(seat, 'select'), slot: 'select' },
        ] as KeymapRow[]
      ).filter((r) => r.key)

    return {
      rows: seatRows(0),
      note: '',
      rebind: 'ours',
      quickSave,
      pad: true,
      touch: 'all',
      player2: seatRows(1),
      player2Note: t.keymap.player2Note,
    }
  }

  /**
   * 键盘直通的那几种：DOS、Flash、第三方 HTML5 游戏页。
   * 键位是游戏自己定的，我们给不出一张表 —— 与其编一张，不如说清楚去哪儿找。
   *
   * ⚠️ J2ME **不在**这一档：FreeJ2ME 的键盘映射是固定的，见下面那个分支。
   */
  if (runtimeId && PASSTHROUGH.has(runtimeId)) {
    return {
      rows: [],
      note: t.keymap.passthrough,
      rebind: 'none',
      quickSave,
      // DOS 的手柄由 adapters/jsdos.ts 翻译成键盘（DOS_PAD_MAP）；Flash 那边没有手柄映射，
      // 屏幕手柄也只画给键位表里认得的那些游戏（adapters/ruffle.ts 的 `if (keys)`）
      pad: runtimeId === 'jsdos',
      touch: runtimeId === 'ruffle' ? 'some' : runtimeId === 'jsdos' ? 'all' : 'none',
    }
  }

  /**
   * J2ME：键位是 FreeJ2ME 固定死的，出处是 public/j2me/src/key.js 的 codeMap
   * （我们自己的手柄映射 adapters/j2me.ts 的 J2ME_PAD_MAP 也是照着它来的）。
   * 每颗键在游戏里是什么功能由游戏定，但**哪颗键对应手机上的哪个键**是确定的。
   */
  if (runtimeId === 'j2me') {
    return {
      rows: [
        { button: t.keymap.dpad, key: '↑ ↓ ← →', slot: 'dpad', parts: ['↑', '↓', '←', '→'] },
        { button: t.keymap.j2meConfirm, key: 'Enter' },
        { button: t.keymap.j2meNum, key: '0 – 9' },
        { button: t.keymap.j2meSoftL, key: 'F1' },
        { button: t.keymap.j2meSoftR, key: 'F2' },
      ],
      note: t.keymap.j2meNote,
      rebind: 'none',
      quickSave,
      pad: true,
      // run.html 没有带 mobile=1，adapter 也没有 touchpad 能力 —— 手机上是真的没有按键
      touch: 'none',
    }
  }

  /** PS2：Play! 自带键位，EmulatorJS 那套传不进去（adapters/play.ts 里没有任何键位映射） */
  if (runtimeId === 'play') {
    return { rows: [], note: t.keymap.playNote, rebind: 'none', quickSave, pad: false, touch: 'none' }
  }

  /** NDS 的 webretro：键位、菜单、存读档全在 RetroArch 自己那套里（iframe 内按 F1） */
  if (runtimeId === 'webretro') {
    return { rows: [], note: t.keymap.retroarchNote, rebind: 'none', quickSave, pad: true, touch: 'none' }
  }

  /**
   * 街机。
   *
   * 「街机」在我们这儿是一个平台，在现实里是几十种按键数完全不同的板子，
   * 所以这里摆的是**板子上第几个按键落在哪颗键**（核心的通用映射），
   * 拳皇的 A/B/C/D 就是 1~4，合金弹头只用 1/2/4，吃豆人一个都不用。
   * 三拳三脚的六键格斗（街霸 II 这类）核心会自动换成另一套，写在 note 里。
   */
  if (platform === 'arcade') {
    const f = ARCADE_FIGHTER_BUTTONS
    return {
      rows: [
        /*
          ⚠️ 这一格**必须**从 EJS_KEY_BY_ID 现算，不能写死成「↑ ↓ ← →」。
          街机跑的是 EmulatorJS，方向键是引擎的下标 4/5/6/7 —— 2026-09-12 我们把
          默认键改成了 WASD（见 keymapData 的 EJS_KEY_OVERRIDE），写死的那份当场就成了假话：
          表上写箭头、按下去不动，玩家只会以为游戏坏了。
          （J2ME 那一支写死是对的：FreeJ2ME 的键盘映射是它自己定的，和引擎无关。）
        */
        { button: t.keymap.dpad, key: keysOf(EJS_DPAD), slot: 'dpad', parts: EJS_DPAD.map((i) => EJS_KEY_BY_ID[i] ?? '—') },
        // 「按键 1~6」在手柄上没有固定位置（不同板子按键数都不一样），所以不给槽位 ——
        // 六行没槽位会让 PadDiagram 整张图退回键帽列，那正是街机该有的样子
        ...ARCADE_GENERIC_BUTTONS.map((id, i) => ({
          button: fmt(t.keymap.arcadeBtn, { n: String(i + 1) }),
          key: keysOf(id),
        })),
        { button: t.keymap.coin, key: keysOf(EJS_INDEX.select), slot: 'select' as const },
        { button: 'Start', key: keysOf(EJS_INDEX.start), slot: 'start' as const },
      ],
      note: `${t.keymap.arcadeNote} ${fmt(t.keymap.arcadeFighter, {
        pl: keysOf(f.punchL),
        pm: keysOf(f.punchM),
        ph: keysOf(f.punchH),
        kl: keysOf(f.kickL),
        km: keysOf(f.kickM),
        kh: keysOf(f.kickH),
      })}`,
      rebind: 'engine',
      quickSave,
      pad: true,
      touch: 'all',
    }
  }

  /**
   * 其余都是 EmulatorJS。没在表里的平台退回通用手柄那一套 ——
   * 只可能是新加的平台，摆通用表总比摆错平台的表好。
   */
  const fallback: readonly EjsButton[] = [
    ['#dpad', [4, 5, 6, 7]],
    ['A', EJS_INDEX.a], ['B', EJS_INDEX.b], ['X', EJS_INDEX.x], ['Y', EJS_INDEX.y],
    ['L', EJS_INDEX.l], ['R', EJS_INDEX.r],
    ['Start', EJS_INDEX.start], ['Select', EJS_INDEX.select],
  ]
  return {
    rows: rowsOf((platform && EJS_PLATFORM_BUTTONS[platform]) ?? fallback),
    note: '',
    rebind: 'engine',
    quickSave,
    pad: true,
    touch: 'all',
  }
}
