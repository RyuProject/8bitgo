/** Ruffle 设备画质分档、启动并行、像素降载和大核心预热回归。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRuffleAdaptiveController,
  installRuffleFrameTelemetry,
  installRufflePixelRatioCap,
  installRufflePixelRatioController,
  RUFFLE_ADAPTIVE_PIXEL_RATIOS,
  RUFFLE_RENDER_PIXEL_RATIO,
  RUFFLE_STALL_CALLBACK_MS,
  selectRufflePerformanceProfile,
  supportsRuffleWasmExtensions,
} from '../src/emulator/rufflePerformance.ts'
import { RUFFLE_MAX_RENDER_AREA, ruffleStageRenderPlan, ruffleStageScale, ruffleStageSize } from '../src/emulator/ruffleStageFit.ts'
import { isRuffleFrameReady, RUFFLE_FRAME_HTML } from '../src/emulator/ruffleFrame.ts'
import { installRuffleCrashGuard, ruffleFatalDetail } from '../src/emulator/ruffleCrash.ts'
import { isSfsGame } from '../shared/sfs-games.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
// 不从 paths.ts 导入：它会读取 Vite 的 import.meta.env，Node 回归环境没有这层对象。
// npm 包版本就是 copy-ruffle/check-ruffle 的真源，拿它拼目录才能防止继续读取残留的旧版本产物。
const { version: RUFFLE_VERSION } = JSON.parse(read('node_modules/@ruffle-rs/ruffle/package.json'))

console.log('── 高分屏清晰度与抗锯齿平衡 ──')
assert.deepEqual(selectRufflePerformanceProfile({ deviceMemory: 8, hardwareConcurrency: 8, devicePixelRatio: 2 }), {
  tier: 'full', maxPixelRatio: 1.25,
})
assert.deepEqual(selectRufflePerformanceProfile({ deviceMemory: 4, hardwareConcurrency: 4, devicePixelRatio: 2 }), {
  tier: 'balanced', maxPixelRatio: 1,
}, '中低配置应降抗锯齿和渲染像素数')
assert.deepEqual(selectRufflePerformanceProfile({ deviceMemory: 2, hardwareConcurrency: 8 }), {
  tier: 'economy', maxPixelRatio: 0.8,
}, '极低内存设备应优先保证可玩性')
assert.deepEqual(selectRufflePerformanceProfile({}), {
  tier: 'balanced', maxPixelRatio: 1,
}, '浏览器隐藏硬件信息时应保守选择均衡档')
assert.deepEqual(selectRufflePerformanceProfile({ deviceMemory: 8, hardwareConcurrency: 8, devicePixelRatio: 3, maxTouchPoints: 5 }), {
  tier: 'balanced', maxPixelRatio: 1,
}, '高 DPR 触屏设备应降低过量像素填充')
const retina = { devicePixelRatio: 2 }
assert.equal(RUFFLE_RENDER_PIXEL_RATIO, 1.25, '画布上限必须给高抗锯齿保留性能余量')
assert.equal(installRufflePixelRatioCap(retina), 1.25)
assert.equal(retina.devicePixelRatio, 1.25, 'Retina iframe 应按 1.25× 画布渲染')
const middle = { devicePixelRatio: 1.2 }
assert.equal(installRufflePixelRatioCap(middle), 1.2, '低于上限的屏幕必须保留原生像素倍率')
const regular = { devicePixelRatio: 1 }
assert.equal(installRufflePixelRatioCap(regular), 1)
const economy = { devicePixelRatio: 2 }
assert.equal(installRufflePixelRatioCap(economy, 1), 1, '低配置档必须将 DPR 限在 1×')
const highDensity = { devicePixelRatio: 3 }
assert.equal(installRufflePixelRatioCap(highDensity), 1.25, '超高分屏也不能绕过像素上限')
const locked = {}
Object.defineProperty(locked, 'devicePixelRatio', { configurable: false, value: 2 })
assert.equal(installRufflePixelRatioCap(locked), 2, '浏览器拒绝覆盖时必须安全退回原值')
const unreadableDpr = Object.create({ get devicePixelRatio() { throw new Error('detached iframe') } })
const unreadableController = installRufflePixelRatioController(unreadableDpr)
assert.equal(unreadableController.supported, true)
assert.equal(unreadableController.current(), 1, '卸载边缘的异常 DPR getter 必须安全回退，不能中断播放器')
const dynamicRetina = { devicePixelRatio: 2 }
const dynamicRatio = installRufflePixelRatioController(dynamicRetina, 1.25)
assert.equal(dynamicRatio.supported, true)
assert.equal(dynamicRatio.current(), 1.25)
assert.equal(dynamicRatio.setCap(0.8), 0.8, '运行中可在不重载游戏的情况下减少画布像素量')
assert.equal(dynamicRatio.setCap(1.25), 1.25, '性能持续充足后可平滑恢复像素密度')

console.log('── Ruffle 帧回调负载采样与滞回调档 ──')
let fakeNow = 0
let queuedFrame = null
let callbackCost = 0
const rafTarget = {
  performance: { now: () => fakeNow },
  requestAnimationFrame(callback) { queuedFrame = callback; return 17 },
}
const rafDescriptor = Object.getOwnPropertyDescriptor(rafTarget, 'requestAnimationFrame')
const frameTelemetry = installRuffleFrameTelemetry(rafTarget)
assert.ok(frameTelemetry, 'Ruffle iframe 应能安装轻量帧采样')
const stableFrameCallback = () => { fakeNow += callbackCost }
assert.equal(rafTarget.requestAnimationFrame(stableFrameCallback), 17, '包装不能改变 RAF 返回的取消句柄')
const firstMeasuredWrapper = queuedFrame
callbackCost = 2
fakeNow = 5
queuedFrame.call(rafTarget, 1000)
rafTarget.requestAnimationFrame(stableFrameCallback)
assert.equal(queuedFrame, firstMeasuredWrapper, '稳定 RAF 回调应复用包装器，减少逐帧闭包分配')
callbackCost = 10
fakeNow = 21
queuedFrame.call(rafTarget, 1016)
callbackCost = 5
fakeNow = 31
rafTarget.requestAnimationFrame(stableFrameCallback)
queuedFrame.call(rafTarget, 1016)
const frameSample = frameTelemetry.sample()
assert.equal(frameSample.frameCount, 1)
assert.equal(frameSample.callbackCount, 3, '同一刷新时刻的多个 RAF 回调都必须计入主线程负载')
assert.equal(frameSample.durationMs, 36)
assert.equal(frameSample.p25IntervalMs, 16)
assert.equal(frameSample.p90IntervalMs, 16)
assert.equal(frameSample.p90CallbackMs, 10, '慢回调也要计入负载，且异常不能改变原行为')
assert.equal(frameSample.lateFrameRatio, 0)
frameTelemetry.discard()
fakeNow = 50
rafTarget.requestAnimationFrame(stableFrameCallback)
queuedFrame.call(rafTarget, 1033)
assert.equal(frameTelemetry.sample().frameCount, 0, '清空预热 / 暂停样本后不得把前一段时间混入下一窗')

let lowRefreshNow = 0
let lowRefreshCallback = null
const lowRefreshTarget = {
  performance: { now: () => lowRefreshNow },
  requestAnimationFrame(callback) { lowRefreshCallback = callback; return 1 },
}
const lowRefreshTelemetry = installRuffleFrameTelemetry(lowRefreshTarget)
const stable30HzCallback = () => { lowRefreshNow += 1 }
for (let index = 0; index < 45; index++) {
  lowRefreshTarget.requestAnimationFrame(stable30HzCallback)
  lowRefreshNow += 1000 / 30
  lowRefreshCallback.call(lowRefreshTarget, index * (1000 / 30))
}
const stable30HzSample = lowRefreshTelemetry.sample()
assert.equal(stable30HzSample.callbackCount, 45)
assert.ok(Math.abs(stable30HzSample.p25IntervalMs - 1000 / 30) < 0.1)
assert.equal(stable30HzSample.lateFrameRatio, 0, '30 Hz 屏幕的正常节奏不能全被标为迟到帧')
lowRefreshTelemetry.stop()

// 像素受限的负载（GPU 填充 / 同步）：回调随画布像素数下降，降档才有意义
let fakePixelRatio = 1.25
let fakeMetric = null
const pixelBoundMetric = () => ({
  frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 16.7,
  p90CallbackMs: 16 * (fakePixelRatio / 1.25) ** 2, lateFrameRatio: 0,
})
const changes = []
const adaptive = createRuffleAdaptiveController({
  telemetry: { sample: () => fakeMetric ?? pixelBoundMetric(), discard() {} },
  pixelRatio: { supported: true, current: () => fakePixelRatio, setCap: (cap) => { fakePixelRatio = Math.min(2, cap); return fakePixelRatio } },
  initialTier: 'full',
  frameRate: 60,
  onChange: (change) => changes.push(change),
})
adaptive.sample()
assert.equal(adaptive.currentTier(), 'full', '單個慢窗口不能引起畫質跳變')
adaptive.sample()
assert.equal(adaptive.currentTier(), 'balanced', '連續兩個過載窗口應即時降一檔')
assert.equal(fakePixelRatio, 1)
for (let i = 0; i < 6; i++) adaptive.sample()
assert.equal(adaptive.currentTier(), 'economy', '降档确实减负、但仍过载时可继续下调，直到硬件安全底檔')
fakeMetric = { frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 16.7, p90CallbackMs: 2, lateFrameRatio: 0 }
for (let i = 0; i < 15; i++) adaptive.sample()
assert.equal(adaptive.currentTier(), 'balanced', '恢復必須等待長時間穩定余量，不能頻繁抖動')
assert.deepEqual(changes.map(({ reason }) => reason), ['slow', 'slow', 'recovered'])

// ⚠️ CPU 瓶颈（《传染恐慌：幸存者》wgpu-webgl 菜单：1.25× 与 0.8× 都是每帧 24ms）：降了没用就退回并锁住
let cpuBoundCap = 1.25
const cpuBoundChanges = []
const cpuBound = createRuffleAdaptiveController({
  telemetry: { sample: () => ({
    frameCount: 120, callbackCount: 120, durationMs: 3000, p25IntervalMs: 25, p90IntervalMs: 26, p90CallbackMs: 24, lateFrameRatio: 0,
  }), discard() {} },
  pixelRatio: { supported: true, current: () => cpuBoundCap, setCap: (cap) => { cpuBoundCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
  onChange: (change) => cpuBoundChanges.push(change),
})
cpuBound.sample()
cpuBound.sample()
assert.equal(cpuBound.currentTier(), 'balanced', '先试着降一档')
cpuBound.sample()
cpuBound.sample()
assert.equal(cpuBound.currentTier(), 'full', '连续两个窗口没有任何改善必须退回原档，不能白白糊掉画面')
assert.equal(cpuBoundCap, RUFFLE_RENDER_PIXEL_RATIO)
for (let i = 0; i < 20; i++) cpuBound.sample()
assert.equal(cpuBound.currentTier(), 'full', '证明过无效的档位本局不再往下降，避免来回跳')
assert.deepEqual(cpuBoundChanges.map(({ reason }) => reason), ['slow', 'reverted'])
cpuBound.stop()

// 加载阶段：过渡帧显慢 → 降档；随后几百毫秒一帧的长任务说明换了阶段，试验作废、退回原档且不锁
const loadingSequence = [
  { frameCount: 42, callbackCount: 42, durationMs: 3000, p25IntervalMs: 25, p90IntervalMs: 60, p90CallbackMs: 28, lateFrameRatio: 0.3 },
  { frameCount: 42, callbackCount: 42, durationMs: 3000, p25IntervalMs: 25, p90IntervalMs: 60, p90CallbackMs: 28, lateFrameRatio: 0.3 },
  { frameCount: 20, callbackCount: 20, durationMs: 3000, p25IntervalMs: 120, p90IntervalMs: 700, p90CallbackMs: 674, lateFrameRatio: 0.5 },
  { frameCount: 360, callbackCount: 360, durationMs: 3000, p25IntervalMs: 8.3, p90IntervalMs: 8.5, p90CallbackMs: 3, lateFrameRatio: 0 },
  { frameCount: 360, callbackCount: 360, durationMs: 3000, p25IntervalMs: 8.3, p90IntervalMs: 8.5, p90CallbackMs: 3, lateFrameRatio: 0 },
  { frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 16.7, p90CallbackMs: 12, lateFrameRatio: 0 },
  { frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 16.7, p90CallbackMs: 12, lateFrameRatio: 0 },
]
let loadingCap = 1.25
const loadingChanges = []
const loading = createRuffleAdaptiveController({
  telemetry: { sample: () => loadingSequence.shift(), discard() {} },
  pixelRatio: { supported: true, current: () => loadingCap, setCap: (cap) => { loadingCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
  onChange: (change) => loadingChanges.push(change),
})
loading.sample()
loading.sample()
assert.equal(loading.currentTier(), 'balanced')
loading.sample()
assert.equal(loading.currentTier(), 'full', '降档试验期间出现加载长任务：前后负载不可比，必须退回原档')
loading.sample()
loading.sample()
assert.equal(loading.currentTier(), 'full', '进游戏后负载很轻，保持最高清晰度')
loading.sample()
loading.sample()
assert.equal(loading.currentTier(), 'balanced', '作废的试验不锁下限：之后真的过载仍可正常降档')
assert.deepEqual(loadingChanges.map(({ reason }) => reason), ['slow', 'reverted', 'slow'])
loading.stop()

let stallCap = 1.25
const stalls = createRuffleAdaptiveController({
  telemetry: { sample: () => ({
    frameCount: 30, callbackCount: 30, durationMs: 3000, p25IntervalMs: 100, p90IntervalMs: 700, p90CallbackMs: 674, lateFrameRatio: 0.6,
  }), discard() {} },
  pixelRatio: { supported: true, current: () => stallCap, setCap: (cap) => { stallCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
})
for (let i = 0; i < 10; i++) stalls.sample()
assert.equal(stalls.currentTier(), 'full', `回调 ≥ ${RUFFLE_STALL_CALLBACK_MS}ms 的加载长任务不是画面负载，不能触发降档`)
stalls.stop()

const smooth30HzChanges = []
let smooth30HzCap = 1
const smooth30Hz = createRuffleAdaptiveController({
  telemetry: { sample: () => ({
    frameCount: 45, callbackCount: 45, durationMs: 3000, p25IntervalMs: 33.3, p90IntervalMs: 33.3, p90CallbackMs: 5, lateFrameRatio: 0,
  }), discard() {} },
  pixelRatio: { supported: true, current: () => smooth30HzCap, setCap: (cap) => { smooth30HzCap = cap; return cap } },
  initialTier: 'balanced',
  frameRate: 30,
  onChange: (change) => smooth30HzChanges.push(change),
})
smooth30Hz.sample()
smooth30Hz.sample()
assert.equal(smooth30Hz.currentTier(), 'balanced', '穩定 30 Hz 遊戲 / 顯示器不可被當成掉幀而降畫質')
assert.deepEqual(smooth30HzChanges, [])
smooth30Hz.stop()

let pausedDiscardCount = 0
let pausedCap = 1.25
const pausedWindow = { frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 16.7, p90CallbackMs: 9, lateFrameRatio: 0 }
const pausedAdaptive = createRuffleAdaptiveController({
  telemetry: { sample: () => pausedWindow, discard: () => { pausedDiscardCount++ } },
  pixelRatio: { supported: true, current: () => pausedCap, setCap: (cap) => { pausedCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
})
pausedAdaptive.sample()
pausedAdaptive.discard()
pausedAdaptive.sample()
assert.equal(pausedAdaptive.currentTier(), 'full', '暂停期间必须清除已有的慢窗连续计数')
pausedAdaptive.sample()
assert.equal(pausedAdaptive.currentTier(), 'balanced', '恢复后需要重新连续确认负载过高')
assert.equal(pausedDiscardCount, 1)
pausedAdaptive.stop()

const slowMetrics = { frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 16.7, p90CallbackMs: 9, lateFrameRatio: 0 }
const invalidMetrics = { frameCount: 11, callbackCount: 11, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 40, p90CallbackMs: 15, lateFrameRatio: 0.3 }
const metricSequence = [slowMetrics, invalidMetrics, slowMetrics, slowMetrics]
let sequenceCap = 1.25
const sequenceAdaptive = createRuffleAdaptiveController({
  telemetry: { sample: () => metricSequence.shift(), discard() {} },
  pixelRatio: { supported: true, current: () => sequenceCap, setCap: (cap) => { sequenceCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
})
sequenceAdaptive.sample()
sequenceAdaptive.sample()
sequenceAdaptive.sample()
assert.equal(sequenceAdaptive.currentTier(), 'full', '无效 / 样本不足的窗口会打断慢窗连续性')
sequenceAdaptive.sample()
assert.equal(sequenceAdaptive.currentTier(), 'balanced')
sequenceAdaptive.stop()

let insufficientSamplesCap = 1.25
const insufficientSamples = createRuffleAdaptiveController({
  telemetry: { sample: () => ({
    frameCount: 11, callbackCount: 11, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 40, p90CallbackMs: 15, lateFrameRatio: 0.3,
  }), discard() {} },
  pixelRatio: { supported: true, current: () => insufficientSamplesCap, setCap: (cap) => { insufficientSamplesCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
})
for (let index = 0; index < 3; index++) insufficientSamples.sample()
assert.equal(insufficientSamples.currentTier(), 'full', '少量抖动样本不能触发降档')
insufficientSamples.stop()

let pacingCap = 1.25
const pacingChanges = []
const pacingPressure = createRuffleAdaptiveController({
  telemetry: { sample: () => ({
    frameCount: 60, callbackCount: 60, durationMs: 3000, p25IntervalMs: 16.7, p90IntervalMs: 33.4, p90CallbackMs: 2, lateFrameRatio: 0,
  }), discard() {} },
  pixelRatio: { supported: true, current: () => pacingCap, setCap: (cap) => { pacingCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 60,
  onChange: (change) => pacingChanges.push(change),
})
pacingPressure.sample()
pacingPressure.sample()
assert.equal(pacingPressure.currentTier(), 'balanced', '回調短但幀節奏明顯丟拍時也要能降載')
assert.deepEqual(pacingChanges.map(({ reason }) => reason), ['slow'])
pacingPressure.stop()

let lowRateCap = 1.25
const lowRateAdaptive = createRuffleAdaptiveController({
  telemetry: { sample: () => ({
    frameCount: 15, callbackCount: 15, durationMs: 3000, p25IntervalMs: 200, p90IntervalMs: 200, p90CallbackMs: 100, lateFrameRatio: 0,
  }), discard() {} },
  pixelRatio: { supported: true, current: () => lowRateCap, setCap: (cap) => { lowRateCap = cap; return cap } },
  initialTier: 'full',
  frameRate: 5,
})
lowRateAdaptive.sample()
lowRateAdaptive.sample()
assert.equal(lowRateAdaptive.currentTier(), 'balanced', '5 FPS 的低帧率 SWF 也必须进入采样判定')
lowRateAdaptive.stop()
adaptive.stop()
frameTelemetry.stop()
assert.equal(Object.getOwnPropertyDescriptor(rafTarget, 'requestAnimationFrame').value, rafDescriptor.value,
  '銷毀必須還原 iframe 的 RAF 方法')
assert.equal(RUFFLE_ADAPTIVE_PIXEL_RATIOS[0], 0.8)

console.log('── 原始舞台等比居中 ──')
assert.deepEqual(ruffleStageSize({ width: 800, height: 600 }), { width: 800, height: 600 })
assert.deepEqual(ruffleStageSize({ width: 799.6, height: 599.6 }), { width: 800, height: 600 })
for (const bad of [null, {}, { width: '800', height: 600 }, { width: 0, height: 600 }, { width: Infinity, height: 600 }, { width: 20000, height: 600 }]) {
  assert.equal(ruffleStageSize(bad), null, `损坏的舞台尺寸不应进入样式：${JSON.stringify(bad)}`)
}
assert.equal(ruffleStageScale(1920, 1080, { width: 800, height: 600 }), 1.8)
assert.equal(ruffleStageScale(600, 900, { width: 800, height: 600 }), 0.75)
assert.equal(ruffleStageScale(0, 900, { width: 800, height: 600 }), null)

// 按显示尺寸渲染：1080p 里的 550×400 游戏必须按 1485×1080 画，不能按原始像素画完再被 CSS 放大 2.7 倍
assert.deepEqual(ruffleStageRenderPlan(1920, 1080, { width: 550, height: 400 }), { width: 1485, height: 1080, cssScale: 1 })
assert.deepEqual(ruffleStageRenderPlan(600, 900, { width: 800, height: 600 }), { width: 600, height: 450, cssScale: 1 }, '小屏按显示尺寸画，省 GPU')
const huge = ruffleStageRenderPlan(3840, 2160, { width: 800, height: 600 })
assert.ok(huge.width * huge.height <= RUFFLE_MAX_RENDER_AREA, '4K 全屏要给渲染面积封顶')
assert.ok(Math.abs(huge.width * huge.cssScale - 2880) < 2 && Math.abs(huge.height * huge.cssScale - 2160) < 2, '封顶后显示区域仍贴合容器')
assert.equal(ruffleStageRenderPlan(0, 0, { width: 800, height: 600 }), null)

console.log('── WASM 变体选择 ──')
let probes = 0
assert.equal(supportsRuffleWasmExtensions(() => { probes++; return true }), true)
assert.equal(probes, 5, '必须和当前 Ruffle 的五项能力探针一致')
assert.equal(supportsRuffleWasmExtensions(() => false), false)
assert.equal(supportsRuffleWasmExtensions(() => { throw new Error('blocked') }), false)

console.log('── Ruffle 致命异常接管 ──')
assert.equal(ruffleFatalDetail({ name: 'AbortError', message: 'The operation was aborted' }), null)
assert.equal(ruffleFatalDetail(new Error('普通 ActionScript 异常')), null)
assert.equal(ruffleFatalDetail({ name: 'RuntimeError', message: 'unreachable' }), 'unreachable')
assert.equal(ruffleFatalDetail('Ruffle has panicked! panicked at renderer.rs:42'), 'Ruffle has panicked! panicked at renderer.rs:42')
const crashListeners = new Map()
const nativeConsoleError = () => {}
const crashWin = {
  console: { error: nativeConsoleError },
  addEventListener(type, listener) { crashListeners.set(type, listener) },
  removeEventListener(type, listener) { if (crashListeners.get(type) === listener) crashListeners.delete(type) },
}
const crashReports = []
const cancelCrashGuard = installRuffleCrashGuard(crashWin, (detail) => crashReports.push(detail))
crashListeners.get('unhandledrejection')({ reason: { name: 'RuntimeError', message: 'memory access out of bounds' } })
crashWin.console.error('Ruffle has panicked! should be deduplicated')
assert.deepEqual(crashReports, ['memory access out of bounds'], '同一局只能上报第一次致命异常')
cancelCrashGuard()
assert.equal(crashListeners.size, 0, '销毁后必须摘掉全局异常监听')
assert.equal(crashWin.console.error, nativeConsoleError, '销毁后必须还原 iframe 的 console.error')
const frozenListeners = new Map()
const frozenReports = []
const frozenConsoleWin = {
  console: Object.freeze({ error: nativeConsoleError }),
  addEventListener(type, listener) { frozenListeners.set(type, listener) },
  removeEventListener(type, listener) { if (frozenListeners.get(type) === listener) frozenListeners.delete(type) },
}
const cancelFrozenGuard = installRuffleCrashGuard(frozenConsoleWin, (detail) => frozenReports.push(detail))
frozenListeners.get('error')({ error: { name: 'RuntimeError', message: 'unreachable' } })
assert.deepEqual(frozenReports, ['unreachable'], 'console 只读时仍要靠 error 事件接住 WASM 崩溃')
assert.doesNotThrow(cancelFrozenGuard, '加固 WebView 的只读 console 不能阻断会话销毁')

console.log('── 启动链与按实测负载自适应渲染 ──')
const adapter = read('src/emulator/adapters/ruffle.ts')
const player = read('src/emulator/EmulatorPlayer.tsx')
const frame = read('public/flash-frame.html')
const types = read('src/emulator/types.ts')
const vite = read('vite.config.ts')
const serverCache = read('server/src/cache.js')
assert.match(adapter, /selectRufflePerformanceProfile\(\{/, '每局必须在 Ruffle iframe 内按设备能力选档')
assert.match(adapter, /installRufflePixelRatioController\(win, performanceProfile\.maxPixelRatio\)/, 'DPR 上限必须与能力档位同步')
assert.match(adapter, /installRuffleFrameTelemetry\(win\)/, '实测必须只采样 Ruffle iframe 的动画回调')
assert.match(adapter, /createRuffleAdaptiveController\(/, '实际负载必须驱动画布像素比的运行中切档')
assert.match(adapter, /performanceTelemetry\.discard\(\)[\s\S]*?createRuffleAdaptiveController\(/,
  '启动和解码负载不得污染首个稳定游玩采样窗')
assert.match(adapter, /adaptivePerformanceTimer = window\.setInterval/, '采样定时器必须使用销毁时对应的全局')
assert.match(adapter, /api\?\.suspended === true/, '新版 Ruffle PlayerV1 暂停时必须丢弃样本')
assert.match(adapter, /adaptivePerformance\.discard\(\)/, '暂停要重置迟滞状态，避免跨暂停累计连续窗口')
assert.doesNotMatch(adapter, /quality:\s*performanceProfile/, 'Ruffle Stage.quality 在核心中没有画质效果，不应误导为性能开关')
assert.doesNotMatch(adapter, /frameRate:\s*(?:performanceProfile|options\.|\d)/, '性能策略不能覆写游戏时间轴')
// 不能为全站钉死后端；唯一例外是 Stage3D 内容（webgl / canvas 没有 Context3D，WebGPU 比 wgpu-webgl 快一个数量级），
// 而且只能来自 flashStage3D.ts 的检测结果，见 scripts/test-flash-stage3d.mjs
assert.doesNotMatch(adapter, /preferredRenderer\s*:\s*['"`]/, '性能策略不能钉死浏览器渲染后端')
assert.equal((adapter.match(/preferredRenderer\s*:/g) || []).length, 1, 'preferredRenderer 只能有 Stage3D 那一处')
assert.match(adapter, /preferredRenderer: renderer\.preferredRenderer/)
assert.doesNotMatch(adapter, /options\.performanceProfile/)
assert.doesNotMatch(player, /performance(Label|Profile|Quality|Balanced|Fast)/, '开始区不应再出现运行档位')
assert.doesNotMatch(types, /performanceProfile/)
const bytesAt = adapter.indexOf('const gameBytes = loadGameBytes')
const scriptAt = adapter.indexOf("script.src = `${ruffleRoot}ruffle.js`")
const awaitAt = adapter.indexOf('Promise.all([gameBytes, flashOnlineSave, sfsRuffleConfig])')
assert.ok(bytesAt > 0 && bytesAt < scriptAt && scriptAt < awaitAt, 'SWF、桥配置和 Ruffle 必须并行启动')
assert.match(adapter, /prepareSfsRuffleConfig\(options\.gameSlug\)/)
assert.match(adapter, /waitForRuffleMetadata\(player, aborter\.signal\)/)
assert.match(adapter, /Promise\.resolve\(\)\.then\(\(\) => api!\.load\(loadOptions\)\)/,
  'load 与元数据等待必须由同一个 Promise.all 接管，避免销毁时出现未处理 rejection')
assert.match(adapter, /scheduleCanvasCapabilities\(\)/, '舞台画布晚创建时必须补报截图 / 录屏能力')
assert.match(adapter, /audioContext\.close\(\)\.catch/, '销毁时要兜底关闭残留音频线程')
assert.match(adapter, /player\.metadata/, '元数据就绪后必须读取 SWF 原始舞台尺寸')
assert.match(adapter, /nativeVideoSize\(\)\s*\{\s*return ruffleStageSize\(player\?\.metadata\)/, 'Ruffle 必须把 SWF 逻辑舞台尺寸提供给直播编码')
assert.match(adapter, /preserveVideoResolution:\s*true/, '矢量舞台弱网时应优先减帧而不是额外缩分辨率')
assert.match(adapter, /options\.onGeometry\?\.\(stageSize\)/, '播放器几何与推流尺寸都应使用已校验的舞台元数据')
assert.match(adapter, /new win\.ResizeObserver\(update\)/, '播放器容器变化时必须重新计算缩放')
assert.match(adapter, /options\.flashControls\?\.displayMode !== 'ruffle'/, '必须保留逐游戏兼容退回开关')
assert.match(adapter, /cancelStageFit\(\)/, '销毁会话时必须断开舞台尺寸监听')
assert.match(adapter, /ruffleStageRenderPlan\(host\.clientWidth, host\.clientHeight, size\)/, '舞台元素必须按显示尺寸布局')
assert.doesNotMatch(adapter, /stage\.style\.width = `\$\{size\.width\}px`/, '不能再把元素钉在原始像素尺寸再用 transform 放大（Ruffle 画布不随 transform 变，会糊）')
assert.match(adapter, /fitStage \? \{ scale: 'showAll', forceScale: true \}/, '等比模式必须禁止 SWF 切到 noScale，否则固定布局游戏只画左上角')
assert.match(frame, /id="stage"/, '独立舞台层不能被删掉，否则 CSS 缩放会直接改写 Ruffle 视口')

console.log('── iframe 初始空文档竞态 ──')
const frameDoc = (marker, ids = []) => ({
  documentElement: { getAttribute: (name) => name === 'data-8bitgo-ruffle-frame' ? marker : null },
  getElementById: (id) => ids.includes(id) ? {} : null,
})
assert.equal(isRuffleFrameReady(frameDoc(null, [])), false, '初始 about:blank 不能被当成播放壳')
assert.equal(isRuffleFrameReady(frameDoc('1', ['host'])), false, '不完整的壳不能启动 Ruffle')
assert.equal(isRuffleFrameReady(frameDoc('1', ['host', 'stage'])), true)
assert.match(frame, /data-8bitgo-ruffle-frame="1"/, '静态壳必须保留专用就绪标记')
assert.match(adapter, /if \(!win \|\| !doc \|\| !isRuffleFrameReady\(doc\)\) return/,
  'load 事件必须忽略 iframe 的初始 about:blank 文档')
assert.match(adapter, /frameInitTimer = window\.setTimeout[\s\S]*10_000/,
  '忽略假 load 后仍需有初始化超时，避免错误响应让界面永久等待')
assert.match(adapter, /container\.appendChild\(iframe\)\s*\/\*[\s\S]*?\*\/\s*queueMicrotask\(/,
  'iframe 必须先挂载再导航，避免 detached iframe 的真实 src 请求被初始空文档吞掉')
assert.match(adapter, /queueMicrotask\(\(\) => \{\s*if \(destroyed \|\| frameInitialized\) return\s*if \(writeInlineRuffleFrame\(iframe\)\) initFrame\(\)\s*else iframe\.src = '\/flash-frame\.html'/,
  '播放壳优先就地写出，免掉一次只能走主站的网络往返；写不出才导航到静态壳')
assert.equal(RUFFLE_FRAME_HTML, frame, '就地写出的壳必须和 public/flash-frame.html 逐字一致')
// 2026-11-07《以撒的结合》：慢网下 10 秒一到就 abort 已下一半的 SWF，玩家只看到「无法初始化 Flash 播放器容器」
assert.match(adapter, /const onFrameInitTimeout = \(\) => \{[\s\S]*?if \(isRuffleFrameReady\(iframe\.contentDocument\)\) \{\s*initFrame\(\)/,
  '超时先要直接检查壳是否其实已经到了（load 事件可能比定时器晚一步）')
assert.match(adapter, /if \(!frameNavigationRetried\) \{[\s\S]*?iframe\.src = '\/flash-frame\.html'[\s\S]*?20_000/,
  '壳第一次超时要重新导航并再等一轮，不能直接判死刑')
assert.ok(adapter.indexOf('aborter.abort()', adapter.indexOf('const onFrameInitTimeout')) > adapter.indexOf('if (!frameNavigationRetried)'),
  '重试之前不能 abort 已经在下载的 SWF')
assert.match(adapter, /options\.onError\?\.\(rt\.flashInitFailed, 'runtime'\)/,
  '播放壳初始化失败必须标成运行时故障，不能误判成某一种语言 ROM 损坏')
assert.match(adapter, /installRuffleCrashGuard\(win,/,
  'Ruffle 必须在 iframe 内接管 WASM RuntimeError / Rust panic，不能继续显示运行中黑屏')
assert.match(adapter, /cancelCrashGuard\(\)/, '换游戏时必须清掉旧 Ruffle 会话的致命异常监听')
assert.match(vite, /flashFrame[\s\S]*?Cross-Origin-Embedder-Policy', 'require-corp'[\s\S]*?Cross-Origin-Resource-Policy', 'same-origin'/,
  '开发服务器必须让跨源隔离的 play-local 可以内嵌 Flash 播放壳')
assert.match(serverCache, /flash-frame\.html'[\s\S]*?Cross-Origin-Embedder-Policy', 'require-corp'[\s\S]*?Cross-Origin-Resource-Policy', 'same-origin'/,
  '生产静态服务不能把 Flash 播放壳拦成 chrome-error 黑屏')
assert.match(player, /errorScope !== 'runtime'[\s\S]*onRomLoadFailed\?\.\(message\)/,
  '运行时故障不得触发 ROM 语言/备用地址切换')

console.log('── 大核心预热与旁路门控 ──')
const manifest = JSON.parse(read(`public/ruffle/v${RUFFLE_VERSION}/runtime.json`))
const bootstrap = JSON.parse(read(`public/ruffle/v${RUFFLE_VERSION}/bootstrap.json`))
assert.equal(manifest.version, RUFFLE_VERSION, '性能回归必须读取当前 Ruffle 版本，不能拿旧目录假绿')
assert.equal(bootstrap.version, RUFFLE_VERSION, '预热清单必须和当前 Ruffle 版本一致')
const files = new Set(manifest.files.map((file) => file.name))
for (const variant of ['modern', 'fallback']) {
  assert.equal(bootstrap.bootstrap?.[variant]?.length, 2)
  for (const target of bootstrap.bootstrap[variant]) assert.ok(files.has(target), `${variant} 指向未发布文件`)
}
const prewarm = read('src/emulator/prewarm.ts')
assert.match(prewarm, /saveData/)
assert.match(prewarm, /supportsRuffleWasmExtensions/)
assert.match(prewarm, /bootstrap\.json/)
assert.equal(isSfsGame('sas3'), true)
assert.equal(isSfsGame('infectonator-2'), false)

console.log('✅ Ruffle 等比舞台、实测负载自适应像素比、运行稳定性、启动并行、核心预热与 SFS 门控通过')
