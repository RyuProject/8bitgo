#!/usr/bin/env node
/** 检查 PSP 平台、桥与 Range 核心是不是同一套可发布实现。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = '0dbfaca'
const useDist = process.argv.includes('--dist')
const sourceOnly = process.argv.includes('--source-only')
const publicDir = join(root, 'public', 'ppsspp', `v${VERSION}`)
const runtimeDir = useDist ? join(root, 'dist', 'client', 'ppsspp', `v${VERSION}`) : publicDir

const fail = (message) => {
  console.error(`✖ PPSSPP 检查失败：${message}`)
  process.exit(1)
}
const need = (path) => {
  if (!existsSync(path)) fail(`缺少 ${path}`)
  return readFileSync(path)
}

for (const name of ['index.html', 'host.js', 'runtime.json', 'SOURCE.txt']) need(join(runtimeDir, name))
const host = need(join(runtimeDir, 'host.js')).toString('utf8')
const adapter = need(join(root, 'src', 'emulator', 'adapters', 'ppsspp.ts')).toString('utf8')
for (const marker of [
  '8bitgo-ppsspp-bridge',
  'mount-remote',
  'WORKERFS',
  'IDBFS',
  '__ppssppRangeProgress',
  '__ppssppRangeError',
  'runtime-error',
  'RUNTIME_REVISION',
]) {
  if (!host.includes(marker)) fail(`host.js 缺少桥标记 ${marker}`)
}
const runtimeInit = /onRuntimeInitialized\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*onAbort/.exec(host)?.[1] ?? ''
if (!runtimeInit || /respond\s*\(/.test(runtimeInit)) {
  fail('host.js 在 onRuntimeInitialized 阶段就回复成功；此时 PPSSPP 还没有执行 main 或读取镜像')
}
if (!/host\.js\?r=12/.test(need(join(runtimeDir, 'index.html')).toString('utf8'))) {
  fail('index.html 没有给桥脚本加内容代次，immutable 缓存会继续返回旧启动逻辑')
}
if (!/index\.html\?embed=1&r=13/.test(adapter)) {
  fail('PPSSPP iframe 入口没有内容代次，immutable 缓存会让老访客继续拿旧 index.html')
}
if (/fetch\s*\(\s*(?:remote(?:\?\.)?\.url|gamePath)/.test(host) || /arrayBuffer\s*\(/.test(host)) {
  fail('host.js 出现整盘下载代码；远程镜像只能把 URL 交给 C++ Range loader')
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

const manifest = JSON.parse(need(join(runtimeDir, 'runtime.json')).toString('utf8'))
if (manifest.commit !== '0dbfaca62a8a924abc2c5dd5dd0733b668e5e68a') fail('runtime.json 的上游提交没有锁定')
if (manifest.rangeStreaming !== true || manifest.blockBytes !== 2097152) {
  fail('runtime.json 的 Range 参数不正确')
}
const loaderRevision = Number(manifest.rangeLoaderRevision || 1)
if (loaderRevision === 1 && manifest.memoryCacheBytes !== 201326592) fail('旧版核心的缓存参数清单不正确')
if (loaderRevision === 2 && manifest.memoryCacheBytes !== 100663296) fail('Range v2 核心的缓存参数清单不正确')
if (![1, 2].includes(loaderRevision)) fail(`不认识的 Range loader 代次：${manifest.rangeLoaderRevision}`)
if (loaderRevision === 2 && (manifest.rangeTelemetry !== true || manifest.objectValidator !== 'etag-or-last-modified')) {
  fail('Range v2 清单缺少进度/错误遥测或对象一致性校验声明')
}
if (manifest.workerModel !== 'self-script') fail('runtime.json 没有声明 Emscripten 5 的自身 Worker 模型')
if (manifest.webglContext !== 'proxy-always-offscreen-framebuffer') {
  fail('runtime.json 没有声明 WebGL Worker 代理上下文模型')
}
if (manifest.pthreadAudioContext !== 'shared-ring-buffer') {
  fail('runtime.json 没有声明共享音频桥；SDL 主线程回调会进入错误的 pthread Wasm 状态')
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
  if (!runtimeScript.includes('pthreadMainJs=_scriptName') || !runtimeScript.includes('new Worker(pthreadMainJs')) {
    fail('PPSSPPSDL.js 缺少自身 Worker 标记，PROXY_TO_PTHREAD 没有正确发布')
  }
  if (!runtimeScript.includes('createOffscreenFramebuffer') || !runtimeScript.includes('renderViaOffscreenBackBuffer')) {
    fail('PPSSPPSDL.js 缺少 OffscreenFramebuffer 支持；pthread 的 GL 调用无法安全代理到主线程')
  }
  for (const marker of ['proxyContextToMainThread', 'emscripten_webgl_do_create_context']) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 WebGL Worker 代理标记 ${marker}`)
  }
  if (runtimeScript.includes('transferControlToOffscreen')) {
    fail('PPSSPPSDL.js 错误启用了 OffscreenCanvas；PPSSPP 代理回主线程创建 EGL 上下文时会崩溃')
  }
  if (!runtimeScript.includes('IDBFS') || !/FS\.filesystems=\{[^}]*IDBFS[^}]*\}/.test(runtimeScript)) {
    fail('PPSSPPSDL.js 没有链接 IDBFS；host.js 会在存档挂载阶段中止启动')
  }
  for (const marker of ['__ppssppAudio', 'node.onaudioprocess', 'const readSlot=', 'createScriptProcessor']) {
    if (!runtimeScript.includes(marker)) fail(`PPSSPPSDL.js 缺少 pthread 共享音频桥标记 ${marker}`)
  }
  if (loaderRevision === 2) {
    for (const marker of ['__ppssppRangeProgress', '__ppssppRangeError']) {
      if (!runtimeScript.includes(marker)) fail(`Range v2 二进制缺少 ${marker}，清单与核心不一致`)
    }
    const runtimeWasm = need(join(runtimeDir, 'PPSSPPSDL.wasm')).toString('latin1')
    for (const marker of ['If-Match', 'If-Unmodified-Since', 'HTTP Range offset overflow']) {
      if (!runtimeWasm.includes(marker)) fail(`Range v2 WASM 缺少 ${marker}，清单与核心不一致`)
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
  for (const name of ['index.html', 'host.js', 'runtime.json', 'SOURCE.txt']) {
    const a = need(join(publicDir, name))
    const b = need(join(runtimeDir, name))
    if (!a.equals(b)) fail(`dist/client 中的 ${name} 不是 public 里的当前版本`)
  }
}

console.log(`✔ PPSSPP ${sourceOnly && !installed ? '源码接入' : 'Range 运行时'}检查通过${useDist ? '（dist）' : ''}`)
