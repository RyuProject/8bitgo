#!/usr/bin/env node
/** 运行时回调重复报告相同能力 / 几何 / 双屏布局时必须保持状态值稳定。 */
import assert from 'node:assert/strict'
import {
  sameRuntimeCaps,
  sameRuntimeGeometry,
  sameRuntimeResolution,
  sameRuntimeScreenLayout,
} from '../src/emulator/playerRuntimeState.ts'

assert.equal(sameRuntimeCaps(new Set(['pause', 'saveState']), new Set(['saveState', 'pause'])), true)
assert.equal(sameRuntimeCaps(new Set(['pause']), new Set(['pause', 'volume'])), false)

assert.equal(sameRuntimeGeometry({ width: 256, height: 240 }, { width: 256, height: 240 }), true)
assert.equal(sameRuntimeGeometry({ width: 256, height: 240 }, { width: 240, height: 256 }), false)
assert.equal(sameRuntimeGeometry(null, null), true)

assert.equal(
  sameRuntimeResolution({ coreOverride: 'fbneo-wofcn', saveSlug: 'wofcn:fbneo-wofcn' }, 'fbneo-wofcn', 'wofcn:fbneo-wofcn'),
  true,
  '重复核心解析必须返回相同状态，不触发新的 React 更新',
)
assert.equal(
  sameRuntimeResolution({ coreOverride: 'fbneo', saveSlug: 'wofcn' }, 'fbneo-wofcn', 'wofcn:fbneo-wofcn'),
  false,
  '核心或存档隔离档位改变时仍需更新会话',
)

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
