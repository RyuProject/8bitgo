/**
 * 键位表对不对 —— 直接拿引擎自己的源码来核（src/lib/keymapData.ts）。
 *
 * 这两张表是从别人的代码里抄出来的常量：抄错了 tsc 不响、页面照样渲染，
 * 只有玩家按下去才发现按错键。升级 EmulatorJS / jsnes 的时候尤其容易悄悄失效。
 * 所以这个测试不写死期望值，而是**每次都去解析引擎源码**再比对：
 *
 *   · EmulatorJS  public/emulatorjs/emulator.min.js 里的 this.defaultControllers[0]
 *   · jsnes       node_modules/jsnes/src/browser/keyboard.js 里的 KEYS
 *
 * 用法：npm run test:keymap
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { EJS_KEYS, EJS_INDEX, JSNES_KEYS, JSNES_KEYCODE } = await import('../src/lib/keymapData.ts')

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('✅ ' + msg) }

/* ── EmulatorJS ────────────────────────────────────────────
 * 打包后长这样：this.defaultControllers={0:{0:{value:"x",value2:"BUTTON_2"},1:{...},...},1:{},...}
 * 只取玩家 0 的那一段，按 `<下标>:{value:"<键>"` 抓出来。 */
const ejsSrc = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
const at = ejsSrc.indexOf('this.defaultControllers={')
assert.ok(at > 0, '在 emulator.min.js 里找不到 defaultControllers —— 打包格式变了，这个测试要跟着改')
const p0 = ejsSrc.slice(at, at + 1400)
const ejsDefaults = {}
for (const m of p0.matchAll(/(\d+):\{value:"([^"]*)"/g)) {
  if (!(m[1] in ejsDefaults)) ejsDefaults[m[1]] = m[2]
}
ok(Object.keys(ejsDefaults).length >= 14, `解析出 ${Object.keys(ejsDefaults).length} 个默认键位`)

// EmulatorJS 存的是 "x" / "enter" / "tab" 这种小写名，我们表里是给人看的 'X' / 'Enter' / 'Tab'
const norm = (s) => s.toLowerCase()

console.log('\n── EmulatorJS 的默认键位 ──')
for (const [button, key] of Object.entries(EJS_KEYS)) {
  const idx = EJS_INDEX[button]
  assert.ok(idx !== undefined, `${button} 没写下标`)
  const actual = ejsDefaults[String(idx)]
  ok(
    norm(actual) === norm(key),
    `${button}（libretro ${idx}）= ${key}${norm(actual) === norm(key) ? '' : `，引擎里其实是 ${actual}`}`,
  )
}

// A 在 8、B 在 0 是最容易抄反的一处，单独钉一下
ok(EJS_INDEX.a === 8 && EJS_INDEX.b === 0, 'libretro 的 0 是 B、8 才是 A（别抄反）')

/* ── jsnes ──────────────────────────────────────────────── */
const jsnesSrc = readFileSync(new URL('../node_modules/jsnes/src/browser/keyboard.js', import.meta.url), 'utf8')
const jsnesKeys = {}
for (const m of jsnesSrc.matchAll(/(\d+):\s*\[(\d+),\s*Controller\.(\w+),\s*"([^"]*)"\]/g)) {
  if (m[2] === '1') jsnesKeys[m[1]] = { button: m[3], label: m[4] } // 只看 1P
}
ok(Object.keys(jsnesKeys).length >= 11, `jsnes 1P 解析出 ${Object.keys(jsnesKeys).length} 个键`)

console.log('\n── jsnes 的默认键位（红白机走的是它，不是 EmulatorJS）──')
const JSNES_BUTTON = {
  a: 'BUTTON_A', b: 'BUTTON_B', turboA: 'BUTTON_TURBO_A', turboB: 'BUTTON_TURBO_B',
  start: 'BUTTON_START', select: 'BUTTON_SELECT',
}
for (const [button, key] of Object.entries(JSNES_KEYS)) {
  const code = JSNES_KEYCODE[button]
  const entry = jsnesKeys[String(code)]
  assert.ok(entry, `keyCode ${code} 在 jsnes 的 KEYS 里不存在了`)
  ok(
    entry.button === JSNES_BUTTON[button] && norm(entry.label) === norm(key),
    `${button} = ${key}（keyCode ${code} → ${entry.button}）`,
  )
}

// jsnes 的 A/B 和 EmulatorJS 正好相反，页面上一定要分开显示，不能共用一张表
ok(
  JSNES_KEYS.a !== EJS_KEYS.a && JSNES_KEYS.a === EJS_KEYS.b,
  'jsnes 的 A 是 X、EmulatorJS 的 A 是 Z —— 两个引擎不能共用一张表',
)

console.log(`\n全部通过 ✅  共 ${n} 项`)
