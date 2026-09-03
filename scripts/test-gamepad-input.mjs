/**
 * 物理手柄输入的回归测试。
 *
 * 盯的是这个坑：以前把一份**形状不对**的 gamepadConfig 写进 localStorage，指望 jsnes
 * 自带的 GamepadController 认它。jsnes 要的是
 * `{ playerGamepadId: [...], configs: { '<pad.id>': { buttons: [...] } } }`，
 * 写进去的却是 `[{ buttons: { BUTTON_A: 1, ... } }, ...]` —— 于是它 poll() 里
 * `this.gamepadConfig.playerGamepadId[0]` 直接 TypeError，而那个循环是
 * `this.poll(); requestAnimationFrame(loop)`，抛一次就再也不排下一拍：
 * 插上手柄按任何键都没反应，只在控制台留一条报错。
 *
 * 所以这里除了验映射，还专门验一条：**读手柄抛异常不能把轮询循环带走**。
 *
 * 跑：npm run test:gamepad
 */
import assert from 'node:assert/strict'

/* ---- 浏览器环境的最小桩 ---- */
let pads = []
let throwOnce = false
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    getGamepads: () => {
      if (throwOnce) {
        throwOnce = false
        throw new Error('boom')
      }
      return pads
    },
  },
})

/** 手动驱动的 rAF：测试自己决定「下一帧」什么时候到 */
let frame = null
let rafSeq = 0
globalThis.requestAnimationFrame = (cb) => {
  frame = cb
  return ++rafSeq
}
globalThis.cancelAnimationFrame = () => {
  frame = null
}
const tick = () => {
  const cb = frame
  frame = null
  cb?.()
}

const { gamepadPadState, startGamepadInput } = await import('../src/emulator/gamepadInput.ts')

/** 造一个标准布局的手柄：按下的按钮下标 + 摇杆 */
const pad = (pressed = [], axes = [0, 0], connected = true, id = 'test pad') => ({
  id,
  connected,
  mapping: 'standard',
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
})

const state = (...args) => [...gamepadPadState(...args)].sort().join(',')

/* ---------------- 映射 ---------------- */

// 标准布局：下方键 0 = B，右侧键 1 = A，SELECT 8，START 9，十字键 12~15
assert.equal(state([pad([0])]), 'b')
assert.equal(state([pad([1])]), 'a')
assert.equal(state([pad([8, 9])]), 'select,start')
assert.equal(state([pad([12, 15])]), 'right,up')
// 左侧键 2 也是 B、上方键 3 也是 A（两指交替连发）
assert.equal(state([pad([2])]), 'b')
assert.equal(state([pad([3])]), 'a')
// 用不到的按钮（LB/RB/扳机/摇杆键/HOME）不映射成任何东西
assert.equal(state([pad([4, 5, 6, 7, 10, 11, 16])]), '')

// 左摇杆也当方向键，死区 0.5
assert.equal(state([pad([], [-1, 0])]), 'left')
assert.equal(state([pad([], [0, 1])]), 'down')
assert.equal(state([pad([], [0.49, -0.49])]), '', '死区内不算按下')
assert.equal(state([pad([], [0.5, -0.5])]), 'right,up', '正好到死区就算按下')
// 摇杆和十字键同时给出同一个方向，不能变成两次按下（Set 去重）
assert.equal(state([pad([14], [-1, 0])]), 'left')

// 没插手柄 / 已断开 / 空槽位：一律当没有
assert.equal(state([]), '')
assert.equal(state([null, undefined]), '')
assert.equal(state([pad([0], [0, 0], false)]), '', '断开的手柄不算')

// 多个手柄合并成一号手柄（sendButton 没有手柄序号）
assert.equal(state([pad([0]), pad([1])]), 'a,b')

/* ---------------- 轮询：只发变化 ---------------- */

const log = []
pads = []
const input = startGamepadInput((button, down) => log.push(`${down ? '+' : '-'}${button}`))

pads = [pad([1])] // 按住 A
tick()
assert.deepEqual(log, ['+a'])
tick()
tick()
assert.deepEqual(log, ['+a'], '按住不放不该每帧重复喂给核心')

pads = [pad([1, 14])] // A 不放，再按左
tick()
assert.deepEqual(log, ['+a', '+left'])

pads = [pad([14])] // 松开 A
tick()
assert.deepEqual(log, ['+a', '+left', '-a'])

/* ---------------- 读手柄抛异常不能停掉循环 ---------------- */

throwOnce = true
tick()
assert.ok(frame, '抛异常之后必须仍然排了下一拍 —— 这就是 jsnes 那个 bug')
pads = [pad([9])] // START
tick()
// 顺序按 ALL 的次序走（start 在 left 前面），只要求一帧内该发的都发了
assert.deepEqual(log, ['+a', '+left', '-a', '+start', '-left'], '抛异常之后仍然照常工作')

/* ---------------- stop 要把按着的键松开 ---------------- */

input.stop()
assert.deepEqual(log.slice(-1), ['-start'], 'stop 时按着的键必须松开，否则会带进下一局')
assert.equal(frame, null, 'stop 之后不再排帧')
const before = log.length
input.stop()
assert.equal(log.length, before, 'stop 幂等')

/* ---------------- 浏览器不支持 Gamepad API ---------------- */

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
const noop = startGamepadInput(() => assert.fail('不该有回调'))
noop.stop()

console.log('物理手柄输入测试通过')
