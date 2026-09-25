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

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const RANGE_LOADER_REVISION = 2
const PINNED_COMMIT = '0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a'
const PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0001-range-streaming.patch')
const SDL_AUDIO_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0002-sdl2-pthread-audio.patch')
const PTHREAD_AUDIO_PATCH = join(root, 'vendor', 'ppsspp', 'patches', '0003-pthread-audio-ring.patch')
const OUTPUT = join(root, 'public', 'ppsspp', `v${VERSION}`)
const args = process.argv.slice(2)
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
} else if (!sdlMainText.includes("Module['__ppssppAudio']") || !sdlMainText.includes('PumpWasmAudioBridge()')) {
  fail('源码目录里已有旧版 pthread 音频桥；请改用停在锁定提交的干净检出目录重新构建')
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

// SDL 的 WebAudio 驱动会在主线程创建 AudioContext，却曾在 pthread 里直接读取采样率。
// 先让 embuilder 解出端口源码，再把唯一漏掉的读取也代理回主线程；删除精确的 mt 缓存库后，
// 后面的 PPSSPP 链接会自动重编 SDL。这样构建机清缓存或重装 emsdk 后不会把崩溃带回来。
const emccPath = realpathSync(capture('which', ['emcc'], root))
const emscriptenRoot = dirname(emccPath)
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
const sdlThreadedArchive = join(emscriptenRoot, 'cache', 'sysroot', 'lib', 'wasm32-emscripten', 'libSDL2-mt.a')
if (existsSync(sdlThreadedArchive)) unlinkSync(sdlThreadedArchive)
const buildDir = join(source, 'build-wasm-release')
// Emscripten 端口库不是 CMake 的显式输入；只删 libSDL2-mt.a 时，旧的最终产物仍可能被判定为最新。
// 精确删掉可再生的链接产物，确保本次一定把修过的 SDL 静态库链接进去。
for (const name of ['PPSSPPSDL.js', 'PPSSPPSDL.wasm']) {
  const artifact = join(buildDir, name)
  if (existsSync(artifact)) unlinkSync(artifact)
}

const jobs = process.env.PPSSPP_JOBS || `-j${Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || 4)}`
run('make', ['wasm-release', 'CMAKE=cmake', `WASM_JOBS=${jobs}`])

// Emscripten 5 的 pthread 入口复用主 JS（pthreadMainJs = _scriptName），不会再生成
// 单独的 *.worker.js。这里必须验主 JS 的自举标记，不能靠一个并不存在的第四文件判断线程支持。
const names = ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data']
for (const name of names) {
  if (!existsSync(join(buildDir, name))) fail(`构建完成但缺少 ${join(buildDir, name)}`)
}
const runtimeScript = readFileSync(join(buildDir, 'PPSSPPSDL.js'), 'utf8')
if (!runtimeScript.includes('pthreadMainJs=_scriptName') || !runtimeScript.includes('new Worker(pthreadMainJs')) {
  fail('PPSSPPSDL.js 缺少 Emscripten 5 自身 Worker 启动标记，PROXY_TO_PTHREAD 可能没有生效')
}
if (!runtimeScript.includes('createOffscreenFramebuffer') || !runtimeScript.includes('renderViaOffscreenBackBuffer')) {
  fail('PPSSPPSDL.js 缺少 OffscreenFramebuffer 支持；pthread 的 GL 调用无法安全代理到主线程')
}
if (runtimeScript.includes('transferControlToOffscreen')) {
  fail('PPSSPPSDL.js 错误启用了 OffscreenCanvas；PPSSPP 代理回主线程创建 EGL 上下文时会崩溃')
}
for (const marker of ['proxyContextToMainThread', 'emscripten_webgl_do_create_context']) {
  if (!runtimeScript.includes(marker)) {
    fail(`PPSSPPSDL.js 缺少 WebGL Worker 代理标记 ${marker}；SDL/EGL 单独建上下文会让 pthread 的 GLctx 为空`)
  }
}
if (!runtimeScript.includes('IDBFS') || !/FS\.filesystems=\{[^}]*IDBFS[^}]*\}/.test(runtimeScript)) {
  fail('PPSSPPSDL.js 没有链接 IDBFS；这份产物会在存档挂载阶段中止启动')
}
for (const marker of ['__ppssppRangeProgress', '__ppssppRangeError']) {
  if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 Range v${RANGE_LOADER_REVISION} 标记 ${marker}，核心补丁可能没有编进产物`)
}
for (const marker of ['__ppssppAudio', 'node.onaudioprocess', 'const readSlot=', 'createScriptProcessor']) {
  if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 pthread 共享音频桥标记 ${marker}`)
}
const runtimeWasm = readFileSync(join(buildDir, 'PPSSPPSDL.wasm')).toString('latin1')
for (const marker of ['If-Match', 'If-Unmodified-Since', 'HTTP Range offset overflow']) {
  if (!runtimeWasm.includes(marker)) fail(`PPSSPPSDL.wasm 缺少 Range v${RANGE_LOADER_REVISION} 标记 ${marker}，核心补丁可能没有编进产物`)
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
  upstream: 'https://github.com/root-hunter/ppsspp-wasm',
  commit: PINNED_COMMIT,
  emscripten: '5.0.7',
  rangeStreaming: true,
  rangeLoaderRevision: RANGE_LOADER_REVISION,
  blockBytes: 2 * 1024 * 1024,
  memoryCacheBytes: 96 * 1024 * 1024,
  rangeTelemetry: true,
  objectValidator: 'etag-or-last-modified',
  workerModel: 'self-script',
  offscreenFramebuffer: true,
  webglContext: 'proxy-always-offscreen-framebuffer',
  pthreadAudioContext: 'shared-ring-buffer',
  artifactsInstalled: true,
  artifacts,
}
writeFileSync(join(OUTPUT, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`✔ PPSSPP Range 运行时已写入 ${OUTPUT}`)
console.log(`  ${Object.entries(artifacts).map(([name, info]) => `${basename(name)} ${info.bytes}B`).join(' · ')}`)
