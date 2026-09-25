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
assert.equal(isIsolatedRuntimePlatform('psp'), true, 'PPSSPP pthread 必须进入 COOP/COEP 独立页')
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
assert.match(adapter, /probeRange\(options\.game, probeController\.signal\)/)
assert.match(adapter, /RANGE_PROBE_TIMEOUT_MS = 20_000/)
assert.match(adapter, /probeController\.abort\(\)/)
assert.match(adapter, /request\('mount-remote'/)
assert.match(adapter, /message\.type === 'runtime-error'/)
assert.match(adapter, /if \(bootStarted \|\| destroyed\) return/)
assert.match(adapter, /index\.html\?embed=1&r=2/)
assert.doesNotMatch(adapter, /fetch\s*\(options\.game/)
assert.doesNotMatch(adapter, /arrayBuffer\s*\(\)/)

const host = readFileSync(new URL('../public/ppsspp/v0dbfaca/host.js', import.meta.url), 'utf8')
assert.match(host, /arguments:\s*\[gamePath\]/)
assert.match(host, /FS\.mount\(IDBFS/)
assert.match(host, /__ppssppRangeError/)
assert.match(host, /canvas\.width !== 300 \|\| canvas\.height !== 150/)
assert.match(host, /rangeReadConfirmed/)
assert.match(host, /saveSyncEnabled = false/)
assert.match(host, /syncRunning/)
const runtimeInit = /onRuntimeInitialized\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*onAbort/.exec(host)?.[1] ?? ''
assert.ok(runtimeInit, '必须能定位 PPSSPP onRuntimeInitialized 回调')
assert.doesNotMatch(runtimeInit, /respond\s*\(/, 'WASM 初始化完成不等于游戏已读盘，不能提前回复成功')
assert.doesNotMatch(host, /fetch\s*\(\s*(?:remote(?:\?\.)?\.url|gamePath)/)
assert.doesNotMatch(host, /arrayBuffer\s*\(/)

const patch = readFileSync(new URL('../vendor/ppsspp/patches/0001-range-streaming.patch', import.meta.url), 'utf8')
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
  'status == 412',
  'status == 429',
  'emscripten_thread_sleep',
  'HTTP Range offset overflow',
]) {
  assert.ok(patch.includes(marker), `核心补丁缺少 ${marker}`)
}

console.log('✔ PSP 平台、ISO/CSO 识别、隔离路由与 Range 核心约束通过')
