#!/usr/bin/env node
/** 检查 PSP 平台、桥与 Range 核心是不是同一套可发布实现。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const RUNTIME_GENERATION = 'v8'
const useDist = process.argv.includes('--dist')
const sourceOnly = process.argv.includes('--source-only')
const publicDir = join(root, 'public', 'ppsspp', `v${VERSION}`, RUNTIME_GENERATION)
const runtimeDir = useDist ? join(root, 'dist', 'client', 'ppsspp', `v${VERSION}`, RUNTIME_GENERATION) : publicDir

const fail = (message) => {
  console.error(`✖ PPSSPP 检查失败：${message}`)
  process.exit(1)
}
const need = (path) => {
  if (!existsSync(path)) fail(`缺少 ${path}`)
  return readFileSync(path)
}

for (const name of ['index.html', 'host.js', 'audio-worklet.js', 'runtime.json', 'SOURCE.txt']) need(join(runtimeDir, name))
const host = need(join(runtimeDir, 'host.js')).toString('utf8')
const audioWorklet = need(join(runtimeDir, 'audio-worklet.js')).toString('utf8')
const adapter = need(join(root, 'src', 'emulator', 'adapters', 'ppsspp.ts')).toString('utf8')
const prewarm = need(join(root, 'src', 'emulator', 'prewarm.ts')).toString('utf8')
const paths = need(join(root, 'src', 'emulator', 'paths.ts')).toString('utf8')
for (const marker of [
  '8bitgo-ppsspp-bridge',
  'mount-remote',
  'WORKERFS',
  'IDBFS',
  '__ppssppRangeProgress',
  '__ppssppRangeError',
  'runtime-error',
  "RUNTIME_SCRIPT = 'PPSSPPSDL.js'",
  "AUDIO_WORKLET_SCRIPT = 'audio-worklet.js'",
  'getPreloadedPackage',
  'fetchCoreData',
  "MEMSTICK_DIRS = ['PSP', 'PSP/SYSTEM', 'PSP/SAVEDATA', 'PSP/PPSSPP_STATE', 'PSP/GAME']",
  "MEMSTICK_SEED_FILES = ['PSP/SYSTEM/controls.ini']",
]) {
  if (!host.includes(marker)) fail(`host.js 缺少桥标记 ${marker}`)
}
const runtimeInit = /onRuntimeInitialized\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*onAbort/.exec(host)?.[1] ?? ''
if (!runtimeInit || /respond\s*\(/.test(runtimeInit)) {
  fail('host.js 在 onRuntimeInitialized 阶段就回复成功；此时 PPSSPP 还没有执行 main 或读取镜像')
}
if (!/<script src="host\.js"><\/script>/.test(need(join(runtimeDir, 'index.html')).toString('utf8'))) {
  fail('v8 index.html 没有引用同一实体目录里的 host.js')
}
if (!/PPSSPP_RUNTIME_GENERATION = 'v8'/.test(paths) || !/PPSSPP_RUNTIME_PATH/.test(adapter)) {
  fail('PPSSPP iframe 没有使用 v8 实体目录；查询串不能穿透当前 Cloudflare 缓存键')
}
if (/fetch\s*\(\s*(?:remote(?:\?\.)?\.url|gamePath)/.test(host)) {
  fail('host.js 出现整盘下载代码；远程镜像只能把 URL 交给 C++ Range loader')
}
if (!/arguments:\s*\[[\s\S]*?'--windowed'[\s\S]*?'--xres'[\s\S]*?'--yres'/.test(host) || !host.includes('width: 960, height: 544')) {
  fail('host.js 没有限制 PSP 后备缓冲；Retina 屏会重新触发每帧多倍像素复制')
}
for (const marker of [
  '--appendconfig=${PERFORMANCE_CONFIG_PATH}',
  '`--memstick=${SAVE_ROOT}`',
  'InternalResolution = 1',
  'SkipBufferEffects = False',
  'SkipGPUReadbackMode = 0',
  'HighQualityDepth = True',
  'VerticalSync = False',
  'LowLatencyPresent = False',
  'InflightFrames = 2',
  'FrameSkip = 0',
  'AutoFrameSkip = False',
]) {
  if (!host.includes(marker)) fail(`host.js 缺少 PSP 通用兼容配置 ${marker}`)
}
if (/'--memstick',\s*SAVE_ROOT/.test(host)) {
  fail('host.js 把 memstick 选项拆成两个 argv；PPSSPP 会把路径误认成第二个待启动文件')
}
if (!/for \(const directory of MEMSTICK_DIRS\) FS\.mkdirTree/.test(host)) {
  fail('host.js 没有在放行 PPSSPP main 前准备 SYSTEM/SAVEDATA/状态目录；首次启动会无法保存配置')
}
if (!/FS\.stat\(path\)[\s\S]*?FS\.writeFile\(path, new Uint8Array\(\)\)/.test(host)) {
  fail('host.js 没有保留已有控制器配置并只在首次启动补空 controls.ini')
}
if (host.includes('核心没有 Range 遥测回调，使用首帧兼容判据')) {
  fail('v8 仍会在没有真实读盘时把空画布误报成游戏已启动')
}
if (!/gameBootConfirmed/.test(host) || !/BOOTED_LOG_PATTERN = \/\\bBooted\\s\+\.\+\\\.\\\.\\\.\//.test(host)) {
  fail('v8 没有等待 PPSSPP 的 Booted 日志；Range 遥测跨线程丢失时会再次超时')
}
if (!/print\(text\)[\s\S]*?observeCoreLog\(message\)[\s\S]*?printErr\(text\)[\s\S]*?observeCoreLog\(message\)/.test(host)) {
  fail('v8 没有同时观察 stdout/stderr；不同 Emscripten 日志路由下会漏掉 Booted')
}
if (!/MOUNT_TIMEOUT_MS = 300_000/.test(adapter)) {
  fail('PSP 冷启动仍可能被旧的短超时误杀')
}
if (!/FS\.writeFile\(PERFORMANCE_CONFIG_PATH,[\s\S]*?performanceConfig\(profile\)/.test(host)) {
  fail('host.js 没有在 PPSSPP 启动前写入通用兼容配置')
}
for (const marker of ["registerProcessor('ppsspp-audio'", 'Atomics.load', 'Atomics.store']) {
  if (!audioWorklet.includes(marker)) fail(`audio-worklet.js 缺少共享音频消费标记 ${marker}`)
}

const patch = need(join(root, 'vendor', 'ppsspp', 'patches', '0001-range-streaming.patch')).toString('utf8')
for (const marker of [
  'EMSCRIPTEN_FETCH_SYNCHRONOUS',
  'fetch->status == 206',
  'BLOCK_BYTES = 2 * 1024 * 1024',
  'MAX_CACHE_BYTES = 96 * 1024 * 1024',
  '-sPROXY_TO_PTHREAD=1',
  '__ppssppRangeProgress',
  '__ppssppRangeError',
  'If-Match',
  'If-Unmodified-Since',
  'emscripten_thread_sleep',
  'HTTP Range offset overflow',
  'EMSCRIPTEN_WEBGL_CONTEXT_PROXY_ALWAYS',
  'emscripten_webgl_create_context',
  'emscripten_webgl_commit_frame',
]) {
  if (!patch.includes(marker)) fail(`核心补丁缺少 ${marker}`)
}

const sdlAudioPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0002-sdl2-pthread-audio.patch')).toString('utf8')
if (!sdlAudioPatch.includes('this->spec.freq = MAIN_THREAD_EM_ASM_INT')) {
  fail('SDL 音频补丁没有把采样率读取代理到主线程')
}
const pthreadAudioPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0003-pthread-audio-ring.patch')).toString('utf8')
for (const marker of ['Wasm audio bridge started', "Module['__ppssppAudio']", 'PumpWasmAudioBridge()']) {
  if (!pthreadAudioPatch.includes(marker)) fail(`pthread 音频桥补丁缺少 ${marker}`)
}
if (!pthreadAudioPatch.includes('每帧重复设置同一个定时器只会增加 Worker 调度抖动')) {
  fail('pthread 音频桥补丁仍会在每帧重复重设 Emscripten 调度器')
}
const proxiedWebglPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0004-emscripten-proxied-webgl-preloop.patch')).toString('utf8')
if (!proxiedWebglPatch.includes('if (!GL.currentContextIsProxied) GL.newRenderingFrameStarted();')) {
  fail('WebGL 代理补丁没有跳过 Worker 中只有整数令牌的代理上下文')
}
const webFeaturesPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0005-web-save-controls-bridge.patch')).toString('utf8')
for (const marker of ['__ppssppBridgeSetCommand', '__ppssppBridgePopupOpen', '__ppssppNativeResult', 'SaveState::SaveSlot(prefix, 0', 'UIMessage::SHOW_CONTROL_MAPPING']) {
  if (!webFeaturesPatch.includes(marker)) fail(`PSP 存档/改键桥补丁缺少 ${marker}`)
}
const performancePatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0006-web-performance.patch')).toString('utf8')
for (const marker of [
  'AudioWorkletNode',
  'ReportWasmPerformance',
  'Math.min(8,Math.max(4,navigator.hardwareConcurrency||4))',
  '-DWASM_ENABLE_LTO=ON',
  'ALLOW_HIGHDPI 会让 SDL 再乘一次 DPR',
]) {
  if (!performancePatch.includes(marker)) fail(`PSP 性能补丁缺少 ${marker}`)
}
const chdRangePatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0007-chd-range-performance.patch')).toString('utf8')
for (const marker of ['CHD_BLOCK_BYTES = 512 * 1024', 'blockBytes_ = CHD_BLOCK_BYTES', 'cursor / blockBytes_']) {
  if (!chdRangePatch.includes(marker)) fail(`CHD Range 性能补丁缺少 ${marker}`)
}
const coldStartPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0008-web-cold-start.patch')).toString('utf8')
for (const marker of ['CHD_BLOCK_BYTES = 2 * 1024 * 1024', '--exclude-file', '*/assets/debugger/*', '约 86 秒', '约 93 秒']) {
  if (!coldStartPatch.includes(marker)) fail(`PSP 冷启动补丁缺少 ${marker}`)
}
const workerCanvasPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0009-worker-offscreen-canvas.patch')).toString('utf8')
for (const marker of ['-sOFFSCREENCANVAS_SUPPORT=1', 'EMSCRIPTEN_WEBGL_CONTEXT_PROXY_FALLBACK', 'attrs.renderViaOffscreenBackBuffer = false']) {
  if (!workerCanvasPatch.includes(marker)) fail(`Worker OffscreenCanvas 补丁缺少 ${marker}`)
}
const wasmFfmpegPatch = need(join(root, 'vendor', 'ppsspp', 'patches', '0010-wasm-ffmpeg.patch')).toString('utf8')
for (const marker of ['WASM_USE_FFMPEG ?= OFF', '-DUSE_FFMPEG=$(WASM_USE_FFMPEG)', '-DFFMPEG_DIR=$(WASM_FFMPEG_DIR)']) {
  if (!wasmFfmpegPatch.includes(marker)) fail(`Web FFmpeg 补丁缺少 ${marker}`)
}
for (const marker of [
  "runtime === 'ppsspp'",
  '${PPSSPP_RUNTIME_PATH}index.html?embed=1',
  '${PPSSPP_RUNTIME_PATH}PPSSPPSDL.wasm',
  '${PPSSPP_RUNTIME_PATH}PPSSPPSDL.data',
  'hasHoverIntent() && allowsLargeHoverPrewarm()',
]) {
  if (!prewarm.includes(marker)) fail(`PSP 悬停预热缺少 ${marker}`)
}

const manifest = JSON.parse(need(join(runtimeDir, 'runtime.json')).toString('utf8'))
if (manifest.runtimeGeneration !== RUNTIME_GENERATION) fail('runtime.json 的实体目录代次不正确')
if (manifest.startupReadinessProfile !== 'core-boot-log-v1') fail('runtime.json 没有声明基于核心 Booted 日志的启动判据')
if (manifest.commit !== '0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a') fail('runtime.json 的上游提交没有锁定')
if (manifest.rangeStreaming !== true || manifest.blockBytes !== 2097152) {
  fail('runtime.json 的 Range 参数不正确')
}
const loaderRevision = Number(manifest.rangeLoaderRevision || 1)
if (loaderRevision === 1 && manifest.memoryCacheBytes !== 201326592) fail('旧版核心的缓存参数清单不正确')
if (loaderRevision >= 2 && manifest.memoryCacheBytes !== 100663296) fail('Range v2+ 核心的缓存参数清单不正确')
if (![1, 2, 3, 4].includes(loaderRevision)) fail(`不认识的 Range loader 代次：${manifest.rangeLoaderRevision}`)
if (loaderRevision >= 2 && (manifest.rangeTelemetry !== true || manifest.objectValidator !== 'etag-or-last-modified')) {
  fail('Range v2+ 清单缺少进度/错误遥测或对象一致性校验声明')
}
if (loaderRevision === 3 && manifest.chdBlockBytes !== 524288) {
  fail('Range v3 清单没有声明 CHD 专用 512 KiB 分片')
}
if (loaderRevision === 4 && (manifest.chdBlockBytes !== 2097152 || manifest.preloadAssetsProfile !== 'runtime-no-debugger')) {
  fail('Range v4 清单没有声明实测 2 MiB CHD 分片或精简的 Web data 包')
}
if (
  manifest.rangeReadAheadProfile !== 'adaptive-sequential-v1' ||
  manifest.rangeReadAheadBlocks !== 2 ||
  manifest.rangeReadAheadCacheBytes !== 8388608
) {
  fail('runtime.json 没有声明受限的 PSP 顺序预读策略')
}
if (manifest.workerModel !== 'self-script') fail('runtime.json 没有声明 Emscripten 5 的自身 Worker 模型')
if (
  manifest.offscreenCanvas !== true ||
  manifest.offscreenFramebuffer !== 'fallback' ||
  manifest.webglContext !== 'worker-offscreen-canvas-with-proxy-fallback'
) {
  fail('runtime.json 没有声明 Worker OffscreenCanvas 主路径与代理回退模型')
}
if (manifest.proxiedWebglPreloop !== 'fallback-skip-worker-token') {
  fail('runtime.json 没有声明回退代理 WebGL 上下文的预帧保护')
}
if (manifest.pthreadAudioContext !== 'shared-ring-buffer-worklet') {
  fail('runtime.json 没有声明 AudioWorklet 共享音频桥；页面主线程卡顿会造成 PSP 爆音')
}
if (
  manifest.performanceProfile !== 'adaptive-canvas-v1' ||
  manifest.maxCanvasPixels !== 522240 ||
  manifest.pthreadPoolMax !== 8 ||
  manifest.lto !== true ||
  manifest.performanceTelemetry !== true
) {
  fail('runtime.json 缺少 PSP 自适应画布、线程上限、LTO 或性能遥测声明')
}
if (
  manifest.inputLatencyProfile !== 'inflight-2-vsync-off-buffered-native' ||
  manifest.graphicsCompatibilityProfile !== 'buffered-native-v1'
) {
  fail('runtime.json 没有声明 PSP 的原生分辨率、完整缓冲与两帧呈现兼容档')
}
if (manifest.webFeaturesBridge !== 'savestate-controls-v1') {
  fail('runtime.json 没有声明 PSP 即时存档/改键桥')
}
if (
  manifest.mediaEngine !== 'ffmpeg-h264-audio-minimal' ||
  manifest.ffmpegCommit !== '1e3b4965632f60b1d85360261d1b9dd45444bc71' ||
  !Array.isArray(manifest.mediaDecoders) ||
  !['h264', 'aac', 'atrac3', 'atrac3p', 'mp3'].every((codec) => manifest.mediaDecoders.includes(codec))
) {
  fail('runtime.json 没有声明锁定的 PSP H.264/音频解码能力')
}

const binaries = ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data']
const installed = binaries.every((name) => existsSync(join(runtimeDir, name)))
const productionEnv = existsSync(join(root, '.env.production'))
  ? readFileSync(join(root, '.env.production'), 'utf8')
  : ''
const productionEnabled = /^VITE_PPSSPP_PATH\s*=\s*\S+/m.test(productionEnv)
if ((!sourceOnly || productionEnabled) && !installed) {
  fail('核心二进制尚未安装；先运行 npm run ppsspp:build -- --source <源码目录>')
}
if (installed) {
  if (!manifest.artifactsInstalled || !manifest.artifacts) fail('已有二进制，但 runtime.json 没有来源/哈希清单')
  const runtimeScript = need(join(runtimeDir, 'PPSSPPSDL.js')).toString('utf8')
  if (!runtimeScript.includes('if(fetched?.then){fetched=await fetched}else if(!fetched){fetched=await fetchPromise}')) {
    fail('PPSSPPSDL.js 没有等待异步核心资源重试 Promise，真机解包会报 bad input')
  }
  for (const marker of ['__8bitgoCreatePspRangeXhr', '__8bitgoPspRangeWarmStats']) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 PSP 顺序预读标记 ${marker}`)
  }
  if (!runtimeScript.includes('pthreadMainJs=_scriptName') || !runtimeScript.includes('new Worker(pthreadMainJs')) {
    fail('PPSSPPSDL.js 缺少自身 Worker 标记，PROXY_TO_PTHREAD 没有正确发布')
  }
  if (!runtimeScript.includes('createOffscreenFramebuffer') || !runtimeScript.includes('renderViaOffscreenBackBuffer')) {
    fail('PPSSPPSDL.js 缺少 OffscreenFramebuffer 支持；pthread 的 GL 调用无法安全代理到主线程')
  }
  for (const marker of ['proxyContextToMainThread', 'emscripten_webgl_do_create_context']) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 WebGL Worker 代理标记 ${marker}`)
  }
  if (!runtimeScript.includes('transferControlToOffscreen') || !runtimeScript.includes('offscreenCanvases')) {
    fail('PPSSPPSDL.js 缺少 Worker OffscreenCanvas 转交；显卡指令会重新走容易花屏的主线程逐条代理路径')
  }
  if (!/registerPreMainLoop\(\(\)=>\{if\(!GL\.currentContextIsProxied\)GL\.newRenderingFrameStarted\(\)/.test(runtimeScript)) {
    fail('PPSSPPSDL.js 缺少代理 WebGL 上下文预帧保护')
  }
  if (!runtimeScript.includes('IDBFS') || !/FS\.filesystems=\{[^}]*IDBFS[^}]*\}/.test(runtimeScript)) {
    fail('PPSSPPSDL.js 没有链接 IDBFS；host.js 会在存档挂载阶段中止启动')
  }
  if (loaderRevision >= 4 && runtimeScript.includes('/assets/debugger/')) {
    fail('Range v4 的 PPSSPPSDL.data 仍打包了不会使用的远程调试器资源')
  }
  for (const marker of ['__ppssppAudio', 'AudioWorkletNode', 'ppsspp-audio', 'createScriptProcessor', '__ppssppPerformance']) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 pthread 共享音频桥标记 ${marker}`)
  }
  for (const marker of ['__ppssppBridgeSetCommand', '__ppssppBridgePopupOpen', '__ppssppNativeResult']) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 PSP 存档/改键桥标记 ${marker}`)
  }
  if (loaderRevision >= 2) {
    for (const marker of ['__ppssppRangeProgress', '__ppssppRangeError']) {
      if (!runtimeScript.includes(marker)) fail(`Range v2 二进制缺少 ${marker}，清单与核心不一致`)
    }
    const runtimeWasm = need(join(runtimeDir, 'PPSSPPSDL.wasm')).toString('latin1')
    for (const marker of ['If-Match', 'If-Unmodified-Since', 'HTTP Range offset overflow']) {
      if (!runtimeWasm.includes(marker)) fail(`Range v2 WASM 缺少 ${marker}，清单与核心不一致`)
    }
    if (!runtimeWasm.includes('H.264')) {
      fail('PPSSPPSDL.wasm 缺少 H.264 解码器；开场视频会显示为彩色花屏')
    }
    for (const marker of ['SkipBufferEffects', 'SkipGPUReadbackMode', 'HighQualityDepth', 'InflightFrames', 'LowLatencyPresent']) {
      if (!runtimeWasm.includes(marker)) fail(`PPSSPP 二进制不认识兼容配置 ${marker}`)
    }
  }
  for (const name of binaries) {
    const bytes = need(join(runtimeDir, name))
    const expected = manifest.artifacts[name]
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!expected || expected.bytes !== bytes.byteLength || expected.sha256 !== hash) fail(`${name} 与 runtime.json 校验值不符`)
  }
}

if (installed && loaderRevision === 1) {
  console.warn('⚠ PPSSPP 仍是 Range v1 二进制：桥层修复已生效；96MB 缓存、对象校验与原生遥测要在下一次 ppsspp:build 后生效')
}

if (useDist) {
  for (const name of ['index.html', 'host.js', 'audio-worklet.js', 'runtime.json', 'SOURCE.txt']) {
    const a = need(join(publicDir, name))
    const b = need(join(runtimeDir, name))
    if (!a.equals(b)) fail(`dist/client 中的 ${name} 不是 public 里的当前版本`)
  }
}

console.log(`✔ PPSSPP ${sourceOnly && !installed ? '源码接入' : 'Range 运行时'}检查通过${useDist ? '（dist）' : ''}`)
