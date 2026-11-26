/** GBA 无 WebGL / WebAssembly 时的安全运行时选择与软件画面接线。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gbaFallbackRuntime } from '../src/emulator/gbaFallback.ts'

assert.equal(gbaFallbackRuntime({ wasmUnavailable: false, webglUnavailable: false }), null,
  '现代浏览器继续走普通 EmulatorJS/WebGL 路径')
assert.equal(gbaFallbackRuntime({ wasmUnavailable: false, webglUnavailable: true }), 'emulatorjs',
  '仅缺 WebGL 时使用带 HLE BIOS 的 mGBA 和 Canvas 2D 兼容层')
assert.equal(gbaFallbackRuntime({ wasmUnavailable: false, webglUnavailable: true, runtimeOverride: 'iodinegba' }), 'iodinegba',
  '管理员明确固定 IodineGBA 时尊重配置')
assert.equal(gbaFallbackRuntime({ wasmUnavailable: true, webglUnavailable: false }), 'iodinegba',
  '缺少 WebAssembly 时不能启动 EmulatorJS')
assert.equal(gbaFallbackRuntime({ wasmUnavailable: true, webglUnavailable: true }), 'iodinegba',
  '同时缺少两项能力时保留纯 JavaScript 退路')
assert.equal(gbaFallbackRuntime({ wasmUnavailable: true, webglUnavailable: true, runtimeOverride: 'emulatorjs' }), 'iodinegba',
  '浏览器不支持 WebAssembly 时能力门禁优先于逐游戏 EmulatorJS 覆盖')

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const adapter = read('../src/emulator/adapters/emulatorjs.ts')
const registry = read('../src/emulator/registry.ts')
const player = read('../src/emulator/EmulatorPlayer.tsx')
const softwareWebgl = read('../src/emulator/softwareWebgl.ts')

assert.match(registry, /fallbackId = gbaFallbackRuntime\(/,
  '详情页和 ROM 启动共用同一项 GBA 能力选择')
assert.match(adapter, /options\.platform === 'gba' && core === 'mgba' && typeof WebAssembly !== 'undefined'/,
  '软件 WebGL 只扩展到已选的 mGBA，不能误接其它平台核心')
assert.match(adapter, /const softwareWebglFallback = !webglAvailable/,
  '软件画面只在浏览器无法创建真实 WebGL 时启用')
assert.match(adapter, /Canvas 2D context 已创建/,
  '诊断包能区分软件画面层是否成功创建')
assert.match(adapter, /options\.platform === 'gba'\)/,
  '只有 GBA mGBA 请求 Emscripten 所需的 WebGLRenderingContext 实例校验')
assert.match(softwareWebgl, /Object\.setPrototypeOf\(impl, webglPrototype\)/,
  'mGBA 伪上下文通过 legacy glue 的 instanceof 检查')
assert.match(softwareWebgl, /hasOwnProperty\.call\(target, prop\)/,
  'mGBA 伪上下文不会误调原型链上的原生 WebGL 方法')
assert.match(softwareWebgl, /webgl1InstanceCheck \? win\.WebGLRenderingContext\?\.prototype/,
  'FBNeo 仍保持原有代理行为，只有 mGBA 挂接 WebGL1 原型')
assert.match(player, /gbaWasmUnavailable: platform\.id === 'gba' && !webAssemblyAvailable\(\)/,
  '自动开局要把 WebAssembly 能力传给注册表')
assert.match(player, /gbaWebglUnavailable: platform\.id === 'gba' && webglUnavailable/,
  '自动开局要把 WebGL 能力传给注册表')

console.log('✔ GBA fallback：只缺 WebGL 时用 mGBA HLE + Canvas 2D；无 WebAssembly 时保留 IodineGBA')
