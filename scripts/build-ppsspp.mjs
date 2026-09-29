#!/usr/bin/env node
/**
 * 构建带 8BitGo HTTP Range 补丁的 PPSSPP WebAssembly。
 *
 * 用法：
 *   npm run ppsspp:build -- --source /path/to/ppsspp-wasm
 *
 * 源码必须停在 PINNED_COMMIT。脚本会幂等应用 vendor 下的补丁、初始化子模块、调用
 * Emscripten 5.0.7 构建，再把同一批 js/wasm/data/worker 复制进版本目录并写 SHA-256。
 * 不自动清理源码或构建目录：磁盘空间紧张时也不能擅自删除开发者已有的工作。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { installPspRangeReadAhead } from './helpers/ppsspp-runtime-patch.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const RUNTIME_GENERATION = 'v8'
const RANGE_LOADER_REVISION = 4
const PINNED_COMMIT = '0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a'
const PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0001-range-streaming.patch')
const SDL_AUDIO_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0002-sdl2-pthread-audio.patch')
const PTHREAD_AUDIO_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0003-pthread-audio-ring.patch')
const PROXIED_WEBGL_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0004-emscripten-proxied-webgl-preloop.patch')
const WEB_FEATURES_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0005-web-save-controls-bridge.patch')
const PERFORMANCE_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0006-web-performance.patch')
const CHD_RANGE_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0007-chd-range-performance.patch')
const COLD_START_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0008-web-cold-start.patch')
const WORKER_CANVAS_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0009-worker-offscreen-canvas.patch')
const WASM_FFMPEG_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0010-wasm-ffmpeg.patch')
const RANGE_READ_AHEAD_SOURCE = join(root, 'vendor', 'ppsspp', 'range-read-ahead.js')
const OUTPUT = join(root, 'public', 'ppsspp', `v${VERSION}`, RUNTIME_GENERATION)
const FFMPEG_COMMIT = '1e3b4965632f60b1d85360261d1b9dd45444bc71'
const FFMPEG_LIBRARIES = ['avcodec', 'avformat', 'avutil', 'swresample', 'swscale']
const args = process.argv.slice(2)
const installExisting = args.includes('--install-existing')
const sourceAt = args.indexOf('--source')
const source = resolve(sourceAt >= 0 ? args[sourceAt + 1] || '' : process.env.PPSSPP_SOURCE_DIR || '')

const fail = (message) => {
  console.error(`✖ PPSSPP 构建失败：${message}`)
  process.exit(1)
}

const run = (command, commandArgs, cwd = source) => {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) fail(`${command} 无法执行：${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}`)
}

const capture = (command, commandArgs, cwd = source) => {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8' })
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} 执行失败：${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

if (!source || source === resolve('')) fail('请用 --source 指向 root-hunter/ppsspp-wasm 的检出目录')
if (!existsSync(join(source, '.git')) || !existsSync(join(source, 'CMakeLists.txt'))) fail(`${source} 不是 PPSSPP 源码目录`)
if (!existsSync(PATCH)) fail(`补丁不存在：${PATCH}`)
if (!existsSync(SDL_AUDIO_PATCH)) fail(`SDL 音频补丁不存在：${SDL_AUDIO_PATCH}`)
if (!existsSync(PTHREAD_AUDIO_PATCH)) fail(`pthread 音频桥补丁不存在：${PTHREAD_AUDIO_PATCH}`)
if (!existsSync(PROXIED_WEBGL_PATCH)) fail(`WebGL 代理补丁不存在：${PROXIED_WEBGL_PATCH}`)
if (!existsSync(WEB_FEATURES_PATCH)) fail(`浏览器存档/改键桥补丁不存在：${WEB_FEATURES_PATCH}`)
if (!existsSync(PERFORMANCE_PATCH)) fail(`浏览器性能补丁不存在：${PERFORMANCE_PATCH}`)
if (!existsSync(CHD_RANGE_PATCH)) fail(`CHD Range 性能补丁不存在：${CHD_RANGE_PATCH}`)
if (!existsSync(COLD_START_PATCH)) fail(`Web 冷启动补丁不存在：${COLD_START_PATCH}`)
if (!existsSync(WORKER_CANVAS_PATCH)) fail(`Worker OffscreenCanvas 补丁不存在：${WORKER_CANVAS_PATCH}`)
if (!existsSync(WASM_FFMPEG_PATCH)) fail(`Web FFmpeg 补丁不存在：${WASM_FFMPEG_PATCH}`)
if (!existsSync(RANGE_READ_AHEAD_SOURCE)) fail(`Range 顺序预读源码不存在：${RANGE_READ_AHEAD_SOURCE}`)
if (capture('git', ['rev-parse', 'HEAD']) !== PINNED_COMMIT) {
  fail(`源码提交不匹配，必须是 ${PINNED_COMMIT}；不要在未知上游版本上硬套二进制补丁`)
}

if (!existsSync(join(source, 'Core', 'FileLoaders', 'WasmRangeFileLoader.cpp'))) {
  run('git', ['apply', '--check', PATCH])
  run('git', ['apply', PATCH])
} else {
  const loader = readFileSync(join(source, 'Core', 'FileLoaders', 'WasmRangeFileLoader.cpp'), 'utf8')
  for (const marker of ['__ppssppRangeProgress', '__ppssppRangeError', 'If-Match', 'If-Unmodified-Since']) {
    if (!loader.includes(marker)) {
      fail(`源码目录里已有旧版 Range 补丁（缺少 ${marker}）；请改用停在锁定提交的干净检出目录重新构建`)
    }
  }
}

const sdlMain = join(source, 'SDL', 'SDLMain.cpp')
const sdlMainText = readFileSync(sdlMain, 'utf8')
if (!sdlMainText.includes('Wasm audio bridge started')) {
  run('git', ['apply', '--check', PTHREAD_AUDIO_PATCH])
  run('git', ['apply', PTHREAD_AUDIO_PATCH])
} else if (
  !sdlMainText.includes("Module['__ppssppAudio']") ||
  !sdlMainText.includes('PumpWasmAudioBridge()') ||
  !sdlMainText.includes('每帧重复设置同一个定时器只会增加 Worker 调度抖动')
) {
  fail('源码目录里已有旧版 pthread 音频桥；请改用停在锁定提交的干净检出目录重新构建')
}

const sdlMainAfterAudio = readFileSync(sdlMain, 'utf8')
if (!sdlMainAfterAudio.includes('__ppssppBridgeSetCommand')) {
  run('git', ['apply', '--check', WEB_FEATURES_PATCH])
  run('git', ['apply', WEB_FEATURES_PATCH])
} else if (
  !sdlMainAfterAudio.includes('__ppssppBridgePopupOpen') ||
  !sdlMainAfterAudio.includes('SaveState::SaveSlot(prefix, 0') ||
  !sdlMainAfterAudio.includes('UIMessage::SHOW_CONTROL_MAPPING')
) {
  fail('源码目录里已有旧版浏览器存档/改键桥；请改用停在锁定提交的干净检出目录重新构建')
}

const performanceMarkers = [
  ['SDL/SDLMain.cpp', 'AudioWorkletNode'],
  ['SDL/SDLMain.cpp', 'ReportWasmPerformance'],
  ['SDL/SDLMain.cpp', 'ALLOW_HIGHDPI 会让 SDL 再乘一次 DPR'],
  ['CMakeLists.txt', 'Math.min(8,Math.max(4,navigator.hardwareConcurrency||4))'],
  ['Makefile', '-DWASM_ENABLE_LTO=ON'],
  ['Core/Config.cpp', 'Web display side: %d pixels. Choosing scale %d'],
]
if (!performanceMarkers.every(([name, marker]) => readFileSync(join(source, name), 'utf8').includes(marker))) {
  run('git', ['apply', '--check', PERFORMANCE_PATCH])
  run('git', ['apply', PERFORMANCE_PATCH])
}
for (const [name, marker] of performanceMarkers) {
  if (!readFileSync(join(source, name), 'utf8').includes(marker)) {
    fail(`性能补丁没有完整应用：${name} 缺少 ${marker}`)
  }
}

const rangeLoaderSource = join(source, 'Core', 'FileLoaders', 'WasmRangeFileLoader.cpp')
const rangeLoaderHeader = join(source, 'Core', 'FileLoaders', 'WasmRangeFileLoader.h')
if (!readFileSync(rangeLoaderSource, 'utf8').includes('CHD_BLOCK_BYTES')) {
  run('git', ['apply', '--check', CHD_RANGE_PATCH])
  run('git', ['apply', CHD_RANGE_PATCH])
}
if (!readFileSync(rangeLoaderSource, 'utf8').includes('blockBytes_ = CHD_BLOCK_BYTES')) {
  fail('CHD Range 性能补丁没有完整应用')
}

const cmakeSource = join(source, 'CMakeLists.txt')
const coldStartApplied = readFileSync(cmakeSource, 'utf8').includes('*/assets/debugger/*') &&
  readFileSync(rangeLoaderHeader, 'utf8').includes('CHD_BLOCK_BYTES = 2 * 1024 * 1024')
if (!coldStartApplied) {
  run('git', ['apply', '--check', COLD_START_PATCH])
  run('git', ['apply', COLD_START_PATCH])
}
if (
  !readFileSync(cmakeSource, 'utf8').includes('*/assets/debugger/*') ||
  !readFileSync(rangeLoaderHeader, 'utf8').includes('CHD_BLOCK_BYTES = 2 * 1024 * 1024')
) {
  fail('Web 冷启动补丁没有完整应用')
}

const workerCanvasApplied = readFileSync(cmakeSource, 'utf8').includes('-sOFFSCREENCANVAS_SUPPORT=1') &&
  readFileSync(join(source, 'SDL', 'SDLGLGraphicsContext.cpp'), 'utf8')
    .includes('EMSCRIPTEN_WEBGL_CONTEXT_PROXY_FALLBACK')
if (!workerCanvasApplied) {
  run('git', ['apply', '--check', WORKER_CANVAS_PATCH])
  run('git', ['apply', WORKER_CANVAS_PATCH])
}
if (
  !readFileSync(cmakeSource, 'utf8').includes('-sOFFSCREENCANVAS_SUPPORT=1') ||
  !readFileSync(join(source, 'SDL', 'SDLGLGraphicsContext.cpp'), 'utf8')
    .includes('attrs.proxyContextToMainThread = EMSCRIPTEN_WEBGL_CONTEXT_PROXY_FALLBACK')
) {
  fail('Worker OffscreenCanvas 补丁没有完整应用')
}

const makefileSource = join(source, 'Makefile')
if (!readFileSync(makefileSource, 'utf8').includes('WASM_USE_FFMPEG ?= OFF')) {
  run('git', ['apply', '--check', WASM_FFMPEG_PATCH])
  run('git', ['apply', WASM_FFMPEG_PATCH])
}
if (
  !readFileSync(makefileSource, 'utf8').includes('-DUSE_FFMPEG=$(WASM_USE_FFMPEG)') ||
  !readFileSync(makefileSource, 'utf8').includes('-DFFMPEG_DIR=$(WASM_FFMPEG_DIR)')
) {
  fail('Web FFmpeg 补丁没有完整应用')
}

if (!args.includes('--skip-submodules')) {
  run('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'])
}

const emcmake = spawnSync('emcmake', ['cmake', '--version'], { encoding: 'utf8' })
if (emcmake.error || emcmake.status !== 0) {
  fail('找不到 emcmake。请安装并激活 Emscripten 5.0.7；上游 CI 也固定使用这一版。')
}
const emcc = spawnSync('emcc', ['--version'], { encoding: 'utf8' })
const emccVersion = `${emcc.stdout || ''}\n${emcc.stderr || ''}`
if (emcc.error || emcc.status !== 0 || !/\b5\.0\.7\b/.test(emccVersion)) {
  fail('Emscripten 版本必须是 5.0.7；不同版本会改变 pthread 胶水与 WASM ABI，不能混用。')
}

const ffmpegSource = join(source, 'ffmpeg')
const ffmpegBuildDir = join(source, 'build-wasm-ffmpeg')
const ffmpegInstallDir = join(ffmpegBuildDir, 'install')
if (!installExisting) {
  if (!existsSync(join(ffmpegSource, 'configure'))) {
    fail('FFmpeg 子模块没有初始化；不要用 --skip-submodules，或先手工初始化锁定的 ffmpeg 子模块')
  }
  if (capture('git', ['rev-parse', 'HEAD'], ffmpegSource) !== FFMPEG_COMMIT) {
    fail(`FFmpeg 子模块提交不匹配，必须是 ${FFMPEG_COMMIT}`)
  }
  mkdirSync(ffmpegBuildDir, { recursive: true })
  const ffmpegArchivesReady = FFMPEG_LIBRARIES.every((name) => existsSync(join(ffmpegInstallDir, 'lib', `lib${name}.a`)))
  if (!ffmpegArchivesReady) {
    // PSP 游戏里的 PSMF/PMP 视频只需要 H.264 与四种常见音频；裁掉编码器、网络和设备，
    // 否则 Web 核心会无谓增加几十 MB，启动时间也会明显变长。
    run('emconfigure', [join(ffmpegSource, 'configure'),
      `--prefix=${ffmpegInstallDir}`,
      '--cc=emcc', '--cxx=em++', '--ar=emar', '--ranlib=emranlib', '--nm=emnm',
      '--enable-cross-compile', '--target-os=none', '--arch=wasm32',
      '--disable-asm', '--disable-inline-asm', '--disable-stripping',
      '--disable-programs', '--disable-doc', '--disable-debug', '--disable-network',
      '--disable-avdevice', '--disable-avfilter', '--disable-postproc', '--disable-hwaccels',
      '--disable-encoders', '--disable-muxers', '--disable-filters', '--disable-bsfs',
      '--disable-devices', '--disable-protocols', '--disable-demuxers', '--disable-decoders',
      '--disable-parsers', '--disable-xlib', '--disable-iconv',
      '--enable-demuxer=mpegps,mpegvideo,h264,pmp,aac,mp3',
      '--enable-decoder=h264,aac,atrac3,atrac3p,mp3,mp3float',
      '--enable-parser=h264,aac,mpegaudio',
      '--extra-cflags=-pthread', '--extra-cxxflags=-pthread', '--extra-ldflags=-pthread',
    ], ffmpegBuildDir)
    const ffmpegJobs = process.env.PPSSPP_JOBS || `-j${Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || 4)}`
    run('make', [ffmpegJobs], ffmpegBuildDir)
    run('make', ['install'], ffmpegBuildDir)
  }
  const ffmpegConfig = readFileSync(join(ffmpegBuildDir, 'config.h'), 'utf8')
  for (const marker of [
    'CONFIG_H264_DECODER 1',
    'CONFIG_AAC_DECODER 1',
    'CONFIG_ATRAC3_DECODER 1',
    'CONFIG_ATRAC3P_DECODER 1',
    'CONFIG_MP3_DECODER 1',
    'CONFIG_H264_PARSER 1',
  ]) {
    if (!ffmpegConfig.includes(marker)) fail(`精简 FFmpeg 缺少 ${marker}`)
  }
}

// SDL 的 WebAudio 驱动会在主线程创建 AudioContext，却曾在 pthread 里直接读取采样率。
// 先让 embuilder 解出端口源码，再把唯一漏掉的读取也代理回主线程；删除精确的 mt 缓存库后，
// 后面的 PPSSPP 链接会自动重编 SDL。这样构建机清缓存或重装 emsdk 后不会把崩溃带回来。
const emccPath = realpathSync(capture('which', ['emcc'], root))
const emscriptenRoot = dirname(emccPath)
const webglSource = join(emscriptenRoot, 'src', 'lib', 'libwebgl.js')
if (!existsSync(webglSource)) fail(`找不到 Emscripten WebGL 库源码：${webglSource}`)
const webglSourceText = readFileSync(webglSource, 'utf8')
if (!webglSourceText.includes('if (!GL.currentContextIsProxied) GL.newRenderingFrameStarted();')) {
  if (!webglSourceText.includes('registerPreMainLoop(() => GL.newRenderingFrameStarted());')) {
    fail('Emscripten WebGL 预帧钩子与锁定版本不符，拒绝在未知源码上套补丁')
  }
  // FULL_ES3 会启用本地 VBO 双缓冲钩子，但代理到主线程的上下文在 Worker 里只是整数令牌；
  // 第一帧若把令牌当上下文对象写入就会崩溃，所以只跳过代理上下文的本地维护。
  run('patch', ['--dry-run', '-p1', '-i', PROXIED_WEBGL_PATCH], emscriptenRoot)
  run('patch', ['-p1', '-i', PROXIED_WEBGL_PATCH], emscriptenRoot)
}
const sdlPortsRoot = join(emscriptenRoot, 'cache', 'ports', 'sdl2')
if (!existsSync(sdlPortsRoot)) run('embuilder', ['build', 'sdl2'], root)
const sdlSourceDir = readdirSync(sdlPortsRoot, { withFileTypes: true })
  .find((entry) => entry.isDirectory() && entry.name.startsWith('SDL-release-'))?.name
if (!sdlSourceDir) fail(`找不到 Emscripten SDL2 端口源码：${sdlPortsRoot}`)
const sdlSource = join(sdlPortsRoot, sdlSourceDir)
const sdlAudioSource = join(sdlSource, 'src', 'audio', 'emscripten', 'SDL_emscriptenaudio.c')
if (!existsSync(sdlAudioSource)) fail(`找不到 SDL WebAudio 源码：${sdlAudioSource}`)
const sdlAudioText = readFileSync(sdlAudioSource, 'utf8')
if (!/this->spec\.freq\s*=\s*MAIN_THREAD_EM_ASM_INT\s*\(/.test(sdlAudioText)) {
  if (!/this->spec\.freq\s*=\s*EM_ASM_INT\s*\(/.test(sdlAudioText)) {
    fail('SDL WebAudio 采样率代码与锁定版本不符，拒绝在未知源码上套补丁')
  }
  // 端口源码位于 emscripten 仓库的 ignored cache 下，`git apply` 会把它当成未跟踪路径跳过；
  // POSIX patch 以端口源码目录为根，才能真正修改这份生成缓存。
  run('patch', ['--dry-run', '-p1', '-i', SDL_AUDIO_PATCH], sdlSource)
  run('patch', ['-p1', '-i', SDL_AUDIO_PATCH], sdlSource)
}
const buildDir = join(source, 'build-wasm-release')
if (!installExisting) {
  const cmakeCachePath = join(buildDir, 'CMakeCache.txt')
  const expectedFfmpegDir = `FFMPEG_DIR:UNINITIALIZED=${ffmpegInstallDir}`
  const cachedFfmpegPathsArePinned = (cache) => cache.includes(expectedFfmpegDir) &&
    FFMPEG_LIBRARIES.every((name) => cache.includes(
      `FFmpeg_LIBRARY_${name}:FILEPATH=${join(ffmpegInstallDir, 'lib', `lib${name}.a`)}`,
    ))
  if (existsSync(cmakeCachePath) && !cachedFfmpegPathsArePinned(readFileSync(cmakeCachePath, 'utf8'))) {
    // CMake 会把每个 av* 静态库的绝对路径各自缓存；只更新 FFMPEG_DIR 仍可能链接上一套库。
    // CMakeCache 是可再生构建状态，路径改变时丢弃它才能保证锁定子模块真正进入最终 Wasm。
    unlinkSync(cmakeCachePath)
  }
  const sdlThreadedArchive = join(emscriptenRoot, 'cache', 'sysroot', 'lib', 'wasm32-emscripten', 'libSDL2-mt.a')
  if (existsSync(sdlThreadedArchive)) unlinkSync(sdlThreadedArchive)
  // Emscripten 端口库不是 CMake 的显式输入；只删 libSDL2-mt.a 时，旧的最终产物仍可能被判定为最新。
  // 精确删掉可再生的链接产物，确保本次一定把修过的 SDL 静态库链接进去。
  for (const name of ['PPSSPPSDL.js', 'PPSSPPSDL.wasm']) {
    const artifact = join(buildDir, name)
    if (existsSync(artifact)) unlinkSync(artifact)
  }

  const jobs = process.env.PPSSPP_JOBS || `-j${Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || 4)}`
  run('make', [
    'wasm-release',
    'CMAKE=cmake',
    `WASM_JOBS=${jobs}`,
    'WASM_USE_FFMPEG=ON',
    `WASM_FFMPEG_DIR=${ffmpegInstallDir}`,
  ])
} else {
  console.log('ℹ 使用 build-wasm-release 中现有产物，仅执行完整性验收与安装')
}

const cmakeCache = readFileSync(join(buildDir, 'CMakeCache.txt'), 'utf8')
if (!cmakeCache.includes('USE_FFMPEG:BOOL=ON')) {
  fail('build-wasm-release 没有启用 FFmpeg；PSP 开场 H.264 视频会显示为彩色花屏')
}
if (!installExisting && !FFMPEG_LIBRARIES.every((name) => cmakeCache.includes(
  `FFmpeg_LIBRARY_${name}:FILEPATH=${join(ffmpegInstallDir, 'lib', `lib${name}.a`)}`,
))) {
  fail('PPSSPP 没有链接锁定子模块构建出的 FFmpeg 静态库')
}

// Emscripten 5 的 pthread 入口复用主 JS（pthreadMainJs = _scriptName），不会再生成
// 单独的 *.worker.js。这里必须验主 JS 的自举标记，不能靠一个并不存在的第四文件判断线程支持。
const names = ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data']
for (const name of names) {
  if (!existsSync(join(buildDir, name))) fail(`构建完成但缺少 ${join(buildDir, name)}`)
}
const runtimeScriptPath = join(buildDir, 'PPSSPPSDL.js')
let runtimeScript = readFileSync(runtimeScriptPath, 'utf8')
const asyncPackageNeedle = 'if(!fetched){fetched=await fetchPromise}processPackageData(fetched)'
const asyncPackageReplacement = 'if(fetched?.then){fetched=await fetched}else if(!fetched){fetched=await fetchPromise}processPackageData(fetched)'
if (runtimeScript.includes(asyncPackageNeedle)) {
  // Emscripten 5 会直接把 getPreloadedPackage 的返回值交给解包器；网络重试必然是异步的，
  // 所以生成物必须显式等待 Promise。只改这一处稳定片段，未知生成器输出一律拒绝发布。
  runtimeScript = runtimeScript.replace(asyncPackageNeedle, asyncPackageReplacement)
  writeFileSync(runtimeScriptPath, runtimeScript)
} else if (!runtimeScript.includes(asyncPackageReplacement)) {
  fail('PPSSPPSDL.js 的预加载器结构与锁定的 Emscripten 5.0.7 不符，无法安全接入异步重试')
}
try {
  runtimeScript = installPspRangeReadAhead(
    runtimeScript,
    readFileSync(RANGE_READ_AHEAD_SOURCE, 'utf8'),
  )
  writeFileSync(runtimeScriptPath, runtimeScript)
} catch (error) {
  fail(`无法接入 PSP 顺序预读：${error instanceof Error ? error.message : String(error)}`)
}
if (!runtimeScript.includes('pthreadMainJs=_scriptName') || !runtimeScript.includes('new Worker(pthreadMainJs')) {
  fail('PPSSPPSDL.js 缺少 Emscripten 5 自身 Worker 启动标记，PROXY_TO_PTHREAD 可能没有生效')
}
if (!runtimeScript.includes('createOffscreenFramebuffer') || !runtimeScript.includes('renderViaOffscreenBackBuffer')) {
  fail('PPSSPPSDL.js 缺少 OffscreenFramebuffer 回退；不支持 Worker WebGL 的浏览器将无法呈现')
}
if (!runtimeScript.includes('transferControlToOffscreen') || !runtimeScript.includes('offscreenCanvases')) {
  fail('PPSSPPSDL.js 缺少 Worker OffscreenCanvas 转交；所有 GL 指令会继续走已知错误的主线程代理路径')
}
if (!/registerPreMainLoop\(\(\)=>\{if\(!GL\.currentContextIsProxied\)GL\.newRenderingFrameStarted\(\)/.test(runtimeScript)) {
  fail('PPSSPPSDL.js 缺少代理 WebGL 上下文预帧保护；FULL_ES3 会在首帧把整数令牌当对象写入并崩溃')
}
for (const marker of ['proxyContextToMainThread', 'emscripten_webgl_do_create_context']) {
  if (!runtimeScript.includes(marker)) {
    fail(`PPSSPPSDL.js 缺少 WebGL Worker 代理标记 ${marker}；SDL/EGL 单独建上下文会让 pthread 的 GLctx 为空`)
  }
}
if (!runtimeScript.includes('IDBFS') || !/FS\.filesystems=\{[^}]*IDBFS[^}]*\}/.test(runtimeScript)) {
  fail('PPSSPPSDL.js 没有链接 IDBFS；这份产物会在存档挂载阶段中止启动')
}
if (runtimeScript.includes('/assets/debugger/')) {
  fail('PPSSPPSDL.data 仍包含浏览器播放器不会使用的远程调试器资源')
}
for (const marker of ['__ppssppRangeProgress', '__ppssppRangeError']) {
  if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 Range v${RANGE_LOADER_REVISION} 标记 ${marker}，核心补丁可能没有编进产物`)
}
for (const marker of ['__8bitgoCreatePspRangeXhr', '__8bitgoPspRangeWarmStats']) {
  if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 Range 顺序预读标记 ${marker}`)
}
for (const marker of ['__ppssppAudio', 'AudioWorkletNode', 'ppsspp-audio', 'createScriptProcessor', '__ppssppPerformance']) {
  if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 pthread 共享音频桥标记 ${marker}`)
}
for (const marker of ['__ppssppBridgeSetCommand', '__ppssppBridgePopupOpen', '__ppssppNativeResult']) {
  if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 PSP 存档/改键桥标记 ${marker}`)
}
const runtimeWasm = readFileSync(join(buildDir, 'PPSSPPSDL.wasm')).toString('latin1')
for (const marker of ['If-Match', 'If-Unmodified-Since', 'HTTP Range offset overflow']) {
  if (!runtimeWasm.includes(marker)) fail(`PPSSPPSDL.wasm 缺少 Range v${RANGE_LOADER_REVISION} 标记 ${marker}，核心补丁可能没有编进产物`)
}
if (!runtimeWasm.includes('H.264')) {
  fail('PPSSPPSDL.wasm 缺少 H.264 解码器标记；PSP 游戏视频仍会花屏')
}

mkdirSync(OUTPUT, { recursive: true })
const artifacts = {}
for (const name of names) {
  const from = join(buildDir, name)
  const to = join(OUTPUT, name)
  copyFileSync(from, to)
  const bytes = readFileSync(to)
  artifacts[name] = {
    bytes: statSync(to).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

const manifest = {
  runtime: 'PPSSPP WebAssembly',
  runtimeGeneration: RUNTIME_GENERATION,
  upstream: 'https://github.com/root-hunter/ppsspp-wasm',
  commit: PINNED_COMMIT,
  emscripten: '5.0.7',
  rangeStreaming: true,
  rangeLoaderRevision: RANGE_LOADER_REVISION,
  blockBytes: 2 * 1024 * 1024,
  chdBlockBytes: 2 * 1024 * 1024,
  memoryCacheBytes: 96 * 1024 * 1024,
  rangeTelemetry: true,
  objectValidator: 'etag-or-last-modified',
  workerModel: 'self-script',
  offscreenCanvas: true,
  offscreenFramebuffer: 'fallback',
  webglContext: 'worker-offscreen-canvas-with-proxy-fallback',
  proxiedWebglPreloop: 'fallback-skip-worker-token',
  pthreadAudioContext: 'shared-ring-buffer-worklet',
  performanceProfile: 'adaptive-canvas-v1',
  maxCanvasPixels: 960 * 544,
  pthreadPoolMax: 8,
  lto: true,
  performanceTelemetry: true,
  inputLatencyProfile: 'inflight-2-vsync-off-buffered-native',
  graphicsCompatibilityProfile: 'buffered-native-v1',
  startupReadinessProfile: 'core-boot-log-v1',
  preloadAssetsProfile: 'runtime-no-debugger',
  rangeReadAheadProfile: 'adaptive-sequential-v1',
  rangeReadAheadBlocks: 2,
  rangeReadAheadCacheBytes: 8 * 1024 * 1024,
  webFeaturesBridge: 'savestate-controls-v1',
  mediaEngine: 'ffmpeg-h264-audio-minimal',
  ffmpegCommit: FFMPEG_COMMIT,
  mediaDecoders: ['h264', 'aac', 'atrac3', 'atrac3p', 'mp3', 'mp3float'],
  artifactsInstalled: true,
  artifacts,
}
writeFileSync(join(OUTPUT, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`✔ PPSSPP Range 运行时已写入 ${OUTPUT}`)
console.log(`  ${Object.entries(artifacts).map(([name, info]) => `${basename(name)} ${info.bytes}B`).join(' · ')}`)
