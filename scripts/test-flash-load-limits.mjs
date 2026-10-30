/** Flash 大文件与 8BG 解压炸弹保护：必须在整块读取/解密分配之前止损。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeRomPackPrefix } from '../shared/rom-pack-format.js'
import { assertSwf, MAX_SWF_BYTES } from '../src/lib/romValidation.ts'
import { loadGameBytes } from '../src/emulator/romLoader.ts'

const mib = 1024 * 1024

const compressed = Buffer.alloc(8)
compressed.write('CWS', 0, 'ascii')
compressed.writeUInt32LE(MAX_SWF_BYTES + 1, 4)
assert.throws(() => assertSwf(compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)), /256 MiB/,
  '压缩 SWF 也必须校验其声明的解压大小')

let localRead = false
const oversizedLocal = {
  name: 'too-large.swf',
  size: MAX_SWF_BYTES + 1,
  async arrayBuffer() {
    localRead = true
    throw new Error('不应读取超限文件')
  },
}
await assert.rejects(
  () => loadGameBytes(oversizedLocal, undefined, undefined, { maxBytes: MAX_SWF_BYTES }),
  /256 MiB/,
)
assert.equal(localRead, false, '本地 File.size 必须在 arrayBuffer 前检查')

const expandedSize = 5 * mib
const packedHeader = encodeRomPackPrefix({
  version: 1,
  packageId: '0123456789abcdef0123456789abcdef',
  keyId: 'flash-test',
  codec: 'store',
  codecVersion: 1,
  cipher: 'aes-256-gcm',
  originalName: 'large.swf',
  originalSize: expandedSize,
  chunkSize: expandedSize,
  noncePrefix: 'AAAAAAAAAAA',
  chunks: [{ sourceSize: expandedSize, encodedSize: expandedSize, cipherSize: expandedSize + 16, sha256: '0'.repeat(64) }],
  payloadSize: expandedSize + 16,
})
const packedInput = {
  name: 'large.swf.8bg',
  size: packedHeader.byteLength,
  async arrayBuffer() {
    return packedHeader.buffer.slice(packedHeader.byteOffset, packedHeader.byteOffset + packedHeader.byteLength)
  },
}
await assert.rejects(
  () => loadGameBytes(packedInput, undefined, undefined, {
    maxBytes: 8 * mib,
    maxUnpackedBytes: 4 * mib,
  }),
  /游戏文件超过 4 MiB/,
  '8BG originalSize 必须在 AES/Zstd 分配之前检查，而非等解包完成后才发现超限',
)

const oldFetch = globalThis.fetch
try {
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), {
    status: 200,
    headers: { 'content-length': '9', 'content-type': 'application/octet-stream' },
  })
  await assert.rejects(
    () => loadGameBytes('https://assets.example.test/large.swf', undefined, undefined, { maxBytes: 8 }),
    /文件过大/,
    '远程 Content-Length 超限时必须在读取响应体前停止',
  )
} finally {
  globalThis.fetch = oldFetch
}

const adapter = readFileSync(new URL('../src/emulator/adapters/ruffle.ts', import.meta.url), 'utf8')
assert.match(adapter, /maxBytes:\s*MAX_SWF_BYTES\s*\+\s*16\s*\*\s*1024\s*\*\s*1024/)
assert.match(adapter, /maxUnpackedBytes:\s*MAX_SWF_BYTES/)

console.log('Flash 加载上限通过：本地预检、远端流量止损、8BG 解包前拦截与 SWF 声明长度校验')
