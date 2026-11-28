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
import {
  canTryManualCoreRecovery,
  coreResolvedForSession,
  manualCoreOptionsForFailure,
  manualFallbackAllowedForSession,
  nextManualCoreOption,
} from '../src/emulator/manualCoreRecovery.ts'

assert.equal(sameRuntimeCaps(new Set(['pause', 'saveState']), new Set(['saveState', 'pause'])), true)
assert.equal(sameRuntimeCaps(new Set(['pause']), new Set(['pause', 'volume'])), false)

assert.equal(
  nextManualCoreOption(
    [{ id: 'melondsds' }, { id: 'desmume' }, { id: 'desmume2015' }],
    ['melondsds', 'melonds-compat'],
  ),
  'desmume',
  '手动换核心跳过本次已崩溃的新旧 melonDS',
)
assert.equal(
  nextManualCoreOption([{ id: 'psx' }, { id: 'mednafen_psx' }], ['pcsx_rearmed'], (id) => id === 'psx' ? 'pcsx_rearmed' : id),
  'mednafen_psx',
  '核心别名归一后不能重复建议同一个核心',
)
assert.equal(nextManualCoreOption([{ id: 'fbneo' }], ['fbneo']), null, '核心选项都试过后应隐藏手动切换入口')
assert.equal(canTryManualCoreRecovery('emulatorjs', 'arcade', 'deterministic', undefined), true,
  '街机未知驱动不应触发无意义自动重试，但仍可能由另一种街机核心收录')
assert.equal(canTryManualCoreRecovery('emulatorjs', 'arcade', 'deterministic', false), false,
  'CRC 已确认是 MAME 专属的街机不能推荐必然不兼容的换核')
assert.equal(canTryManualCoreRecovery('emulatorjs', 'flash', 'deterministic', undefined), false,
  '其它确定性内容错误不能误开放核心恢复')
assert.equal(canTryManualCoreRecovery('emulatorjs', 'arcade', 'network', undefined), false,
  '网络故障应走网络恢复，不能引导玩家换核心')
assert.deepEqual(
  manualCoreOptionsForFailure(
    [{ id: 'fbneo' }, { id: 'fbneo-lowmem' }, { id: 'mame2003_plus' }],
    'arcade', 'deterministic', ['fbneo'],
  ),
  [{ id: 'mame2003_plus' }],
  'FBNeo 未知驱动时不再推荐同驱动表的低内存版或重复试普通版',
)
assert.deepEqual(
  manualCoreOptionsForFailure(
    [{ id: 'fbneo' }, { id: 'fbneo-lowmem' }, { id: 'mame2003_plus' }],
    'arcade', 'deterministic', ['mame-current'],
  ),
  [{ id: 'fbneo' }, { id: 'mame2003_plus' }],
  '其它街机核心报未知驱动时，FBNeo 仍可作为不同覆盖面的手动回退',
)
assert.deepEqual(
  manualCoreOptionsForFailure(
    [{ id: 'fbneo' }, { id: 'fbneo-lowmem' }],
    'arcade', 'core', ['fbneo'],
  ),
  [{ id: 'fbneo' }, { id: 'fbneo-lowmem' }],
  '内存类核心错误仍可使用低内存 FBNeo 变体',
)
assert.equal(coreResolvedForSession({ sessionId: 7, core: 'mame-current' }, 7, 'fbneo'), 'mame-current', '失败恢复沿用本局实际运行核心')
assert.equal(coreResolvedForSession({ sessionId: 6, core: 'mame-current' }, 7, 'fbneo'), 'fbneo', '迟到的旧会话回调不能污染新局')
assert.equal(coreResolvedForSession(null, 7, undefined), undefined)
assert.equal(manualFallbackAllowedForSession({ sessionId: 7, manualFallbackAllowed: false }, 7, true), false)
assert.equal(manualFallbackAllowedForSession({ sessionId: 6, manualFallbackAllowed: false }, 7, undefined), true)
assert.equal(manualFallbackAllowedForSession(null, 7, false), false)

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
const emulatorjsAdapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
assert.match(player, /onControls=\{acceptLiveCtl\}/, '播放器必须经 acceptLiveCtl 去重后再存直播开关')
assert.match(player, /sameLiveControls\(current, next\) \? current : next/)

/*
  最终失败后手动重试必须沿用刚才实际跑过的运行时 / 核心，并保留已排除的引擎；
  否则自动兜底走完后，按钮又从默认引擎开局，玩家会重复等待已知失败的路径。
*/
assert.match(player, /failedLaunchRef = useRef<FailedLaunchContext \| null>\(null\)/)
assert.match(player, /rememberFailedLaunch\(session\)/)
assert.match(player, /begin\(failed\.game, failed\.platform, failed\.runtime, \{\s*coreOverride: failed\.coreOverride,\s*coreOverridePinned: failed\.coreOverridePinned,\s*ruledOut: failed\.ruledOut,/s)
assert.match(player, /status === 'error' && retryLastFailedLaunch\(\)/)
assert.match(player, /nextManualCoreOption\(\s*options,\s*failed\.manualTriedCores/s)
assert.match(player, /resolvedCoreRef\.current = \{[\s\S]{0,180}core: resolvedCore/)
assert.match(player, /coreResolvedForSession\(coreReport, failed\.id, failed\.coreOverride\)/)
assert.match(player, /const coreOverridePinned = requestedCoreOverride !== undefined\s*\? extra\?\.coreOverridePinned \?\? true\s*:\s*Boolean\(coreOverride\)/,
  '默认解析核心保持可回退，自动选出的记忆核心则固定到本局')
assert.match(player, /const requestedCoreOverride = extra\?\.coreOverridePinned === false \? undefined : extra\?\.coreOverride/,
  '未固定的已解析核心不能压过设备记忆中的兼容 / 低内存核心')
assert.match(player, /coreOverridePinned: session\.coreOverridePinned/,
  '会话重开和自动重试必须保留核心固定状态，默认核心仍可触发低内存 / 兼容回退')
assert.match(player, /coreOverridePinned: true,[\s\S]{0,100}manualTriedCores: \[\.\.\.manualTriedCores\]/,
  '玩家手动换核后新会话必须固定所选核心')
assert.match(player, /const restartable = canRestartInPlace\(session\) && !session\.coreOverridePinned/)
assert.match(player, /ndsCrashFallbackCore\(crashedCore, canRestartInPlace\(session\), Boolean\(session\.coreOverridePinned\)\)/)
assert.match(player, /failed\.runtime\.id === 'emulatorjs' \? currentCore/)
assert.match(player, /failed\.platform === 'arcade' && arcadeRomDataRef\.current/, 'FBNeo 专属 RomData 游戏不能露出 MAME 等不兼容核心')
assert.match(player, /canTryManualCoreRecovery\(\s*failed\.runtime\.id,\s*failed\.platform,\s*failed\.recoveryCause,\s*failed\.manualCoreFallbackAllowed/s)
assert.match(player, /manualCoreOptionsForFailure\(/,
  '街机未知驱动错误必须过滤无兼容性收益的同家族低内存变体')
const beginAt = player.indexOf('const begin = (')
const beginSessionAt = player.indexOf('setSession({ id: sessionId', beginAt)
const beginImmersiveAt = player.indexOf('enterAutoImmersive()', beginAt)
assert.ok(beginAt >= 0 && beginImmersiveAt > beginAt && beginImmersiveAt < beginSessionAt,
  '手机沉浸布局必须在开局挂载前切换，不能等慢核心变成 running 后再造成大幅布局位移')
assert.match(player, /const enterAutoImmersive = useCallback\(\(\) => \{\s*if \(!shellAvailable \|\| !isCompactViewport\(\) \|\| immersiveRef\.current\) return/s,
  '自动切沉浸仅限播放器 shell 的紧凑视口，并保留玩家手动打开的状态')
assert.match(player, /autoImmersiveRef\.current &&\s*\(status === 'error' \|\| status === 'idle'\)/s,
  '自动切入后遇到失败或停止时要收回本次自动布局')
assert.match(emulatorjsAdapter, /arcadeFatal === 'unknown-set'[\s\S]{0,120}'deterministic'/,
  '街机未知驱动需跳过同核心自动重试，同时留下手动换核恢复机会')
assert.match(player, /manualCoreRetryAvailable && \([\s\S]*?t\.player\.tryAnotherCore/)
assert.match(player, /!online && romChecking && status === 'idle' && \([\s\S]{0,800}inputRef\.current\?\.click\(\)[\s\S]{0,500}t\.player\.pickRom/s,
  '云端预检期间要开放本地 ROM 入口；它不能等待云端探测结束或触发远端核心预热')

console.log('✔ 播放器对重复运行时状态报告保持引用稳定，并提供不重复的手动核心恢复路径')
