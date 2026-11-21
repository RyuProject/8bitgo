#!/usr/bin/env node
/** 运行时回调重复报告相同能力 / 几何 / 双屏布局时必须保持状态值稳定。 */
import assert from 'node:assert/strict'
import {
  sameRuntimeCaps,
  sameRuntimeGeometry,
  sameRuntimeScreenLayout,
} from '../src/emulator/playerRuntimeState.ts'

assert.equal(sameRuntimeCaps(new Set(['pause', 'saveState']), new Set(['saveState', 'pause'])), true)
assert.equal(sameRuntimeCaps(new Set(['pause']), new Set(['pause', 'volume'])), false)

assert.equal(sameRuntimeGeometry({ width: 256, height: 240 }, { width: 256, height: 240 }), true)
assert.equal(sameRuntimeGeometry({ width: 256, height: 240 }, { width: 240, height: 256 }), false)
assert.equal(sameRuntimeGeometry(null, null), true)

assert.equal(
  sameRuntimeScreenLayout(
    { key: 'melonds_screen_layout1', current: 'top-bottom', values: ['top-bottom', 'left-right'] },
    { key: 'melonds_screen_layout1', current: 'top-bottom', values: ['top-bottom', 'left-right'] },
  ),
  true,
)
assert.equal(
  sameRuntimeScreenLayout(
    { key: 'melonds_screen_layout1', current: 'top-bottom', values: ['top-bottom', 'left-right'] },
    { key: 'melonds_screen_layout1', current: 'left-right', values: ['top-bottom', 'left-right'] },
  ),
  false,
)

console.log('✔ 播放器对重复运行时状态报告保持引用稳定')
