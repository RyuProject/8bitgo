/** 自动运行时回退必须同时满足平台策略、ROM 格式与未排除状态。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canAutoFallbackRuntime } from '../src/emulator/runtimeFallback.ts'

const arcade = [
  { id: 'play', extensions: ['zip', 'chd', 'iso'] },
  { id: 'emulatorjs', extensions: ['zip', '7z', 'chd'] },
]
assert.equal(canAutoFallbackRuntime('arcade', 'zip', arcade[0]), false,
  '通用街机失败回退不能绕过逐游戏 Play! 配置')
assert.equal(canAutoFallbackRuntime('arcade', 'zip', arcade[1]), true,
  '当前街机格式被另一候选核心明确支持时允许回退')
assert.equal(canAutoFallbackRuntime('arcade', 'iso', arcade[1]), false,
  '平台相同但候选没有声明支持 ROM 扩展名时不应浪费一次开局')
assert.equal(canAutoFallbackRuntime('ps2', 'iso', { id: 'play', extensions: ['iso'] }), true,
  'PS2 的 Play! 是平台默认引擎，不受街机显式启用规则影响')
assert.equal(canAutoFallbackRuntime('nes', 'nes', { id: 'emulatorjs', extensions: ['nes'] }, ['emulatorjs']), false,
  '已排除的引擎不能被重新选中')
assert.equal(canAutoFallbackRuntime('nes', undefined, { id: 'emulatorjs', extensions: ['nes'] }), false,
  '没有格式信息时不盲目切换引擎')

const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
assert.match(player, /canAutoFallbackRuntime\(session\.platform, extOf\(session\.game\), r, ruledOut\)/,
  '实际回退候选必须经过格式与排除列表判定')
console.log('✔ 自动运行时回退只选支持当前 ROM 格式且未排除的候选')
