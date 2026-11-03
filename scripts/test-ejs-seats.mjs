/**
 * EmulatorJS 2P~4P 座位与红白机连发的修补（src/emulator/ejsSeats.ts）。
 *
 * 背景（2026-11-03《魂斗罗》）：引擎出厂 2P~4P 映射是空的，第二个手柄 / 小键盘都按不动；
 * nes 方案又把 FCEUmm 的连发（X / Y）删了。这里用假引擎对象锁住「只补缺的、不动玩家配过的、
 * 不制造撞键」三条语义。键名 → keyCode 用一张最小 keyMap 模拟引擎的 keyLookup。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ejsInputDefaultOptions, nesVirtualPad, repairEjsSeats, restoredButtonIds } from '../src/emulator/ejsSeats.ts'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`)
  }
}

const KEYS = {
  j: 74, k: 75, i: 73, u: 85, w: 87, s: 83, a: 65, d: 68, shift: 16, enter: 13, q: 81, e: 69,
  'numpad 1': 97, 'numpad 2': 98, 'numpad 3': 99, 'numpad 4': 100, 'numpad 6': 102, 'numpad 7': 103, 'numpad 8': 104, 'numpad 9': 105,
}
const keyLookup = (k) => (typeof k === 'number' ? k : KEYS[String(k).toLowerCase()] ?? -1)

/** 引擎 nes 方案删完之后的样子：1P 有键盘 + 手柄，2P~4P 空，X / Y（1 / 9）不见了 */
function nesEngine({ saved } = {}) {
  const d0 = {
    0: { value: 'j', value2: 'BUTTON_2' }, 2: { value: 'shift', value2: 'SELECT' }, 3: { value: 'enter', value2: 'START' },
    4: { value: 'w', value2: 'DPAD_UP' }, 5: { value: 's', value2: 'DPAD_DOWN' }, 6: { value: 'a', value2: 'DPAD_LEFT' },
    7: { value: 'd', value2: 'DPAD_RIGHT' }, 8: { value: 'k', value2: 'BUTTON_1' },
    10: { value: 'q', value2: 'LEFT_TOP_SHOULDER' }, 11: { value: 'e', value2: 'RIGHT_TOP_SHOULDER' },
  }
  const d1 = { 0: { value: 'numpad 9' }, 2: { value: 'numpad 3' }, 3: { value: 'numpad 1' }, 4: { value: 'numpad 8' }, 5: { value: 'numpad 2' }, 6: { value: 'numpad 4' }, 7: { value: 'numpad 6' }, 8: { value: 'numpad 7' } }
  const defaultControllers = { 0: structuredClone(d0), 1: structuredClone(d1), 2: {}, 3: {} }
  // 存档里的 controls：setupKeys 之后 value 是 keyCode；旧存档的 2P 是空的
  const toCodes = (seat) => Object.fromEntries(Object.entries(seat).map(([id, c]) => [id, { ...c, value: keyLookup(c.value) }]))
  const controls = saved ?? { 0: toCodes(d0), 1: {}, 2: {}, 3: {} }
  return { controls, defaultControllers, keyLookup }
}

console.log('一、红白机（FCEUmm）')

check('⚠️ 旧存档：补回连发 I / U + 手柄 X / Y，2P~4P 补手柄，2P 补小键盘', () => {
  const emu = nesEngine()
  const r = repairEjsSeats(emu, 'nes', 'fceumm')
  assert.deepEqual(r.restored.sort(), [1, 9])
  assert.deepEqual(r.seatPads, [1, 2, 3])
  assert.equal(r.p2Keys, 8)
  assert.deepEqual(emu.controls[0][9], { value: 'i', value2: 'BUTTON_3' }, '连发 A = I / 手柄 X')
  assert.deepEqual(emu.controls[0][1], { value: 'u', value2: 'BUTTON_4' }, '连发 B = U / 手柄 Y')
  assert.equal(emu.controls[1][8].value2, 'BUTTON_1', '2P 手柄 A')
  assert.equal(emu.controls[1][9].value2, 'BUTTON_3', '2P 手柄也有连发')
  assert.equal(emu.controls[3][4].value2, 'DPAD_UP', '4P 手柄方向')
  assert.equal(emu.controls[1][8].value, 'numpad 7', '2P 键盘 A = 小键盘 7')
  assert.equal(emu.controls[2][8].value, undefined, '3P / 4P 不给键盘')
  // defaultControllers 也补了，引擎「重置」不会又删光
  assert.equal(emu.defaultControllers[0][9].value, 'i')
  assert.equal(emu.defaultControllers[2][0].value2, 'BUTTON_2')
})

check('第二次开局什么都不改（幂等）', () => {
  const emu = nesEngine()
  repairEjsSeats(emu, 'nes', 'fceumm')
  const before = JSON.stringify(emu.controls)
  const r = repairEjsSeats(emu, 'nes', 'fceumm')
  assert.deepEqual(r, { restored: [], seatPads: [], p2Keys: 0 })
  assert.equal(JSON.stringify(emu.controls), before)
})

check('玩家配过的座位不动：2P 已有手柄 / 键盘就整座不补', () => {
  const emu = nesEngine()
  emu.controls[1] = { 8: { value: 76, value2: 'BUTTON_7' } }
  const r = repairEjsSeats(emu, 'nes', 'fceumm')
  assert.ok(!r.seatPads.includes(1))
  assert.equal(r.p2Keys, 0)
  assert.deepEqual(emu.controls[1], { 8: { value: 76, value2: 'BUTTON_7' } })
})

check('⚠️ 不制造撞键：玩家把 I 改给了 A，连发 A 只补手柄；小键盘被占的那颗跳过', () => {
  const emu = nesEngine()
  emu.controls[0][8] = { value: 73, value2: 'BUTTON_1' } // A 改成 I
  emu.controls[0][0] = { value: 105, value2: 'BUTTON_2' } // B 改成小键盘 9
  const r = repairEjsSeats(emu, 'nes', 'fceumm')
  assert.deepEqual(emu.controls[0][9], { value2: 'BUTTON_3' })
  assert.equal(emu.controls[0][1].value, 'u')
  assert.equal(emu.controls[1][0]?.value, undefined, '小键盘 9 已经是 1P 的 B，2P 不能再绑')
  assert.equal(r.p2Keys, 7)
})

check('后台把红白机钉成 nestopia：不补连发、不开连发选项（那颗核心不认 X / Y 连发）', () => {
  const emu = nesEngine()
  const r = repairEjsSeats(emu, 'nes', 'nestopia')
  assert.deepEqual(r.restored, [])
  assert.equal(emu.controls[0][9], undefined)
  assert.deepEqual(r.seatPads, [1, 2, 3], '2P~4P 手柄照补')
  assert.deepEqual(restoredButtonIds('nes', 'nestopia'), [])
  assert.deepEqual(ejsInputDefaultOptions('nes', 'nestopia'), {})
  assert.deepEqual(ejsInputDefaultOptions('nes', 'fceumm'), { fceumm_turbo_enable: 'Both' })
  assert.deepEqual(ejsInputDefaultOptions('snes', 'snes9x'), {})
})

console.log('二、其它平台 / 异常')

check('街机：2P 补手柄 + 小键盘（3 投币 / 1 开始），不补连发', () => {
  const emu = nesEngine()
  const r = repairEjsSeats(emu, 'arcade', 'fbneo')
  assert.deepEqual(r.restored, [])
  assert.equal(emu.controls[1][2].value, 'numpad 3')
  assert.equal(emu.controls[1][3].value, 'numpad 1')
})

check('方案里没有的下标不补 2P 键盘（引擎会删，补了也白补）', () => {
  const emu = nesEngine()
  delete emu.defaultControllers[0][2] // 假设这台机器没有 Select
  repairEjsSeats(emu, 'segaMS', 'genesis_plus_gx')
  assert.equal(emu.controls[1][2]?.value, undefined)
})

check('引擎对象残缺时什么都不做、不抛', () => {
  assert.deepEqual(repairEjsSeats({}, 'nes', 'fceumm'), { restored: [], seatPads: [], p2Keys: 0 })
  assert.deepEqual(repairEjsSeats({ controls: {}, defaultControllers: {} }, 'nes', 'fceumm'), { restored: [], seatPads: [], p2Keys: 0 })
})

check('屏幕手柄：引擎 nes 布局 + TB / TA，输入值是 1 / 9', () => {
  const pad = nesVirtualPad()
  const byId = Object.fromEntries(pad.map((b) => [b.id, b]))
  assert.equal(byId.turbo_a.input_value, 9)
  assert.equal(byId.turbo_b.input_value, 1)
  assert.equal(byId.a.input_value, 8)
  assert.equal(byId.b.input_value, 0)
  assert.deepEqual(byId.dpad.inputValues, [4, 5, 6, 7])
  assert.ok(byId.speed_fast && byId.speed_slow, '自己给布局后引擎不再追加 Fast / Slow，要自己补')
  // 引擎会校验每颗按钮都有 input_value（否则整份布局作废、退回默认）
  for (const b of pad) assert.ok(b.type === 'dpad' || b.input_value !== undefined, b.id)
  // 与引擎自带 nes 布局的几何一致（A / B / Start / Select 的坐标照抄）
  const ejs = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
  assert.match(ejs, /"nes"===this\.getControlScheme\(\)\?\(e=\[\{type:"button",text:"B",id:"b",location:"right",right:75,top:70/)
})

console.log(failed === 0 ? '\nEmulatorJS 座位 / 连发修补回归通过\n' : `\n失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
