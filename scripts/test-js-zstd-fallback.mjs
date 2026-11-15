/**
 * 没有 WebAssembly 时 8BG 改用纯 JS 的 fzstd 解压（src/services/romPack.ts 的 loadJsZstd）。
 * 编码端用和线上打包完全一样的 @bokuweb/zstd-wasm、等级 19；fzstd 解出来必须逐字节一致，
 * 包括 8MB 满块（8BG 按 8MB 原文分块，每块一个独立 frame）和预分配输出缓冲那条路。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { decompress as jsDecompress } from 'fzstd'

const require = createRequire(import.meta.url)
const zstd = require('@bokuweb/zstd-wasm')
await zstd.init()

function sample(size, seed) {
  // 模拟 ROM：一半重复图块（能压缩），一半随机（压不动），保证 frame 里两种块都有
  const out = new Uint8Array(size)
  const noise = randomBytes(Math.ceil(size / 2))
  for (let i = 0; i < size; i++) out[i] = i < size / 2 ? (i * 7 + seed) & 0xff ^ ((i >> 9) & 0x3f) : noise[i - Math.floor(size / 2)]
  return out
}

for (const [size, label] of [[24 * 1024, 'NROM 24KB'], [512 * 1024, '512KB'], [8 * 1024 * 1024, '8MB 满块']]) {
  const src = sample(size, size % 251)
  const frame = zstd.compress(src, 19)
  const viaHeap = jsDecompress(frame, new Uint8Array(size))
  assert.equal(viaHeap.byteLength, size, `${label} 预分配输出长度`)
  assert.ok(Buffer.from(viaHeap).equals(Buffer.from(src)), `${label} 预分配输出逐字节一致`)
  const viaGrow = jsDecompress(frame)
  assert.ok(Buffer.from(viaGrow).equals(Buffer.from(src)), `${label} 不预分配也一致`)
}
// 坏数据要抛错，不能静默给出半截 ROM
assert.throws(() => jsDecompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])))
console.log('test:js-zstd-fallback 通过（fzstd 逐字节解开 @bokuweb/zstd-wasm 等级 19 的 24KB / 512KB / 8MB frame）')
