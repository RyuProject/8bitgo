#!/usr/bin/env node
/** 运行时回调重复报告相同能力 / 几何 / 双屏布局时必须保持状态值稳定。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  sameLiveControls,
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

/*
  React #185（2026-11-17《森林冰火人 4》、11-20 从 Flash 页切到《超级马里奥》）：
  LiveControls 把开关交给播放器的 effect 依赖了一个每次渲染都新建的 coop 对象，
  同屏双打 Flash + 正在直播时形成「effect → 父组件 setState → 重渲染 → 新对象 → effect」死循环。
*/
const toggle = () => {}
const quality = { value: 'auto' }
const coopFns = { toggle: () => {}, accept: () => {}, dismiss: () => {} }
const ctl = (coop) => ({ phase: 'live', on: true, viewers: 2, label: '2 人', hint: 'h', toggle, quality, coop })
const coopA = { on: false, label: '让人上场', hint: 'x', pending: false, who: undefined, nudge: false, ...coopFns }
assert.equal(sameLiveControls(ctl(coopA), ctl({ ...coopA })), true, '内容相同的新对象必须视为同一份开关')
assert.equal(sameLiveControls(ctl(null), ctl(null)), true)
assert.equal(sameLiveControls(ctl(coopA), ctl({ ...coopA, pending: true })), false)
assert.equal(sameLiveControls(ctl(coopA), ctl(null)), false)
assert.equal(sameLiveControls(ctl(null), { ...ctl(null), viewers: 3 }), false)
assert.equal(sameLiveControls(null, ctl(null)), false)
assert.equal(sameLiveControls(null, null), true)

const liveControls = readFileSync(new URL('../src/emulator/LiveControls.tsx', import.meta.url), 'utf8')
assert.match(liveControls, /const coopCtl = useMemo</, 'coopCtl 进了交开关 effect 的依赖，必须 useMemo，否则直播双打时死循环（#185）')
const controlsEffect = liveControls.match(/onControls\(\s*available[\s\S]*?\}, \[([^\]]+)\]\)/)
assert.ok(controlsEffect, '找不到把开关交给播放器的 effect')
for (const dep of controlsEffect[1].split(',').map((d) => d.trim())) {
  // 每个依赖都必须是原始值或已稳定的引用（useCallback / useMemo / props）
  assert.ok(
    ['onControls', 'available', 'phase', 'viewers', 'btnLabel', 'btnHint', 'stableToggle', 'qualityControl', 'coopCtl'].includes(dep),
    `交开关 effect 多了一个未审查的依赖：${dep}（必须是原始值或稳定引用）`,
  )
}
const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
assert.match(player, /onControls=\{acceptLiveCtl\}/, '播放器必须经 acceptLiveCtl 去重后再存直播开关')
assert.match(player, /sameLiveControls\(current, next\) \? current : next/)

/*
  最终失败后手动重试必须沿用刚才实际跑过的运行时 / 核心，并保留已排除的引擎；
  否则自动兜底走完后，按钮又从默认引擎开局，玩家会重复等待已知失败的路径。
*/
assert.match(player, /failedLaunchRef = useRef<FailedLaunchContext \| null>\(null\)/)
assert.match(player, /rememberFailedLaunch\(session\)/)
assert.match(player, /begin\(failed\.game, failed\.platform, failed\.runtime, \{\s*coreOverride: failed\.coreOverride,\s*ruledOut: failed\.ruledOut,/s)
assert.match(player, /status === 'error' && retryLastFailedLaunch\(\)/)

console.log('✔ 播放器对重复运行时状态报告保持引用稳定，并保留失败后的重试路径')
