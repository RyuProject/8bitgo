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
 * EmulatorJS 的默认键盘映射，键名用 libretro 手柄的按钮名。
 *
 * 对应 emulator.min.js 里的 `this.defaultControllers[0]`，下标就是 libretro 的
 * RetroPad 编号 —— 注意 0 不是 A 而是 B，A 在 8：这是最容易抄反的一处。
 */
export const EJS_KEYS = {
  b: 'X',
  y: 'S',
  select: 'V',
  start: 'Enter',
  a: 'Z',
  x: 'A',
  l: 'Q',
  r: 'E',
  l2: 'Tab',
  r2: 'R',
} as const

/** 上面每个按钮在 defaultControllers 里的下标。测试拿它去比对 */
export const EJS_INDEX: Readonly<Record<keyof typeof EJS_KEYS, number>> = {
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
}

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
