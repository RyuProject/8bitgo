/** GBA 无 WebGL / WebAssembly 时的安全运行时选择与软件画面接线。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gbaFallbackRuntime, usesBuiltInGbaHleBios } from '../src/emulator/gbaFallback.ts'
import { createInputSourceRouter } from '../src/emulator/inputSourceRouter.ts'

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
assert.equal(gbaFallbackRuntime({ wasmUnavailable: false, webglUnavailable: false, modernSyntaxUnavailable: true }), 'iodinegba',
  '有 WebAssembly / WebGL 但解析不了原样发布的 EJS 语法时，改走 legacy 安全的纯 JS GBA')
assert.equal(gbaFallbackRuntime({ wasmUnavailable: false, webglUnavailable: false, modernSyntaxUnavailable: true, runtimeOverride: 'emulatorjs' }), 'iodinegba',
  '旧浏览器不能因逐游戏固定 EmulatorJS 而进入必然的语法错误')
assert.equal(usesBuiltInGbaHleBios('gba', 'mgba'), true,
  'mGBA 的内置 HLE BIOS 应免除常规 GBA 开局对外部 BIOS 的依赖')
assert.equal(usesBuiltInGbaHleBios('gba', 'iodinegba'), false,
  'IodineGBA 仍必须下载并校验平台 BIOS')
assert.equal(usesBuiltInGbaHleBios('arcade', 'mgba'), false,
  '平台与核心必须同时匹配，不能把 BIOS 规则套到其它平台')

const routedKeys = []
const inputSources = createInputSourceRouter((button, down) => routedKeys.push([button, down]))
inputSources.set('a', true, 'keyboard')
inputSources.set('a', true, 'gamepad')
inputSources.set('a', false, 'gamepad')
assert.deepEqual(routedKeys, [['a', true]], '手柄松开不能解除仍按住该键的键盘输入')
inputSources.set('a', false, 'keyboard')
assert.deepEqual(routedKeys, [['a', true], ['a', false]], '最后一个输入源松开时才通知核心')
inputSources.set('b', true, 'keyboard:KeyZ')
inputSources.set('b', true, 'keyboard:KeyX')
inputSources.set('b', false, 'keyboard:KeyZ')
assert.deepEqual(routedKeys.slice(-1), [['b', true]], '松开一个映射到同一动作的键不应释放另一个仍按住的键')
inputSources.set('b', false, 'keyboard:KeyX')
assert.deepEqual(routedKeys.slice(-1), [['b', false]], '同一动作的最后一个物理键松开时才释放核心按键')
inputSources.set('l', true, 'touch:l')
inputSources.set('l', true, 'gamepad')
inputSources.releaseSource('gamepad')
assert.deepEqual(routedKeys.slice(-1), [['l', true]], '清理手柄状态时应保留仍按住的触屏肩键')
inputSources.releaseSource('touch:l')
assert.deepEqual(routedKeys.slice(-1), [['l', false]], '触屏松开后才解除仍被持有的肩键')

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const adapter = read('../src/emulator/adapters/emulatorjs.ts')
const iodine = read('../src/emulator/adapters/iodinegba.ts')
const registry = read('../src/emulator/registry.ts')
const player = read('../src/emulator/EmulatorPlayer.tsx')
const softwareWebgl = read('../src/emulator/softwareWebgl.ts')
const platformBios = read('../src/services/platformBios.ts')

assert.match(registry, /fallbackId = gbaFallbackRuntime\(/,
  '详情页和 ROM 启动共用同一项 GBA 能力选择')
assert.match(registry, /modernSyntaxUnavailable: ctx\.gbaModernSyntaxUnavailable/,
  '详情页与 ROM 选择都把旧语法能力送入 GBA 运行时选择')
assert.match(adapter, /options\.platform === 'gba' && core === 'mgba' && typeof WebAssembly !== 'undefined'/,
  '软件 WebGL 只扩展到已选的 mGBA，不能误接其它平台核心')
assert.match(adapter, /usesBuiltInGbaHleBios\(options\.platform, core\)/,
  '常规 mGBA 必须在创建引擎 BIOS 下载任务之前应用 HLE BIOS 策略')
assert.match(adapter, /skipPlatformBios \|\| noBiosNeeded \|\| gbaUsesHleBios \? ''/,
  'mGBA HLE BIOS 开局不得探测、预热或交给引擎下载远端 GBA BIOS')
assert.match(adapter, /gbaUsesHleBios && options\.biosUrl[\s\S]*?IodineGBA 退路/,
  '跳过远端 BIOS 时仍要说明其用途仅是 IodineGBA 兼容退路')
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
assert.match(player, /gbaModernSyntaxUnavailable: platform\.id === 'gba' && !modernRuntimeSyntaxSupported\(\)/,
  '详情页和本地 ROM 开局都要把现代语法能力传给 GBA 运行时策略')
assert.match(player, /gbaWebglUnavailable: platform\.id === 'gba' && webglUnavailable/,
  '自动开局要把 WebGL 能力传给注册表')
assert.match(iodine, /async function prepareIodineBios\(data: ArrayBuffer\)/,
  'IodineGBA BIOS 在 ROM 下载 Promise 等待前完成解包与尺寸校验')
assert.match(iodine, /loadGameBytes\(biosUrl,[\s\S]*?\)\s*\.then\(\(bios\) => prepareIodineBios\(bios\.data\)\)/,
  'BIOS 错误在并行下载阶段立即拒绝，播放器清理会取消仍在进行的 ROM 请求')
assert.match(iodine, /const \[loaded, biosBytes\] = await Promise\.all\(/,
  'BIOS 校验前置不能把正常 ROM 与 BIOS 下载改成串行')
assert.match(iodine, /installPadKeyboard\(\(button, down, _seat, code\) =>[\s\S]*?`keyboard:\$\{code\}`/,
  '本站键盘映射用物理键 code 区分同时按下的同一动作绑定')
assert.match(iodine, /setKey\(button, want, 'gamepad'\)/,
  '手柄松开不能清掉键盘或触屏持有的相同动作')
assert.match(iodine, /setKey\(button, true, `touch:\$\{button\}`\)/,
  '触屏肩键与键盘、手柄拥有独立按住状态')
assert.match(iodine, /window\.addEventListener\('blur', releaseExtraKeys\)/,
  '窗口失焦时要松开 Q / E 肩键，避免回到游戏后持续误输入')
assert.match(iodine, /target\?\.isContentEditable/,
  '编辑富文本时不会误触发 Q / E 肩键')
assert.match(iodine, /const fail = \(error: unknown\) => \{[\s\S]*?options\.onError\?\.\(message, scope\)[\s\S]*?destroy\(\)/,
  'BIOS 配置错误触发标准收尾，不能遗留挂起的 ROM 请求')
assert.match(iodine, /const destroy = \(\) => \{[\s\S]*?aborter\.abort\(\)/,
  '标准收尾通过共享 AbortController 取消 ROM 与 BIOS 传输')
assert.match(platformBios, /resolvePlatformBiosForStartup[\s\S]*?if \(cache === null\)[\s\S]*?fetchPlatformBios\(true\)/,
  'BIOS 绑定表未成功加载时绕过短退避重试一次')
assert.match(platformBios, /startupRetry[\s\S]*?startupRetry = null/,
  '并发开局共享 BIOS 配置重试，避免弱网时请求放大')
assert.match(iodine, /binding\.mapLoaded\)\s*\{[\s\S]*?请检查网络后重试[\s\S]*?'runtime'/,
  'BIOS 配置接口暂时不可用时走可重试的运行环境故障')

// 用真实 API 客户端验证：首次网络失败不会被 5 秒退避挡住开局重试，成功的空表与请求失败可区分。
globalThis.__viteEnv = { VITE_API_URL: 'same-origin' }
let biosRequests = 0
globalThis.fetch = async (input) => {
  assert.equal(String(input), '/api/platform-bios/map')
  biosRequests += 1
  if (biosRequests === 1) throw new TypeError('temporary network failure')
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}
const biosService = await import('../src/services/platformBios.ts')
const biosBinding = await biosService.resolvePlatformBiosForStartup('gba')
assert.equal(biosRequests, 2, '首次读取失败后应立即共享强制重试，不受常规退避影响')
assert.deepEqual(biosBinding, { url: '', mapLoaded: true }, '成功读到空表表示确实未配置，而非网络失败')

// BIOS 网络恢复测试完成后再载入注册表：它的元数据依赖可能间接加载服务模块，不应预热上面的 fetch 桩。
const { resolveRuntime } = await import('../src/emulator/registry.ts')
assert.equal(resolveRuntime({ platform: 'gba', ext: 'gba', gbaModernSyntaxUnavailable: true })?.id, 'iodinegba',
  '详情页与 ROM 选择最终都应由注册表选中纯 JavaScript GBA 运行时')
assert.equal(resolveRuntime({ platform: 'gba', ext: 'gba', runtimeOverride: 'emulatorjs', gbaModernSyntaxUnavailable: true })?.id, 'iodinegba',
  '能力不兼容时逐游戏固定的 EmulatorJS 也要让位')

console.log('✔ GBA fallback：按 WebGL / WebAssembly / 浏览器语法能力选择 mGBA 或 legacy 安全的 IodineGBA')
