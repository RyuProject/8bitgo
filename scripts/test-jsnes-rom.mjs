/** jsnes ROM 上限、ZIP 内层解压与大文件运行时回退测试。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

globalThis.__jsnesLoadOptions = null
globalThis.__jsnesLoadedData = null
globalThis.__jsnesLoadError = null

const bundled = await build({
  stdin: {
    contents: "export * from './src/emulator/jsnesRom.ts'; export { JSNES_MAX_ROM_BYTES } from './src/emulator/nesMapper.ts'; export { isZip, listZipEntries, crc32 } from './src/lib/unzip.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'jsnes-rom-test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'jsnes-rom-test-stubs',
    setup(api) {
      api.onResolve({ filter: /^\.\/romLoader$/ }, () => ({ path: 'rom-loader', namespace: 'test' }))
      api.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: `
          export async function loadGameBytes() {
            globalThis.__jsnesLoadOptions = arguments[3]
            if (globalThis.__jsnesLoadError) throw globalThis.__jsnesLoadError
            globalThis.__jsnesLoadOptions?.validate?.(globalThis.__jsnesLoadedData)
            return { data: globalThis.__jsnesLoadedData }
          }
        `,
        loader: 'js',
      }))
      api.onResolve({ filter: /^@\// }, (args) => ({ path: path.join(process.cwd(), 'src', `${args.path.slice(2)}.ts`) }))
    },
  }],
})

const { JSNES_MAX_ROM_BYTES, JsnesRomTooLargeError, isZip, listZipEntries, crc32, prepareJsnesRom, readJsnesRom } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`
)

function makeRom() {
  const rom = new Uint8Array(16 + 16_384 + 8_192)
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1])
  return rom
}

function storedZip(name, data, { declaredSize = data.byteLength, compressedSize = data.byteLength } = {}) {
  const nameBytes = Buffer.from(name)
  const local = Buffer.alloc(30 + nameBytes.length + compressedSize)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(0, 6)
  local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(compressedSize, 18)
  local.writeUInt32LE(declaredSize, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  nameBytes.copy(local, 30)
  Buffer.from(data).copy(local, 30 + nameBytes.length, 0, compressedSize)

  const central = Buffer.alloc(46 + nameBytes.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc32(data), 16)
  central.writeUInt32LE(compressedSize, 20)
  central.writeUInt32LE(declaredSize, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  nameBytes.copy(central, 46)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length, 16)
  const result = Buffer.concat([local, central, end])
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength)
}

const rom = makeRom()
const raw = rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength)
assert.equal((await prepareJsnesRom(raw)).byteLength, rom.byteLength, '裸 iNES 保持零拷贝快路径')

const archive = storedZip('game.nes', rom)
const extracted = await prepareJsnesRom(archive)
assert.deepEqual(new Uint8Array(extracted), rom, '按内容识别 ZIP 并正确解出内层 ROM')

const corruptCrc = storedZip('game.nes', rom)
const corruptView = new DataView(corruptCrc)
const endOffset = corruptCrc.byteLength - 22
const centralOffset = corruptView.getUint32(endOffset + 16, true)
corruptView.setUint32(14, 0, true)
corruptView.setUint32(centralOffset + 16, 0, true)
await assert.rejects(prepareJsnesRom(corruptCrc), /CRC-32 不匹配/, 'ZIP CRC 错误必须拦在 jsnes 核心之前')

const bomb = storedZip('huge.nes', Uint8Array.of(1), {
  declaredSize: JSNES_MAX_ROM_BYTES + 1,
  compressedSize: 1,
})
assert.equal(isZip(bomb), true, '合成的过大 ZIP 仍有合法容器签名')
assert.equal(listZipEntries(bomb)[0]?.uncompressedSize, JSNES_MAX_ROM_BYTES + 1, '测试 ZIP 正确声明了超大内层 ROM')
await assert.rejects(prepareJsnesRom(bomb), JsnesRomTooLargeError, 'ZIP 声明超大成员时在分配解压缓冲前拒绝')

globalThis.__jsnesLoadedData = raw
await readJsnesRom('https://rom.example/game.nes')
assert.equal(globalThis.__jsnesLoadOptions.maxBytes, JSNES_MAX_ROM_BYTES, '网络 ROM 下载有硬上限')
assert.equal(globalThis.__jsnesLoadOptions.maxUnpackedBytes, JSNES_MAX_ROM_BYTES, '8BG 解包有硬上限')
assert.equal(typeof globalThis.__jsnesLoadOptions.validate, 'function', 'ROM 格式校验在持久缓存写入前运行')

globalThis.__jsnesLoadedData = bomb
await assert.rejects(readJsnesRom('https://rom.example/bomb.zip'), JsnesRomTooLargeError, '超大 ZIP 在缓存之前失败关闭')

globalThis.__jsnesLoadError = new RangeError('文件过大，无法在浏览器内存中解包')
await assert.rejects(readJsnesRom('https://rom.example/large.nes'), JsnesRomTooLargeError, '远程超限映射到运行时回退，而不是网络重试')

console.log('jsnes ROM 通过：裸 iNES / ZIP 安全解压 / 8BG 与网络大小限制 / 超限运行时回退')
