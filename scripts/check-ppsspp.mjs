#!/usr/bin/env node
/** 检查 PSP 平台、桥与 Range 核心是不是同一套可发布实现。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const RUNTIME_GENERATION = 'v33'
const CORE_ASSET_GENERATION = 'v33'
const useDist = process.argv.includes('--dist')
const sourceOnly = process.argv.includes('--source-only')
const publicDir = join(root, 'public', 'ppsspp', `v${VERSION}`, RUNTIME_GENERATION)
const runtimeDir = useDist ? join(root, 'dist', 'client', 'ppsspp', `v${VERSION}`, RUNTIME_GENERATION) : publicDir
const publicCoreDir = join(root, 'public', 'ppsspp', `v${VERSION}`, CORE_ASSET_GENERATION)
const runtimeCoreDir = useDist ? join(root, 'dist', 'client', 'ppsspp', `v${VERSION}`, CORE_ASSET_GENERATION) : publicCoreDir

const fail = (message) => {
  console.error(`✖ PPSSPP 检查失败：${message}`)
  process.exit(1)
}
const need = (path) => {
  if (!existsSync(path)) fail(`缺少 ${path}`)
  return readFileSync(path)
}

for (const name of ['index.html', 'host.js', 'audio-worklet.js', 'range-prefetch-worker.js', 'local-disc-sw.js', 'runtime.json', 'SOURCE.txt']) need(join(runtimeDir, name))
const host = need(join(runtimeDir, 'host.js')).toString('utf8')
const audioWorklet = need(join(runtimeDir, 'audio-worklet.js')).toString('utf8')
const prefetchWorker = need(join(runtimeDir, 'range-prefetch-worker.js')).toString('utf8')
const localDiscWorker = need(join(runtimeDir, 'local-disc-sw.js')).toString('utf8')
const adapter = need(join(root, 'src', 'emulator', 'adapters', 'ppsspp.ts')).toString('utf8')
const prewarm = need(join(root, 'src', 'emulator', 'prewarm.ts')).toString('utf8')
const paths = need(join(root, 'src', 'emulator', 'paths.ts')).toString('utf8')
for (const marker of [
  '8bitgo-ppsspp-bridge',
  'mount-remote',
  'openLocalDisc',
  'local-disc-sw.js',
  'IDBFS',
  '__ppssppRangeProgress',
  '__ppssppRangeError',
  'runtime-error',
  "RUNTIME_SCRIPT = 'PPSSPPSDL.js'",
  "AUDIO_WORKLET_SCRIPT = 'audio-worklet.js'",
  "CORE_ASSET_PATH = './'",
  'getPreloadedPackage',
  'fetchCoreData',
  "controller.abort('核心资源本次下载失败，终止旧数据流')",
  "MEMSTICK_DIRS = ['PSP', 'PSP/SYSTEM', 'PSP/SAVEDATA', 'PSP/PPSSPP_STATE', 'PSP/GAME']",
  "MEMSTICK_SEED_FILES = ['PSP/SYSTEM/controls.ini']",
]) {
  if (!host.includes(marker)) fail(`host.js 缺少桥标记 ${marker}`)
}
const runtimeInit = /onRuntimeInitialized\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*onAbort/.exec(host)?.[1] ?? ''
if (!runtimeInit || /respond\s*\(/.test(runtimeInit)) {
  fail('host.js 在 onRuntimeInitialized 阶段就回复成功；此时 PPSSPP 还没有执行 main 或读取镜像')
}
// v17：大陆访客的 wasm / data 走 EdgeOne；只能挪这两份，且必须能当场回同源
for (const marker of [
  "const CORE_EDGE_FILES = ['PPSSPPSDL.wasm', 'PPSSPPSDL.data']",
  "get('edge') !== 'cn'",
  'return coreUrl(path)',
  "if (attempt > 1) return nativeFetch(fallback, { ...init, cache: 'reload' })",
  "console.warn('[ppsspp] 加速入口取核心失败，改走同源'",
]) {
  if (!host.includes(marker)) fail(`host.js 缺少加速入口标记 ${marker}`)
}

const indexHtml = need(join(runtimeDir, 'index.html')).toString('utf8')
const hostScriptIntegrity = /<script src="host\.js" integrity="(sha256-[^"]+)" crossorigin="anonymous"><\/script>/.exec(indexHtml)?.[1]
const expectedHostIntegrity = `sha256-${createHash('sha256').update(host).digest('base64')}`
if (!hostScriptIntegrity || hostScriptIntegrity !== expectedHostIntegrity) {
  fail('v33 index.html 的 host.js SRI 缺失或与实际脚本不匹配')
}
if (!/PPSSPP_RUNTIME_GENERATION = 'v33'/.test(paths) || !/PPSSPP_CORE_ASSET_GENERATION = 'v33'/.test(paths) || !/PPSSPP_FRAME_REVISION = '4'/.test(paths) || !/ppssppFrameUrl/.test(adapter)) {
  fail('PPSSPP iframe 没有使用 v33 MessagePort Broker Range 运行时')
}
if (!host.includes('__8bitgoPspRangeUrls') || !adapter.includes('alternateRomUrls')) {
  fail('PPSSPP 远程光盘没有在 Range 探测和核心读取阶段配置备用线路')
}
if (/fetch\s*\(\s*(?:remote(?:\?\.)?\.url|gamePath)/.test(host)) {
  fail('host.js 出现整盘下载代码；远程镜像只能把 URL 交给 C++ Range loader')
}
if (!/arguments:\s*\[[\s\S]*?'--windowed'[\s\S]*?'--xres'[\s\S]*?'--yres'/.test(host) ||
  !host.includes('width: 480, height: 272') || !host.includes('width: 640, height: 360') || !host.includes('width: 720, height: 408')) {
  fail('host.js 缺少性能优先的 480×272 / 640×360 / 720×408 自适应档')
}
if (!host.includes('slowNetwork') || !host.includes('qq-compat') || !host.includes('mobileDevice') ||
  !host.includes('highEndDesktop') || !host.includes('diagnostics') || !host.includes('error?.stack')) {
  fail('PPSSPP 桥缺少慢网/移动/高配桌面分档、QQ 浏览器兼容档或运行时 worker 调用栈')
}
if (!host.includes('flushDeadline') || !host.includes('Promise.race([syncSaves(), flushDeadline])')) {
  fail('PPSSPP 运行时错误没有先冲刷电池存档')
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
  fail('PPSSPP 仍会在没有真实读盘时把空画布误报成游戏已启动')
}
if (!/gameBootConfirmed/.test(host) || !/BOOTED_LOG_PATTERN = \/\\bBooted\\s\+\.\+\\\.\\\.\\\.\//.test(host)) {
  fail('PPSSPP 没有等待真实 Booted 日志；Range 遥测跨线程丢失时会再次超时')
}
if (!/print\(text\)[\s\S]*?observeCoreLog\(message\)[\s\S]*?printErr\(text\)[\s\S]*?observeCoreLog\(message\)/.test(host)) {
  fail('PPSSPP 没有同时观察 stdout/stderr；不同 Emscripten 日志路由下会漏掉 Booted')
}
if (/FS\.mount\([^\n]*WORKERFS|FS\.createLazyFile\(/.test(host)) {
  fail('本地 PSP 镜像不能在主线程挂 WORKERFS 或用同步 XHR 的 LazyFile')
}
if (!/if \(!gameBootConfirmed\) return/.test(host) || !/localDisc = await openLocalDisc\(file\)/.test(host)) {
  fail('本地 PSP 启动没有等真实 Booted，或没有建立按需 Range 通道')
}
for (const marker of ['BroadcastChannel', 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'MAX_READ_BYTES']) {
  if (!localDiscWorker.includes(marker)) fail(`本地 PSP 读盘服务缺少 ${marker}`)
}
if (!/MOUNT_TIMEOUT_MS = 300_000/.test(adapter)) {
  fail('PSP 冷启动仍可能被旧的短超时误杀')
}
if (!/createVisibilityTimeout\(entry\.activityTimeoutMs \|\| MOUNT_TIMEOUT_MS/.test(adapter) ||
    !/createVisibilityTimeout\(HOST_TIMEOUT_MS/.test(adapter) ||
    !/createVisibilityTimeout\(RANGE_PROBE_TIMEOUT_MS/.test(adapter)) {
  fail('PSP 桥、入口和 Range 探测时限必须暂停隐藏标签页时间')
}
if (!/FS\.writeFile\(PERFORMANCE_CONFIG_PATH,[\s\S]*?performanceConfig\(profile\)/.test(host)) {
  fail('host.js 没有在 PPSSPP 启动前写入通用兼容配置')
}
for (const marker of ["registerProcessor('ppsspp-audio'", 'Atomics.load', 'Atomics.store', 'missingFrames', 'this.recovering']) {
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
  'ppssppFrameUrl()',
  "ppssppAsset('PPSSPPSDL.js')",
  "ppssppAsset('PPSSPPSDL.wasm')",
  "ppssppAsset('PPSSPPSDL.data')",
  '${PPSSPP_CORE_ASSET_PATH}audio-worklet.js',
  '${PPSSPP_RUNTIME_PATH}range-prefetch-worker.js',
  'hasHoverIntent() && allowsLargeHoverPrewarm()',
]) {
  if (!prewarm.includes(marker)) fail(`PSP 悬停预热缺少 ${marker}`)
}

const manifest = JSON.parse(need(join(runtimeDir, 'runtime.json')).toString('utf8'))
if (manifest.runtimeErrorSaveFlush !== 'idbfs-flush-before-report-1500ms-v1') {
  fail('runtime.json 没有声明运行时故障前冲刷 PPSSPP 电池存档')
}
if (manifest.runtimeGeneration !== RUNTIME_GENERATION || manifest.coreAssetGeneration !== CORE_ASSET_GENERATION) fail('runtime.json 的桥 / 核心实体目录代次不正确')
if (manifest.runtimeIntegrityProfile !== 'sha256-2miblocks-v1' || !manifest.integrityBlocks) {
  fail('runtime.json 没有声明 PPSSPP 核心 SHA-256 分块清单')
}
if (manifest.rangeReadAheadProfile !== 'adaptive-rolling-buffer-messageport-page-broker-demand-coalescing-v3' ||
    manifest.rangeTransferTimeoutProfile !== 'conservative-mobile-range-timeout-v4' ||
    manifest.mobileRangeReadAheadConcurrency !== 2 ||
    manifest.mobileSlowRangeReadAheadConcurrency !== 1) {
  fail('runtime.json 没有声明 v33 MessagePort 去重与 v30 手机并发/超时保护')
}
if (manifest.touchControlsProfile !== 'mobile-always-visible-portrait-layout-v1' ||
    !host.includes("['mobile', 'qq-compat'].includes(profile.id)") ||
    !host.includes('TouchButtonHideSeconds = 0') ||
    !host.includes('[TouchControls.Portrait]') ||
    !host.includes('DPadX = 0.20') || !host.includes('AnalogStickY = 0.60')) {
  fail('v33 没有为移动浏览器保留常显触控或竖屏布局')
}
const coreScriptSRI = `sha256-${Buffer.from(manifest.artifacts['PPSSPPSDL.js']?.sha256 || '', 'hex').toString('base64')}`
const hostSRI = `sha256-${createHash('sha256').update(need(join(runtimeDir, 'host.js'))).digest('base64')}`
if (!host.includes(`script.integrity = '${coreScriptSRI}'`) ||
    !need(join(runtimeDir, 'index.html')).toString('utf8').includes(`integrity="${hostSRI}"`)) {
    fail('PPSSPP 核心 JS / v33 host.js 缺少与清单一致的 SRI')
}
for (const name of ['PPSSPPSDL.wasm', 'PPSSPPSDL.data']) {
  const bytes = need(join(runtimeCoreDir, name))
  const expected = manifest.integrityBlocks[name]
  const blockBytes = Number(manifest.blockBytes)
  const actualBlocks = []
  for (let offset = 0; offset < bytes.byteLength; offset += blockBytes) {
    actualBlocks.push(createHash('sha256').update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + blockBytes))).digest('hex'))
  }
  if (!expected || expected.bytes !== bytes.byteLength || expected.blockBytes !== blockBytes ||
      JSON.stringify(expected.blocks) !== JSON.stringify(actualBlocks) || !host.includes(JSON.stringify(manifest.integrityBlocks))) {
    fail(`${name} 的运行时校验块、核心文件和 host.js 清单不一致`)
  }
}
for (const marker of [
  "verifyCoreResponse(response.clone(), 'PPSSPPSDL.wasm')",
  "verifyCoreBytes(output, 'PPSSPPSDL.data')",
  'wasmIntegrityByResponse.set(response, verification)',
  'wasmIntegrityByResponse.get(response)',
  "await verifyCoreBytes(source, 'PPSSPPSDL.wasm')",
  'WebAssembly.instantiateStreaming = async',
  "cache: attempt === 1 ? 'force-cache' : 'reload'",
]) {
  if (!host.includes(marker)) fail(`host.js 缺少核心完整性保护 ${marker}`)
}
if (manifest.rangeAlternateRouteProfile !== 'probe-and-sync-failover-v1') {
  fail('runtime.json 没有声明 PSP 远程盘 Range 备用线路方案')
}
if (manifest.localDiscProfile !== 'service-worker-range-v1') fail('runtime.json 没有声明本地镜像按需读盘方案')
const localDiscBytes = need(join(runtimeDir, 'local-disc-sw.js'))
const localDiscArtifact = manifest.artifacts?.['local-disc-sw.js']
if (localDiscArtifact?.bytes !== localDiscBytes.byteLength ||
  localDiscArtifact.sha256 !== createHash('sha256').update(localDiscBytes).digest('hex')) {
  fail('本地读盘 Service Worker 与 runtime.json 校验值不符')
}
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
  manifest.rangeReadAheadProfile !== 'adaptive-rolling-buffer-messageport-page-broker-demand-coalescing-v3' ||
  manifest.browserHttpCache !== 'romv-pinned-no-conditional-v1' ||
  manifest.rangeReadAheadBlocks !== 10 ||
  manifest.rangeReadAheadConcurrency !== 4 ||
  manifest.rangeReadAheadCacheBytes !== 25165824 ||
  manifest.rangeTransferTimeoutProfile !== 'conservative-mobile-range-timeout-v4' ||
  // v18/v20：正式同步读盘遇到 status 0 就地退避重试，超时后放宽时限（海外玩家开局后断流整局失败）
  manifest.rangeSyncRetryProfile !== 'status0-backoff-4x-45s-timeout-escalate-v2'
) {
  fail('runtime.json 没有声明 PSP 自适应滚动预读策略')
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
if (manifest.pthreadAudioContext !== 'shared-ring-buffer-worklet-fade-v2') {
  fail('runtime.json 没有声明 AudioWorklet 共享音频桥；页面主线程卡顿会造成 PSP 爆音')
}
if (
  manifest.performanceProfile !== 'adaptive-performance-first-device-v1' ||
  manifest.maxCanvasPixels !== 293760 ||
  manifest.canvasLimitProfile !== 'qq/mobile/weak/low=480x272;default=640x360;highEndDesktop=720x408' ||
  manifest.workerErrorDiagnostics !== 'stack-v1' ||
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
const installed = binaries.every((name) => existsSync(join(runtimeCoreDir, name)))
const productionEnv = existsSync(join(root, '.env.production'))
  ? readFileSync(join(root, '.env.production'), 'utf8')
  : ''
const productionEnabled = /^VITE_PPSSPP_PATH\s*=\s*\S+/m.test(productionEnv)
if ((!sourceOnly || productionEnabled) && !installed) {
  fail('核心二进制尚未安装；先运行 npm run ppsspp:build -- --source <源码目录>')
}
if (installed) {
  if (!manifest.artifactsInstalled || !manifest.artifacts) fail('已有二进制，但 runtime.json 没有来源/哈希清单')
  const runtimeScript = need(join(runtimeCoreDir, 'PPSSPPSDL.js')).toString('utf8')
  if (!runtimeScript.includes('__8bitgoPspCanvasSize') || !runtimeScript.includes('var qqBrowser=') ||
    !runtimeScript.includes('var mobileDevice=') || !runtimeScript.includes('var highEndDesktop=') ||
    !runtimeScript.includes('maxWidth=qqBrowser||mobileDevice||slow||low?480:highEndDesktop?720:640') ||
    !runtimeScript.includes('e.error?.stack')) {
    fail('v33 核心缺少实际画布自适应上限、QQ/移动档或 pthread worker 错误栈采集')
  }
    if (!runtimeScript.includes('__8bitgoPspRangeUrls')) fail('v33 核心没有在同步 Range 失败后切换备用 ROM 线路')
  // v128 不能跨 Wasm/JS 边界：GamepadEmuView 的两个 invoke_ 必须走 Wasm 跳板，否则打开 PPSSPP 屏幕触控即崩
  // （QQ Browser 21 现场 type incompatibility when transforming from/to JS）。详见 test-ppsspp-simd-trampoline.mjs。
  if (!runtimeScript.includes('function getWasmImports(){assignWasmImports();__8bitgoInstallSimdTrampolines(wasmImports);') ||
    !runtimeScript.includes('assignWasmExports(wasmExports);__8bitgoFillSimdTrampolineTable();') ||
    manifest.v128InvokeProfile !== 'wasm-call-indirect-trampoline-v1') {
    fail('v33 核心没有给 v128 invoke 导入装 Wasm 跳板')
  }
  const readAheadSource = need(join(root, 'vendor', 'ppsspp', 'range-read-ahead.js')).toString('utf8').trimEnd()
  if (!runtimeScript.includes(readAheadSource)) {
    fail('v33 发布脚本与预读源码不一致；改源码后必须生成新实体运行时')
  }
  if (!runtimeScript.includes('if(fetched?.then){fetched=await fetched}else if(!fetched){fetched=await fetchPromise}')) {
    fail('PPSSPPSDL.js 没有等待异步核心资源重试 Promise，真机解包会报 bad input')
  }
  for (const marker of [
    '__8bitgoCreatePspRangeXhr',
    '__8bitgoPspRangeWarmStats',
    'MAX_RANGE_TIMEOUT_MS = 180_000',
    'rangeTimeoutMs: rangeTimeoutMs(BLOCK_BYTES)',
    'MAX_CONCURRENCY = 4',
    'MAX_CACHE_BYTES = 24 * 1024 * 1024',
    'cancelQueuedAndInflight()',
    'demandTakeovers',
    'sharedPrefetchWaits',
    '__8bitgoRangeBrokerPort',
    'prefetchWorkerIsShared',
    'new Uint8Array(stateBuffer, 8).slice()',
    'worker.__8bitgoRangeBrokerPort=rangeChannel.port2',
    'loadMessage.rangeBrokerPort=rangeBrokerPort',
    'status === -1',
    'new Worker(workerUrl)',
    'otherKey !== key',
    // v16：romv 钉代次的 Range 不发条件头，浏览器 HTTP 缓存才接得住重复读取
    'const versionPinned = ',
    'validatorHeader(name) && versionPinned(this.url_)',
    'sendValidators: !versionPinned(job.url)',
  ]) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 PSP 顺序预读标记 ${marker}`)
  }
  for (const marker of [
    'postMessage({ type: \'ready\' })',
    'Atomics.notify(client.state, 0)',
    'response.status !== 206',
    'offset !== task.bytes.byteLength',
    'job.sendValidators !== false',
    'jobsByKey',
    'jobsById',
    'task.clients.set(client.id, client)',
    "data?.cmd === 'connect'",
    'connect(port)',
    'port.postMessage({ type: \'ready\' })',
  ]) {
    if (!prefetchWorker.includes(marker)) fail(`range-prefetch-worker.js 缺少共享预读校验标记 ${marker}`)
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
    const runtimeWasm = need(join(runtimeCoreDir, 'PPSSPPSDL.wasm')).toString('latin1')
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
    const bytes = need(join(runtimeCoreDir, name))
    const expected = manifest.artifacts[name]
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!expected || expected.bytes !== bytes.byteLength || expected.sha256 !== hash) fail(`${name} 与 runtime.json 校验值不符`)
  }
}

if (installed) {
  /*
    源站对接受 br 的浏览器直接吐 PPSSPPSDL.data.br（server/src/precompressed-static.js）。
    它解开必须就是清单里的那份 data —— 过期的 .br 会让核心拿到错的资源包，解包直接失败。
  */
  const brPath = join(runtimeCoreDir, 'PPSSPPSDL.data.br')
  if (!existsSync(brPath)) fail('缺少 PPSSPPSDL.data.br；运行 npm run ppsspp:precompress（data 明文 19MB，Cloudflare 不压 octet-stream）')
  let decoded
  try {
    decoded = brotliDecompressSync(readFileSync(brPath))
  } catch {
    fail('PPSSPPSDL.data.br 不是合法的 Brotli 流')
  }
  if (createHash('sha256').update(decoded).digest('hex') !== manifest.artifacts['PPSSPPSDL.data'].sha256) {
    fail('PPSSPPSDL.data.br 解开后与 runtime.json 的 data 哈希不符；重跑 npm run ppsspp:precompress')
  }
}

if (installed && loaderRevision === 1) {
  console.warn('⚠ PPSSPP 仍是 Range v1 二进制：桥层修复已生效；96MB 缓存、对象校验与原生遥测要在下一次 ppsspp:build 后生效')
}

if (useDist) {
  for (const name of ['index.html', 'host.js', 'audio-worklet.js', 'range-prefetch-worker.js', 'local-disc-sw.js', 'runtime.json', 'SOURCE.txt']) {
    const a = need(join(publicDir, name))
    const b = need(join(runtimeDir, name))
    if (!a.equals(b)) fail(`dist/client 中的 ${name} 不是 public 里的当前版本`)
  }
  for (const name of binaries) {
    const a = need(join(publicCoreDir, name))
    const b = need(join(runtimeCoreDir, name))
      if (!a.equals(b)) fail(`dist/client 中的核心 ${name} 不是 public v33 里的当前版本`)
  }
}

console.log(`✔ PPSSPP ${sourceOnly && !installed ? '源码接入' : 'Range 运行时'}检查通过${useDist ? '（dist）' : ''}`)
