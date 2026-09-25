/** Ruffle 固定均衡档、启动并行、像素降载和大核心预热回归。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installRufflePixelRatioCap,
  RUFFLE_FIXED_QUALITY,
  RUFFLE_RENDER_PIXEL_RATIO,
  supportsRuffleWasmExtensions,
} from '../src/emulator/rufflePerformance.ts'
import { ruffleStageScale, ruffleStageSize } from '../src/emulator/ruffleStageFit.ts'
import { isSfsGame } from '../shared/sfs-games.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

console.log('── 高分屏清晰度与抗锯齿平衡 ──')
const retina = { devicePixelRatio: 2 }
assert.equal(RUFFLE_RENDER_PIXEL_RATIO, 1.25, '画布上限必须给高抗锯齿保留性能余量')
assert.equal(installRufflePixelRatioCap(retina), 1.25)
assert.equal(retina.devicePixelRatio, 1.25, 'Retina iframe 应按 1.25× 画布渲染')
const middle = { devicePixelRatio: 1.2 }
assert.equal(installRufflePixelRatioCap(middle), 1.2, '低于上限的屏幕必须保留原生像素倍率')
const regular = { devicePixelRatio: 1 }
assert.equal(installRufflePixelRatioCap(regular), 1)
const highDensity = { devicePixelRatio: 3 }
assert.equal(installRufflePixelRatioCap(highDensity), 1.25, '超高分屏也不能绕过像素上限')
const locked = {}
Object.defineProperty(locked, 'devicePixelRatio', { configurable: false, value: 2 })
assert.equal(installRufflePixelRatioCap(locked), 2, '浏览器拒绝覆盖时必须安全退回原值')

console.log('── 原始舞台等比居中 ──')
assert.deepEqual(ruffleStageSize({ width: 800, height: 600 }), { width: 800, height: 600 })
assert.deepEqual(ruffleStageSize({ width: 799.6, height: 599.6 }), { width: 800, height: 600 })
for (const bad of [null, {}, { width: '800', height: 600 }, { width: 0, height: 600 }, { width: Infinity, height: 600 }, { width: 20000, height: 600 }]) {
  assert.equal(ruffleStageSize(bad), null, `损坏的舞台尺寸不应进入样式：${JSON.stringify(bad)}`)
}
assert.equal(ruffleStageScale(1920, 1080, { width: 800, height: 600 }), 1.8)
assert.equal(ruffleStageScale(600, 900, { width: 800, height: 600 }), 0.75)
assert.equal(ruffleStageScale(0, 900, { width: 800, height: 600 }), null)

console.log('── WASM 变体选择 ──')
let probes = 0
assert.equal(supportsRuffleWasmExtensions(() => { probes++; return true }), true)
assert.equal(probes, 5, '必须和 Ruffle 0.6 的五项能力探针一致')
assert.equal(supportsRuffleWasmExtensions(() => false), false)
assert.equal(supportsRuffleWasmExtensions(() => { throw new Error('blocked') }), false)

console.log('── 启动链与固定高抗锯齿档 ──')
const adapter = read('src/emulator/adapters/ruffle.ts')
const frame = read('public/flash-frame.html')
const player = read('src/emulator/EmulatorPlayer.tsx')
const types = read('src/emulator/types.ts')
assert.equal(RUFFLE_FIXED_QUALITY, 'high', 'Ruffle 默认画质必须固定为高抗锯齿档')
assert.match(adapter, /quality:\s*RUFFLE_FIXED_QUALITY/, '适配器必须使用唯一的固定画质常量')
assert.doesNotMatch(adapter, /options\.performanceProfile/)
assert.doesNotMatch(player, /performance(Label|Profile|Quality|Balanced|Fast)/, '开始区不应再出现运行档位')
assert.doesNotMatch(types, /performanceProfile/)
const bytesAt = adapter.indexOf('const gameBytes = loadGameBytes')
const scriptAt = adapter.indexOf("script.src = `${RUFFLE_PATH}ruffle.js`")
const awaitAt = adapter.indexOf('Promise.all([gameBytes, flashOnlineSave, sfsRuffleConfig])')
assert.ok(bytesAt > 0 && bytesAt < scriptAt && scriptAt < awaitAt, 'SWF、桥配置和 Ruffle 必须并行启动')
assert.match(adapter, /prepareSfsRuffleConfig\(options\.gameSlug\)/)
assert.match(adapter, /installRufflePixelRatioCap\(win\)/)
assert.match(adapter, /waitForRuffleMetadata\(player, aborter\.signal\)/)
assert.match(adapter, /Promise\.resolve\(\)\.then\(\(\) => api!\.load\(loadOptions\)\)/,
  'load 与元数据等待必须由同一个 Promise.all 接管，避免销毁时出现未处理 rejection')
assert.match(adapter, /scheduleCanvasCapabilities\(\)/, '舞台画布晚创建时必须补报截图 / 录屏能力')
assert.match(adapter, /audioContext\.close\(\)\.catch/, '销毁时要兜底关闭残留音频线程')
assert.match(adapter, /player\.metadata/, '元数据就绪后必须读取 SWF 原始舞台尺寸')
assert.match(adapter, /new win\.ResizeObserver\(update\)/, '播放器容器变化时必须重新计算缩放')
assert.match(adapter, /options\.flashControls\?\.displayMode !== 'ruffle'/, '必须保留逐游戏兼容退回开关')
assert.match(adapter, /cancelStageFit\(\)/, '销毁会话时必须断开舞台尺寸监听')
assert.match(frame, /id="stage"/, '独立舞台层不能被删掉，否则 CSS 缩放会直接改写 Ruffle 视口')

console.log('── 大核心预热与旁路门控 ──')
const manifest = JSON.parse(read('public/ruffle/v0.6.0/runtime.json'))
const bootstrap = JSON.parse(read('public/ruffle/v0.6.0/bootstrap.json'))
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

console.log('✅ Ruffle 等比舞台、高抗锯齿、1.25× 像素上限、启动并行、核心预热与 SFS 门控通过')
