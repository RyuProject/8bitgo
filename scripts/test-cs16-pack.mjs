import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { decompress, init } from '@bokuweb/zstd-wasm'
import { safePackPath, unpackTarStream } from '../public/web/cs16/tar-stream.js'

const te = new TextEncoder()
const writeText = (target, at, length, value) => target.set(te.encode(value).subarray(0, length), at)
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`

function tar(entries, corrupt = false) {
  const chunks = []
  for (const [name, text] of entries) {
    const body = te.encode(text)
    const head = new Uint8Array(512)
    writeText(head, 0, 100, name)
    writeText(head, 100, 8, '0000644\0')
    writeText(head, 108, 8, '0000000\0')
    writeText(head, 116, 8, '0000000\0')
    writeText(head, 124, 12, octal(body.length, 12))
    writeText(head, 136, 12, '00000000000\0')
    head.fill(32, 148, 156)
    head[156] = 48
    writeText(head, 257, 6, 'ustar\0')
    writeText(head, 263, 2, '00')
    const sum = head.reduce((total, value) => total + value, 0) + (corrupt ? 1 : 0)
    writeText(head, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(head, body, new Uint8Array((512 - body.length % 512) % 512))
  }
  chunks.push(new Uint8Array(1024))
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}

function fragmented(bytes) {
  let at = 0
  const sizes = [1, 7, 503, 19, 1024, 3]
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close()
      const end = Math.min(bytes.byteLength, at + sizes[index++ % sizes.length])
      controller.enqueue(bytes.subarray(at, end))
      at = end
    },
  })
}

assert.equal(safePackPath('cstrike/maps/de_dust2.bsp'), 'cstrike/maps/de_dust2.bsp')
for (const path of ['../xash.wasm', '/xash.wasm', 'C:/xash.wasm', 'a//b', 'a\\b']) {
  assert.equal(safePackPath(path), null, `必须拒绝 ${path}`)
}

const found = []
const result = await unpackTarStream(
  fragmented(tar([['cstrike/a.txt', 'A'], ['valve/long.bin', '0123456789']])),
  async (name, data) => found.push([name, new TextDecoder().decode(data)]),
)
assert.deepEqual(found, [['cstrike/a.txt', 'A'], ['valve/long.bin', '0123456789']])
assert.equal(result.files, 2)
assert.equal(result.bytes, 11)
await assert.rejects(() => unpackTarStream(fragmented(tar([['a', 'b']], true)), async () => {}), /校验失败/)
const truncated = tar([['a', 'b']]).subarray(0, 600)
await assert.rejects(() => unpackTarStream(fragmented(truncated), async () => {}), /提前结束/)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = join(root, 'public/web/cs16/packs')
const maps = [
  'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train',
  'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo',
]

async function inspectPack(file) {
  const names = []
  const compressed = Readable.toWeb(createReadStream(file))
  const result = await unpackTarStream(
    compressed.pipeThrough(new DecompressionStream('gzip')),
    async (name) => names.push(name),
  )
  return { names, result }
}

async function gzipRawSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file).pipe(createGunzip())) hash.update(chunk)
  return hash.digest('hex')
}

const zstdRoot = join(packDir, 'zstd-v1')
const catalog = JSON.parse(readFileSync(join(zstdRoot, 'catalog.json'), 'utf8'))
assert.equal(catalog.format, '8bitgo.cs16.zstd-chunks.v1')
assert.equal(catalog.compression.level, 22)
assert.equal(catalog.compression.chunkRawBytes, 16 * 1024 * 1024)
await init()

async function inspectZstdPack(key) {
  const pack = catalog.packs[key]
  assert(pack, `Zstd 清单缺 ${key}`)
  const names = []
  const packHash = createHash('sha256')
  let index = 0
  let compressedBytes = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= pack.chunks.length) return controller.close()
      const chunk = pack.chunks[index]
      assert.equal(chunk.index, index)
      assert.match(chunk.path, /^chunks\/[a-f0-9]{64}\.zst$/)
      const compressed = readFileSync(join(zstdRoot, chunk.path))
      assert.deepEqual(compressed.subarray(0, 4), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), `${key} 第 ${index + 1} 片不是 Zstd`)
      assert.equal(compressed.byteLength, chunk.compressedBytes)
      assert.equal(createHash('sha256').update(compressed).digest('hex'), chunk.compressedSha256)
      const raw = decompress(compressed)
      assert.equal(raw.byteLength, chunk.rawBytes)
      assert.equal(createHash('sha256').update(raw).digest('hex'), chunk.rawSha256)
      packHash.update(raw)
      compressedBytes += compressed.byteLength
      index += 1
      controller.enqueue(raw)
    },
  })
  const result = await unpackTarStream(stream, async (name) => names.push(name))
  assert.equal(packHash.digest('hex'), pack.rawSha256)
  assert.equal(result.bytes + (result.files + 2) * 512 <= pack.rawBytes, true, `${key} TAR 汇总长度异常`)
  assert.equal(compressedBytes, pack.compressedBytes)
  return { names, result, rawSha256: pack.rawSha256 }
}

/* 单元样本能锁解析器，真实包检查再锁住「瘦身时没有把全部地图装回公共包」。 */
const base = await inspectPack(join(packDir, 'base.tar.gz'))
const zstdBase = await inspectZstdPack('base')
assert.equal(zstdBase.rawSha256, await gzipRawSha256(join(packDir, 'base.tar.gz')), 'Zstd 公共包与 gzip 原始 TAR 不一致')
assert.deepEqual(zstdBase.names, base.names, 'Zstd 公共包文件顺序或内容清单不一致')
assert(base.result.bytes < 160 * 1024 * 1024, '公共包展开后必须小于 160MB，否则浏览器会重新 OOM')
assert(!base.names.some((name) => name.includes('/maps/') || name.includes('/overviews/')), '公共包不能含地图')
assert(!base.names.some((name) => /\.(?:dll|dylib|exe|icns|so)$/i.test(name)), '公共包不能含原生动态库')

for (const map of maps) {
  const pack = await inspectPack(join(packDir, 'maps', `${map}.tar.gz`))
  const zstdPack = await inspectZstdPack(`maps/${map}`)
  assert.equal(zstdPack.rawSha256, await gzipRawSha256(join(packDir, 'maps', `${map}.tar.gz`)), `${map} 的 Zstd 与 gzip 原始 TAR 不一致`)
  assert.deepEqual(zstdPack.names, pack.names, `${map} 的 Zstd 文件清单不一致`)
  assert(pack.names.includes(`cstrike/maps/${map}.bsp`), `${map} 包缺 BSP`)
  assert(pack.result.bytes < 60 * 1024 * 1024, `${map} 单地图包过大`)
  assert(pack.names.every((name) => name.includes('/maps/') || name.includes('/overviews/') || name.includes('/gfx/env/') || name.endsWith('.wad')), `${map} 包混入无关资源`)
}

console.log(`CS16 流式 TAR 测试通过（公共包 ${base.result.files} 文件 / ${(base.result.bytes / 1048576).toFixed(1)} MB）`)
