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
import { isRuffleFrameReady } from '../src/emulator/ruffleFrame.ts'
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
const player = read('src/emulator/EmulatorPlayer.tsx')
const frame = read('public/flash-frame.html')
const types = read('src/emulator/types.ts')
const vite = read('vite.config.ts')
const serverCache = read('server/src/cache.js')
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
assert.ok(adapter.indexOf('container.appendChild(iframe)') < adapter.indexOf("iframe.src = '/flash-frame.html'"),
  'iframe 必须先挂载再导航，避免 detached iframe 的真实 src 请求被初始空文档吞掉')
assert.match(adapter, /options\.onError\?\.\(rt\.flashInitFailed, 'runtime'\)/,
  '播放壳初始化失败必须标成运行时故障，不能误判成某一种语言 ROM 损坏')
assert.match(vite, /flashFrame[\s\S]*?Cross-Origin-Embedder-Policy', 'require-corp'[\s\S]*?Cross-Origin-Resource-Policy', 'same-origin'/,
  '开发服务器必须让跨源隔离的 play-local 可以内嵌 Flash 播放壳')
assert.match(serverCache, /flash-frame\.html'[\s\S]*?Cross-Origin-Embedder-Policy', 'require-corp'[\s\S]*?Cross-Origin-Resource-Policy', 'same-origin'/,
  '生产静态服务不能把 Flash 播放壳拦成 chrome-error 黑屏')
assert.match(player, /errorScope !== 'runtime'[\s\S]*onRomLoadFailed\?\.\(message\)/,
  '运行时故障不得触发 ROM 语言/备用地址切换')

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
