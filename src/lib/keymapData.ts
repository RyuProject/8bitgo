/**
 * EmulatorJS 键位表的**原始数据**。刻意单独一个文件、且不 import 任何东西 ——
 * 这样 scripts/test-keymap.mjs 能在 node 里直接把它和引擎源码对着核。
 *
 * 为什么值得对着核：这张表是从别人的代码里抄出来的常量，抄错了 tsc 不会响、
 * 页面也照样渲染，只有玩家按下去才发现按错键，升级 EmulatorJS 时最容易悄悄失效。
 * 拼装成给人看的表（分平台、加说明）在 lib/emulator.ts。
 *
 * ⚠️ 红白机（jsnes）的键位**不在这里** —— 它已经改成玩家可改的了，
 * 唯一出处是 services/padKeys.ts 的 DEFAULT_PAD_KEYS，回归测试是 npm run test:padkeys。
 * 别再往这个文件里抄一份 jsnes 的默认值，那就是两份真相。
 */

/**
 * EmulatorJS 的默认键盘映射：**libretro 下标 → 给人看的键名**。
 *
 * 对应 emulator.min.js 里的 `this.defaultControllers[0]`。引擎存的是 "x" / "enter" /
 * "up arrow" 这种小写名，这里写成给人看的写法，方向键直接用箭头符号。
 *
 * 下标就是 libretro 的 RetroPad 编号 —— 注意 0 不是 A 而是 B，A 在 8：
 * 这是最容易抄反的一处。14 / 15（L3 / R3）引擎没给默认键，所以不在表里。
 */
export const EJS_STOCK_KEY_BY_ID: Readonly<Record<number, string>> = {
  0: 'X',
  1: 'S',
  2: 'V',
  3: 'Enter',
  4: '↑',
  5: '↓',
  6: '←',
  7: '→',
  8: 'Z',
  9: 'A',
  10: 'Q',
  11: 'E',
  12: 'Tab',
  13: 'R',
  16: 'H',
  17: 'F',
  18: 'G',
  19: 'T',
  20: 'L',
  21: 'J',
  22: 'K',
  23: 'I',
  24: '1',
  25: '2',
  26: '3',
}

/**
 * **我们自己定的默认键位**，通过 `EJS_defaultControls` 盖掉引擎出厂那套
 * （见 adapters/emulatorjs.ts）。每项是 [引擎认的键名, 给人看的写法]。
 *
 * 为什么要盖：出厂那套是 Z/X/A/S + 方向键 —— 方向键在键盘最右边、动作键在最左边，
 * 两只手要分开半个键盘；而且 Z/X 在不同键盘布局上位置会变（AZERTY 上 Z 在 W 的位置）。
 * 改成左手 WASD、右手 UIJK，两手各管一块，和现在几乎所有 PC 游戏一致。
 *
 * ⚠️ 引擎认的键名必须是它 keyMap 里的那一份写法（小写，方向键叫 "up arrow" 这种）。
 *    写错了不会报错 —— 那颗键会变成**绑不上**，按下去没反应。test:keymap 会逐个核。
 *
 * ⚠️ 20~23 是右摇杆 / N64 的 C 键，本来是 L J K I —— 正好和新的 U I J K 撞。
 *    两颗按钮绑同一颗键在引擎里是**都会触发**，PS1 / N64 会莫名其妙地动摇杆。
 *    所以顺手把它们挪到被腾出来的方向键上（方向键现在归 WASD 了）。
 *    test:keymap 里有一条「最终表不许有重复键」，专门盯这件事。
 */
export const EJS_KEY_OVERRIDE: Readonly<Record<number, readonly [engine: string, label: string]>> = {
  // 面键：B Y A X（注意 0 是 B、8 才是 A）
  0: ['j', 'J'],
  1: ['u', 'U'],
  8: ['k', 'K'],
  9: ['i', 'I'],
  // 投币 / 选择、开始
  2: ['shift', 'Shift'],
  3: ['enter', 'Enter'],
  // 十字键
  4: ['w', 'W'],
  5: ['s', 'S'],
  6: ['a', 'A'],
  7: ['d', 'D'],
  // 右摇杆 / C 键：让位给 UIJK，搬到方向键上（上 下 左 右 = 23 22 21 20）
  23: ['up arrow', '↑'],
  22: ['down arrow', '↓'],
  21: ['left arrow', '←'],
  20: ['right arrow', '→'],
}

/**
 * 最终生效的默认键位：引擎出厂那份**盖上**我们的覆盖。
 * 界面上显示的就是这一份 —— 显示的必须是真正会生效的那个键，否则这张表比不显示更糟。
 */
export const EJS_KEY_BY_ID: Readonly<Record<number, string>> = {
  ...EJS_STOCK_KEY_BY_ID,
  ...Object.fromEntries(Object.entries(EJS_KEY_OVERRIDE).map(([id, [, label]]) => [Number(id), label])),
}

/**
 * 交给引擎的 `EJS_defaultControls`。只动玩家 0，且只给 `value`（键盘）——
 * 引擎是**逐颗按钮浅合并**的（`{...原有, ...给的}`），不给 value2 就保留它原来的手柄映射。
 */
export const EJS_DEFAULT_CONTROLS: Readonly<Record<number, Readonly<Record<number, { value: string }>>>> = {
  0: Object.fromEntries(Object.entries(EJS_KEY_OVERRIDE).map(([id, [engine]]) => [Number(id), { value: engine }])),
}

/** 十字键的四个下标，顺序是**上 下 左 右**。各处都引这一份，别再手抄 [4,5,6,7] */
export const EJS_DPAD: readonly number[] = [4, 5, 6, 7]

/** 常用按钮的 libretro 下标。写代码时比记数字直观 */
export const EJS_INDEX = {
  b: 0,
  y: 1,
  select: 2,
  start: 3,
  a: 8,
  x: 9,
  l: 10,
  r: 11,
  l2: 12,
  r2: 13,
} as const

/** 上面那几个按钮当前的默认键。从 EJS_KEY_BY_ID 推出来，不再手抄第二份 */
export const EJS_KEYS = Object.fromEntries(
  Object.entries(EJS_INDEX).map(([name, id]) => [name, EJS_KEY_BY_ID[id]]),
) as Readonly<Record<keyof typeof EJS_INDEX, string>>

/**
 * 一行按钮说明：[给玩家看的名字, libretro 下标]。
 *
 * 名字以 `#` 开头的是**要翻译的**（`#dpad` → t.keymap.dpad），其余是键名 / 符号，
 * 不用翻。下标给数组时表示这一行是一组方向（上 下 左 右），键位会连起来显示。
 */
export type EjsButton = readonly [label: string, id: number | readonly number[]]

/**
 * 平台 → 引擎的**控制方案名**（emulator.min.js 的 `getControlScheme()`）。
 * 测试拿它去 `createControlSettingMenu` 里找对应那张按钮表，逐条核对下面的 EJS_PLATFORM_BUTTONS。
 */
export const EJS_SCHEME: Readonly<Record<string, string>> = {
  nes: 'nes',
  gb: 'gb',
  gbc: 'gb',
  ws: 'ws',
  snes: 'snes',
  gba: 'gba',
  nds: 'nds',
  segaMD: 'segaMD',
  psx: 'psx',
  n64: 'n64',
}

/**
 * 哪些平台有哪些键。**没有的键一颗都不许摆** —— 摆了玩家会去按，而引擎会把不属于本
 * 控制方案的下标从映射表里整个删掉（见 createControlSettingMenu 结尾那个 for 循环），
 * 按下去是**真的没反应**。
 *
 * 每一条的下标都必须出现在该平台控制方案里，`npm run test:keymap` 会拿引擎源码逐条核。
 * 曾经踩过的：N64 写成 A=8 / B=0（引擎是 A=0 / B=1，8 在 N64 方案里根本不存在）、
 * WonderSwan 摆了一颗 Select（万代那台机器没有 Select，下标 2 也被引擎删掉了）。
 */
export const EJS_PLATFORM_BUTTONS: Readonly<Record<string, readonly EjsButton[]>> = {
  // 两键机：红白机、GB / GBC
  nes: [['#dpad', [4, 5, 6, 7]], ['A', 8], ['B', 0], ['Start', 3], ['Select', 2]],
  gb: [['#dpad', [4, 5, 6, 7]], ['A', 8], ['B', 0], ['Start', 3], ['Select', 2]],
  gbc: [['#dpad', [4, 5, 6, 7]], ['A', 8], ['B', 0], ['Start', 3], ['Select', 2]],
  // 万代 WonderSwan：**两组**方向键（X1-X4 / Y1-Y4），A / B 两键，只有 Start 没有 Select
  ws: [
    ['#xPad', [4, 5, 6, 7]], ['#yPad', [13, 12, 10, 11]],
    ['A', 8], ['B', 0], ['Start', 3],
  ],
  // 四键 + 肩键
  snes: [
    ['#dpad', [4, 5, 6, 7]],
    ['A', 8], ['B', 0], ['X', 9], ['Y', 1], ['L', 10], ['R', 11],
    ['Start', 3], ['Select', 2],
  ],
  gba: [
    ['#dpad', [4, 5, 6, 7]],
    ['A', 8], ['B', 0], ['L', 10], ['R', 11],
    ['Start', 3], ['Select', 2],
  ],
  nds: [
    ['#dpad', [4, 5, 6, 7]],
    ['A', 8], ['B', 0], ['X', 9], ['Y', 1], ['L', 10], ['R', 11],
    ['Start', 3], ['Select', 2],
  ],
  // 世嘉 MD：三键手柄是 A/B/C，六键手柄多 X/Y/Z 和 MODE。没有 Select
  segaMD: [
    ['#dpad', [4, 5, 6, 7]],
    ['A', 1], ['B', 0], ['C', 8], ['X', 10], ['Y', 9], ['Z', 11],
    ['Start', 3], ['MODE', 2],
  ],
  // PS1。L3 / R3 引擎没给默认键，所以不摆
  psx: [
    ['#dpad', [4, 5, 6, 7]],
    ['○', 8], ['✕', 0], ['△', 9], ['□', 1],
    ['L1', 10], ['R1', 11], ['L2', 12], ['R2', 13],
    ['#lStick', [19, 18, 17, 16]], ['#rStick', [23, 22, 21, 20]],
    ['Start', 3], ['Select', 2],
  ],
  // N64：A 是 0、B 是 1（**和别的平台反着来**），没有 Select，C 键和摇杆是玩得动的前提
  n64: [
    ['#dpad', [4, 5, 6, 7]], ['#stick', [19, 18, 17, 16]],
    ['A', 0], ['B', 1], ['#cPad', [23, 22, 21, 20]],
    ['L', 10], ['R', 11], ['Z', 12],
    ['Start', 3],
  ],
}

/**
 * 街机：**引擎用的是通用方案**（`["arcade","mame"].includes(scheme)` 只是把下标 2 的
 * 标签改成 INSERT COIN），板子上第几个按键落到哪颗键是**核心**决定的，不是引擎。
 *
 * 下面两套都对着核心源码核过（2026-09-07，默认核心 fbneo）：
 *
 *   通用（FBNeo retro_input.cpp 的 RETRO_DEVICE_ID_FIRE01..06，默认 nDeviceType）
 *     按键 1..6 → libretro B A Y X R L
 *     拳皇这类 Neo Geo 的 A/B/C/D 就是按键 1~4（fbalpha2012 的 bind_map 里
 *     "P1 Button A".."D" 明写着 B / A / Y / X，两边一致）
 *
 *   三拳三脚（FBNeo 的 bStreetFighterLayout —— 板子同时有三拳三脚，或 CPS2 且 ≥5 键）
 *     轻拳 中拳 重拳 → libretro Y X L
 *     轻脚 中脚 重脚 → libretro B A R
 *
 * ⚠️ 以前这里把轻拳写成 libretro A、中脚写成 libretro Y —— 正好对调，
 *    街霸玩家按「轻拳」出的是中脚。别再凭手感填。
 * ⚠️ 后台把核心换成 fbalpha2012_cps1 / cps2 时，**通用**那一套会变
 *    （它的 "P1 Fire 1" 绑的是 Y 不是 B）；三拳三脚那一套两边一样。
 */
export const ARCADE_GENERIC_BUTTONS: readonly number[] = [0, 8, 1, 9, 11, 10]
export const ARCADE_FIGHTER_BUTTONS: Readonly<Record<string, number>> = {
  punchL: 1,
  punchM: 9,
  punchH: 10,
  kickL: 0,
  kickM: 8,
  kickH: 11,
}

/**
 * 哪些运行时有 `saveState` 能力 —— 也就是站里的快速存 / 读档（F2 / F4）**装不装得上**。
 *
 * 出处是各个 adapter 的 caps（src/emulator/adapters/*.ts），EmulatorTools 那边是
 * `if (!caps.has('saveState')) return`。放在这个没有 import 的文件里，是为了让
 * `npm run test:keymap` 能在 node 里读那几个 adapter 的源码逐个核对，抄漏了会红。
 *
 * ⚠️ js-dos 只有 `fsSave`（把整个文件系统固化下来），不是 saveState —— 它不在名单里。
 */
export const QUICK_SAVE_RUNTIMES: readonly string[] = ['emulatorjs', 'jsnes', 'ruffle', 'cloudgame']

/** 键盘直通给游戏的那几种运行时：键位是游戏自己定的，我们给不出表 */
export const PASSTHROUGH_RUNTIMES: readonly string[] = ['jsdos', 'ruffle', 'html5']

/**
 * jsnes 的默认键盘映射（红白机走的是它，不是 EmulatorJS —— 见 config/emulators.ts）。
 * 对应 node_modules/jsnes/src/browser/keyboard.js 里的 KEYS，1P 那一半。
 */
export const JSNES_KEYS = {
  a: 'X',
  b: 'Z',
  turboA: 'S',
  turboB: 'A',
  start: 'Enter',
  select: 'Right Ctrl',
} as const
