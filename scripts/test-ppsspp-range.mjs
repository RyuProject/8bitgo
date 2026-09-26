/** PSP 接入回归：平台路由、镜像识别和核心补丁不能退回整盘下载。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectRom } from '../src/emulator/detect.ts'
import { isStreamingDiscPlatform } from '../shared/streaming-disc-platforms.js'
import { isIsolatedRuntimePlatform, isolatedRuntimeRoute } from '../shared/isolated-runtime-platforms.js'

const fakeFile = (name, bytes) => ({
  name,
  size: bytes.byteLength,
  slice(from = 0, to = bytes.byteLength) {
    const part = bytes.slice(from, to)
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) }
  },
})

assert.equal(isStreamingDiscPlatform('psp'), true, 'PSP 上传必须保留裸镜像，不能进入 8BG/ZIP')
assert.equal(isIsolatedRuntimePlatform('psp'), true, 'PPSSPP pthread 必须运行在带 COOP/COEP 的顶层文档')
assert.deepEqual(isolatedRuntimeRoute('/play/psp/monster-hunter'), {
  platform: 'psp',
  slug: 'monster-hunter',
})

const iso = new Uint8Array(65536)
iso.set(new TextEncoder().encode('PSP GAME'), 0x8008)
assert.equal((await detectRom(fakeFile('game.iso', iso))).platform, 'psp', 'PSP ISO 不能被通用 .iso 规则误判成 PS1')

const cso = new Uint8Array(64)
cso.set(new TextEncoder().encode('CISO'))
assert.equal((await detectRom(fakeFile('game.cso', cso))).platform, 'psp', 'CSO 魔数应识别为 PSP')

const adapter = readFileSync(new URL('../src/emulator/adapters/ppsspp.ts', import.meta.url), 'utf8')
const prewarm = readFileSync(new URL('../src/emulator/prewarm.ts', import.meta.url), 'utf8')
const paths = readFileSync(new URL('../src/emulator/paths.ts', import.meta.url), 'utf8')
const host = readFileSync(new URL('../public/ppsspp/v0dbfaca/v4/host.js', import.meta.url), 'utf8')
const audioWorklet = readFileSync(new URL('../public/ppsspp/v0dbfaca/v4/audio-worklet.js', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/pages/GameDetailPage.tsx', import.meta.url), 'utf8')
const ssr = readFileSync(new URL('../server/src/ssr.js', import.meta.url), 'utf8')
const serverIndex = readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
const workerHttp = readFileSync(new URL('../worker/src/http.js', import.meta.url), 'utf8')
const workerConfig = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8')
assert.match(detail, /usesIsolatedLaunchCard = requiresIsolation && game\?\.platform !== 'psp'/, 'PSP 不应再跳铺满视口的精简播放器')
assert.match(host, /arguments:\s*\[[\s\S]*?'--windowed'[\s\S]*?'--xres'[\s\S]*?'--yres'/, 'PSP 必须限制浏览器后备缓冲，不能继续按整块 Retina 屏渲染')
assert.match(host, /width:\s*960,\s*height:\s*544/, '高性能档的最终画布不应超过 PSP 2x')
assert.match(host, /__ppssppAudioWorkletUrl/, 'PSP 外壳必须把独立音频线程脚本交给核心')
assert.match(host, /RUNTIME_SCRIPT = 'PPSSPPSDL\.js'/, 'v4 桥必须加载同一实体目录中的核心')
assert.match(host, /return new URL\(path, location\.href\)\.href/, 'v4 核心资源必须按同目录解析')
assert.match(paths, /PPSSPP_RUNTIME_GENERATION = 'v4'/, 'Cloudflare 忽略查询串时必须靠实体目录换代')
assert.match(host, /getPreloadedPackage[\s\S]*fetchCoreData/, 'PSP data 包网络中断后必须由桥自动重试')
assert.match(host, /attempts = 3[\s\S]*30_000/, 'PSP data 包必须有有限重试和无进度超时')
assert.match(audioWorklet, /registerProcessor\('ppsspp-audio'/, 'PSP AudioWorklet 没有注册处理器')
assert.match(audioWorklet, /Atomics\.load[\s\S]*Atomics\.store/, 'PSP AudioWorklet 必须直接消费共享 PCM 环形缓冲')
assert.match(detail, /pspNeedsDocumentReload[\s\S]*?window\.location\.reload\(\)/, '站内跳进 PSP 详情页后必须重新请求隔离文档')
assert.ok(
  /EXPERIMENTAL_PLATFORMS\.has\(platform\.id\) && platform\.id !== 'psp'/.test(detail) ||
  /platform\.runtime === 'ppsspp'[\s\S]*?ppssppExperimental/.test(detail),
  'PSP 必须排除实验性提示或使用自己的 PPSSPP 提示，不能显示 PS2 文案',
)
assert.match(ssr, /data\?\.route === 'game' && data\.game\?\.platform === 'psp'/, 'PSP 正常详情页必须由服务端加隔离头')
assert.match(ssr, /isolatedDocument[\s\S]*?'Cross-Origin-Opener-Policy': 'same-origin'[\s\S]*?'Cross-Origin-Embedder-Policy': 'require-corp'/, 'PSP 详情页缺少 COOP/COEP')
assert.match(serverIndex, /app\.get\('\/ppsspp\/v0dbfaca'[\s\S]*?CACHE\.none[\s\S]*?v4\/index\.html\?embed=1/, '旧 PSP bundle 的无 index 入口必须跳到当前实体运行时，不能继续 404 或命中旧缓存')
assert.match(workerHttp, /'Cross-Origin-Resource-Policy', 'cross-origin'/, '隔离详情页的跨源封面会被 COEP 拦截')
assert.match(workerConfig, /image\.8bitgo\.com\/\*/, '封面域名必须经过会添加 CORP 的 R2 Worker')
assert.match(adapter, /probeRange\(options\.game, probeController\.signal\)/)
assert.match(adapter, /RANGE_PROBE_TIMEOUT_MS = 20_000/)
assert.match(adapter, /probeController\.abort\(\)/)
assert.match(adapter, /request\('mount-remote'/)
assert.match(adapter, /message\.type === 'runtime-error'/)
assert.match(adapter, /if \(bootStarted \|\| destroyed\) return/)
assert.match(adapter, /PPSSPP_RUNTIME_PATH/)
assert.match(adapter, /index\.html\?embed=1/)
assert.match(adapter, /focusFrame\(iframe\)/, 'PSP 启动和工具栏交互后必须把键盘焦点无滚动地还给模拟器')
assert.match(adapter, /frameGamepads\(iframe\)/, 'PSP 手柄状态必须从实际运行游戏的 iframe 读取')
assert.match(adapter, /caps\.add\('saveState'\)/, 'PSP 启动后必须上报统一即时存档能力')
assert.match(adapter, /caps\.add\('remapKeys'\)/, 'PSP 启动后必须提供原生改键入口')
assert.match(adapter, /captureSources\(\)/, 'PSP 必须把画布和声音暴露给直播链路')
assert.doesNotMatch(adapter, /fetch\s*\(options\.game/)
assert.doesNotMatch(adapter, /arrayBuffer\s*\(\)/)

assert.match(host, /FS\.filesystems\?\.IDBFS/)
assert.match(host, /FS\.mount\(idbfs/)
assert.match(host, /FS\.filesystems\?\.WORKERFS/)
assert.match(host, /__ppssppRangeError/)
assert.match(host, /canvas\.width !== 300 \|\| canvas\.height !== 150/)
assert.match(host, /rangeReadConfirmed/)
assert.match(host, /saveSyncEnabled = false/)
assert.match(host, /syncRunning/)
assert.match(host, /8bitgo-ppsspp-state/)
assert.match(host, /nativeCommand\(1\)/)
assert.match(host, /nativeCommand\(2\)/)
assert.match(host, /open-controls/)
assert.match(host, /--appendconfig=\$\{PERFORMANCE_CONFIG_PATH\}/, 'PSP 低延迟配置必须在单游戏配置之后强制合并')
assert.match(host, /VerticalSync = False/)
assert.match(host, /LowLatencyPresent = True/)
assert.match(host, /InflightFrames = 1/, 'PPSSPP 默认 3 帧队列会增加输入延迟，浏览器固定为 1 帧')
assert.match(host, /FrameSkip = 0[\s\S]*AutoFrameSkip = False/, '低延迟不能靠跳帧伪造，否则会丢失操作采样')
assert.match(host, /InternalResolution = \$\{profile\.internalResolution\}/, '内部分辨率必须随硬件档位选择')
const runtimeInit = /onRuntimeInitialized\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*onAbort/.exec(host)?.[1] ?? ''
assert.ok(runtimeInit, '必须能定位 PPSSPP onRuntimeInitialized 回调')
assert.doesNotMatch(runtimeInit, /respond\s*\(/, 'WASM 初始化完成不等于游戏已读盘，不能提前回复成功')
assert.doesNotMatch(host, /fetch\s*\(\s*(?:remote(?:\?\.)?\.url|gamePath)/)
assert.doesNotMatch(host, /fetch\s*\([^)]*(?:remote(?:\?\.)?\.url|gamePath)[^)]*\)[\s\S]{0,300}arrayBuffer\s*\(/)

const patch = readFileSync(new URL('../vendor/ppsspp/patches/0001-range-streaming.patch', import.meta.url), 'utf8')
for (const marker of [
  'EMSCRIPTEN_FETCH_SYNCHRONOUS',
  'fetch->status == 206',
  'BLOCK_BYTES = 2 * 1024 * 1024',
  'MAX_CACHE_BYTES = 96 * 1024 * 1024',
  '-sPROXY_TO_PTHREAD=1',
  '-sOFFSCREEN_FRAMEBUFFER=1',
  '-lidbfs.js',
  '__ppssppRangeProgress',
  '__ppssppRangeError',
  'If-Match',
  'If-Unmodified-Since',
  'status == 412',
  'status == 429',
  'emscripten_thread_sleep',
  'HTTP Range offset overflow',
  '#include <GLES3/gl3.h>',
  'GLboolean gl3stubInit()',
  'EMSCRIPTEN_WEBGL_CONTEXT_PROXY_ALWAYS',
  'emscripten_webgl_create_context',
  'emscripten_webgl_commit_frame',
]) {
  assert.ok(patch.includes(marker), `核心补丁缺少 ${marker}`)
}
const chdRangePatch = readFileSync(new URL('../vendor/ppsspp/patches/0007-chd-range-performance.patch', import.meta.url), 'utf8')
for (const marker of ['CHD_BLOCK_BYTES = 512 * 1024', 'blockBytes_ = CHD_BLOCK_BYTES', 'cursor / blockBytes_']) {
  assert.ok(chdRangePatch.includes(marker), `CHD Range 性能补丁缺少 ${marker}`)
}
const coldStartPatch = readFileSync(new URL('../vendor/ppsspp/patches/0008-web-cold-start.patch', import.meta.url), 'utf8')
for (const marker of ['CHD_BLOCK_BYTES = 2 * 1024 * 1024', '--exclude-file', '*/assets/debugger/*', '约 86 秒', '约 93 秒']) {
  assert.ok(coldStartPatch.includes(marker), `PSP 冷启动补丁缺少 ${marker}`)
}
assert.match(prewarm, /runtime === 'ppsspp'/, 'PSP 运行时没有接入统一预热入口')
assert.match(prewarm, /PPSSPP_RUNTIME_PATH}index\.html\?embed=1/, 'PSP 入口预热目录与真实 iframe 不一致')
assert.match(prewarm, /PPSSPP_RUNTIME_PATH}PPSSPPSDL\.wasm/, 'PSP 悬停没有预热 Wasm 核心')
assert.match(prewarm, /PPSSPP_RUNTIME_PATH}PPSSPPSDL\.data/, 'PSP 悬停没有预热 data 包')
assert.match(prewarm, /hasHoverIntent\(\) && allowsLargeHoverPrewarm\(\)/, 'PSP 大核心预热必须限制在真实桌面悬停和非省流网络')

const sdlAudioPatch = readFileSync(new URL('../vendor/ppsspp/patches/0002-sdl2-pthread-audio.patch', import.meta.url), 'utf8')
assert.match(sdlAudioPatch, /this->spec\.freq = MAIN_THREAD_EM_ASM_INT/, 'SDL 采样率读取必须代理回主线程')

const pthreadAudioPatch = readFileSync(new URL('../vendor/ppsspp/patches/0003-pthread-audio-ring.patch', import.meta.url), 'utf8')
assert.match(pthreadAudioPatch, /Wasm audio bridge started/, 'PPSSPP 必须用共享环形缓冲区跨线程播放音频')
assert.match(pthreadAudioPatch, /PumpWasmAudioBridge\(\)/, 'PPSSPP 工作线程必须主动填充共享音频缓冲区')
assert.match(pthreadAudioPatch, /每帧重复设置同一个定时器只会增加 Worker 调度抖动/, 'PPSSPP 主循环不能每帧重设同一个调度器')

const proxiedWebglPatch = readFileSync(new URL('../vendor/ppsspp/patches/0004-emscripten-proxied-webgl-preloop.patch', import.meta.url), 'utf8')
assert.match(proxiedWebglPatch, /!GL\.currentContextIsProxied/, '代理 WebGL 上下文不能执行只适用于本地上下文的 VBO 预帧维护')

const webFeaturesPatch = readFileSync(new URL('../vendor/ppsspp/patches/0005-web-save-controls-bridge.patch', import.meta.url), 'utf8')
for (const marker of [
  '__ppssppBridgeSetCommand',
  '__ppssppBridgePopupOpen',
  '__ppssppNativeResult',
  'SaveState::SaveSlot(prefix, 0',
  'SaveState::LoadSlot(prefix, 0',
  'UIMessage::SHOW_CONTROL_MAPPING',
]) {
  assert.ok(webFeaturesPatch.includes(marker), `PSP 存档/改键桥补丁缺少 ${marker}`)
}

console.log('✔ PSP 平台、ISO/CSO 识别、隔离路由与 Range 核心约束通过')
