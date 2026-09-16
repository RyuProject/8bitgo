#!/usr/bin/env node
/** 后台控制配置的边界测试：坏键位必须在保存时拒绝，不能等玩家开局后静默失效。 */
import assert from 'node:assert/strict'
import { arcadeButtonsOf, flashControlsOf, gameRowToApi } from '../server/src/mappers.js'

const controls = {
  p1: { up: 'ArrowUp', down: 'ArrowDown', a: 'Space' },
  p2: { up: 'KeyW', down: 'KeyS' },
}
assert.deepEqual(JSON.parse(flashControlsOf(controls)), controls)
assert.equal(arcadeButtonsOf(2), 2)
assert.equal(arcadeButtonsOf('4'), 4)
assert.equal(arcadeButtonsOf(6), 6)
assert.throws(() => arcadeButtonsOf(3), /2、4 或 6/)
assert.throws(() => flashControlsOf({ p1: { up: 'Up' } }), /键名无效/)
assert.throws(() => flashControlsOf({ p1: { up: 'ArrowUp', a: 'ArrowUp' } }), /重复使用/)
assert.throws(() => flashControlsOf({ p2: { up: 'KeyW' } }), /至少要给 p1/)

const mapped = gameRowToApi({
  slug: 'control-test', title: 'Control Test', platform: 'flash', players: 1,
  flash_controls: JSON.stringify(controls), arcade_buttons: 4,
})
assert.deepEqual(mapped.flashControls, controls)
assert.equal(mapped.arcadeButtons, 4)

console.log('✅ 游戏控制配置测试通过：Flash JSON / 键名 / 重键 / 街机 2·4·6 键 / 数据库回读')
