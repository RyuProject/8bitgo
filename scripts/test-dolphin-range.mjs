/**
 * wasm-dolphin 接入回归：分块读取不能偷偷退化成整盘下载，ISO 也不能误判成 PS1。
 */
import assert from 'node:assert/strict'
import { RangeBackedFile } from '../public/dolphin/v7e38409/src/range-backed-file.js'
import { detectRom } from '../src/emulator/detect.ts'
import { isolatedRuntimeRoute, isIsolatedRuntimePlatform } from '../shared/isolated-runtime-platforms.js'
import { isStreamingDiscPlatform } from '../shared/streaming-disc-platforms.js'

for (const platform of ['gamecube', 'wii']) {
  assert.equal(isIsolatedRuntimePlatform(platform), true)
  assert.equal(isStreamingDiscPlatform(platform), true)
  assert.deepEqual(isolatedRuntimeRoute(`/play/${platform}/demo`), { platform, slug: 'demo' })
}
assert.equal(isolatedRuntimeRoute('/play/psx/demo'), undefined, 'PS1 不应误进 pthread 隔离路由')

const source = Uint8Array.from({ length: 40 }, (_, i) => i)
const requests = []
const remote = new RangeBackedFile({
  url: 'https://assets.example/disc.iso',
  name: 'disc.iso',
  size: source.length,
  chunkBytes: 8,
  cacheBytes: 16,
  fetchRange: (_url, start, end) => {
    requests.push([start, end])
    return source.slice(start, end + 1)
  },
})

assert.deepEqual(new Uint8Array(await remote.slice(6, 19).arrayBuffer()), source.slice(6, 19), '跨块切片内容不对')
assert.deepEqual(requests, [[0, 7], [8, 15], [16, 23]], '必须按对齐块取数据，不能整盘下载')
await remote.slice(9, 12).arrayBuffer()
assert.equal(requests.length, 3, '命中缓存却又请求了网络')
await remote.slice(24, 25).arrayBuffer()
await remote.slice(0, 1).arrayBuffer()
assert.equal(requests.length, 5, 'LRU 超预算后没有淘汰最老块')

const broken = new RangeBackedFile({
  url: 'https://assets.example/broken.iso',
  size: 16,
  chunkBytes: 8,
  fetchRange: () => new Uint8Array(1),
})
assert.throws(() => broken.slice(0, 2), /incomplete/, '短响应必须失败，不能把缺字节的光盘喂给核心')

const disc = (name, offset, magic) => {
  const bytes = new Uint8Array(64)
  bytes.set(magic, offset)
  return new File([bytes], name)
}
assert.equal((await detectRom(disc('game.iso', 0x1c, [0xc2, 0x33, 0x9f, 0x3d]))).platform, 'gamecube')
assert.equal((await detectRom(disc('game.iso', 0x18, [0x5d, 0x1c, 0x9e, 0xa3]))).platform, 'wii')
assert.equal((await detectRom(disc('game.gcm', 0, []))).platform, 'gamecube')
assert.equal((await detectRom(disc('game.wbfs', 0, []))).platform, 'wii')

console.log('✔ wasm-dolphin Range 分块缓存与 GameCube/Wii 光盘识别通过')
