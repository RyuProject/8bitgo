/** Ruffle 固定流畅档、启动并行、像素降载和大核心预热回归。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installRufflePixelRatioCap,
  supportsRuffleWasmExtensions,
} from '../src/emulator/rufflePerformance.ts'
import { isSfsGame } from '../shared/sfs-games.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

console.log('── 高分屏降载 ──')
const retina = { devicePixelRatio: 2 }
assert.equal(installRufflePixelRatioCap(retina), 1)
assert.equal(retina.devicePixelRatio, 1, 'Retina iframe 必须按 1× 画布渲染')
const regular = { devicePixelRatio: 1 }
assert.equal(installRufflePixelRatioCap(regular), 1)
const locked = {}
Object.defineProperty(locked, 'devicePixelRatio', { configurable: false, value: 2 })
assert.equal(installRufflePixelRatioCap(locked), 2, '浏览器拒绝覆盖时必须安全退回原值')

console.log('── WASM 变体选择 ──')
let probes = 0
assert.equal(supportsRuffleWasmExtensions(() => { probes++; return true }), true)
assert.equal(probes, 5, '必须和 Ruffle 0.6 的五项能力探针一致')
assert.equal(supportsRuffleWasmExtensions(() => false), false)
assert.equal(supportsRuffleWasmExtensions(() => { throw new Error('blocked') }), false)

console.log('── 启动链与固定流畅档 ──')
const adapter = read('src/emulator/adapters/ruffle.ts')
const player = read('src/emulator/EmulatorPlayer.tsx')
const types = read('src/emulator/types.ts')
assert.match(adapter, /quality:\s*'low'/, 'Ruffle 必须固定 low，不能再按设备退回高画质')
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

console.log('✅ Ruffle 流畅档、像素降载、启动并行、核心预热与 SFS 门控通过')
