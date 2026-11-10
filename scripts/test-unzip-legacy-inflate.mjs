#!/usr/bin/env node
/**
 * 老浏览器没有 DecompressionStream('deflate-raw')（Chrome < 103 / Safari < 16.4 / Firefox < 113）时，
 * ZIP 成员改包成 gzip 解开，结果必须与原文逐字节一致。2026-11-09《暴力摩托》DOS 包在这类浏览器上
 * 报「Failed to construct 'DecompressionStream': Unsupported compression format」整局起不来。
 */
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

const { extractZipEntry, listZipEntries } = await import('../src/lib/unzip.ts')

// 现场拼一个 deflate 成员的 ZIP（不依赖仓库里的打包函数）
function makeZip(name, data) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let crc = 0xffffffff
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0
  const comp = deflateRawSync(data)
  const nameBytes = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(0, 42)
  const cdOffset = local.length + nameBytes.length + comp.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(cdOffset, 16)
  const zip = Buffer.concat([local, nameBytes, comp, central, nameBytes, end])
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)
}

const payload = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7 + (i >> 9)) & 0xff))
const zip = makeZip('ROADRASH/RR.EXE', payload)
const [entry] = listZipEntries(zip)
assert.equal(entry.method, 8)

const modern = await extractZipEntry(zip, entry)
assert.ok(Buffer.from(modern).equals(payload), '支持 deflate-raw 的浏览器照常解开')

const Native = globalThis.DecompressionStream
globalThis.DecompressionStream = class extends Native {
  constructor(format) {
    if (format === 'deflate-raw') throw new TypeError("Failed to construct 'DecompressionStream': Unsupported compression format: 'deflate-raw'")
    super(format)
  }
}
try {
  const legacy = await extractZipEntry(zip, entry)
  assert.ok(Buffer.from(legacy).equals(payload), '没有 deflate-raw 的浏览器改包 gzip 后逐字节一致')

  // CRC 被篡改：gzip 尾部校验必须报错，不能把坏数据交给模拟器
  await assert.rejects(extractZipEntry(zip, { ...entry, crc32: (entry.crc32 ^ 1) >>> 0 }))
} finally {
  globalThis.DecompressionStream = Native
}
console.log('✔ ZIP 解压：老浏览器无 deflate-raw 时改用 gzip 封装，内容一致且校验和生效')
