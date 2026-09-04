/**
 * 键位表的**原始数据**。刻意单独一个文件、且不 import 任何东西 ——
 * 这样 scripts/test-keymap.mjs 能在 node 里直接把它和引擎源码对着核。
 *
 * 为什么值得对着核：这两张表都是从别人的代码里抄出来的常量，
 * 抄错了 tsc 不会响、页面也照样渲染，只有玩家按下去才发现按错键。
 * 而且升级 EmulatorJS / jsnes 时最容易悄悄失效。
 * 拼装成给人看的表（分平台、加说明）在 lib/emulator.ts。
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

/** 上面每个键在 jsnes KEYS 里的 keyCode。测试拿它去比对 */
export const JSNES_KEYCODE: Readonly<Record<keyof typeof JSNES_KEYS, number>> = {
  a: 88, // X
  b: 90, // Z
  turboA: 83, // S
  turboB: 65, // A
  start: 13, // Enter
  select: 17, // Right Ctrl
}
