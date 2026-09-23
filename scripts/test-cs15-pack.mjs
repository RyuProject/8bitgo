#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { safePackPath, unpackStoredZipStream } from '../public/web/cs15/zip-stream.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = join(root, 'public/web/cs15/packs')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value++) {
    let crc = value
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    table[value] = crc >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function storeZip(entries, corruptCrc = false) {
  const encoder = new TextEncoder()
  const chunks = []
  for (const [name, text] of entries) {
    const filename = encoder.encode(name)
    const body = encoder.encode(text)
    const head = new Uint8Array(30)
    const view = new DataView(head.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, 0, true)
    view.setUint32(14, (crc32(body) + (corruptCrc ? 1 : 0)) >>> 0, true)
    view.setUint32(18, body.length, true)
    view.setUint32(22, body.length, true)
    view.setUint16(26, filename.length, true)
    chunks.push(head, filename, body)
  }
  chunks.push(Uint8Array.of(0x50, 0x4b, 0x01, 0x02))
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return out
}

function fragmented(bytes) {
  const sizes = [1, 2, 7, 503, 19, 1024]
  let at = 0
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      const end = Math.min(bytes.length, at + sizes[index++ % sizes.length])
      controller.enqueue(bytes.subarray(at, end))
      at = end
    },
  })
}

function memorySink(names = []) {
  const bodies = new Map()
  return {
    sink: {
      open(name) {
        names.push(name)
        const chunks = []
        return {
          write(chunk) { chunks.push(chunk.slice()) },
          close() {
            const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
            const body = new Uint8Array(size)
            let at = 0
            for (const chunk of chunks) { body.set(chunk, at); at += chunk.length }
            bodies.set(name, body)
          },
        }
      },
    },
    bodies,
  }
}

assert.equal(safePackPath('cstrike/maps/de_dust2.bsp'), 'cstrike/maps/de_dust2.bsp')
for (const path of ['../x', '/x', 'C:/x', 'a//b', 'a/./b']) assert.equal(safePackPath(path), null)
assert.equal(safePackPath('a\\b'), 'a/b')

const sample = memorySink()
const sampleResult = await unpackStoredZipStream(
  fragmented(storeZip([['cstrike/a.txt', 'A'], ['valve/b.txt', '0123456789']])),
  sample.sink,
  { name: 'sample', files: 2, bytes: 11 },
)
assert.deepEqual(sampleResult, { files: 2, bytes: 11 })
assert.equal(new TextDecoder().decode(sample.bodies.get('valve/b.txt')), '0123456789')
await assert.rejects(
  () => unpackStoredZipStream(fragmented(storeZip([['a', 'b']], true)), memorySink().sink, { name: 'bad' }),
  /CRC-32 不符/,
)
await assert.rejects(
  () => unpackStoredZipStream(fragmented(storeZip([['a', 'b']])), memorySink().sink, { name: 'bad-count', files: 2 }),
  /文件数不符/,
)

async function inspectEncoded(path, encoding, expected, collectNames) {
  const hash = createHash('sha256')
  const decoder = () => encoding === 'br' ? createBrotliDecompress() : createGunzip()
  // 浏览器解析器在中央目录处主动取消，线上靠逐文件 CRC；离线发布检查另跑一遍完整流来锁总 SHA。
  for await (const chunk of createReadStream(path).pipe(decoder())) hash.update(chunk)
  assert.equal(hash.digest('hex'), expected.archiveSha256, `${expected.file} 解码后 SHA-256 不符`)
  const stream = Readable.toWeb(createReadStream(path).pipe(decoder()))
  const names = []
  const sink = {
    open(name) {
      if (collectNames) names.push(name)
      return { write() {}, close() {} }
    },
  }
  const result = await unpackStoredZipStream(stream, sink, { name: expected.file, files: expected.files, bytes: expected.bytes })
  return { result, names }
}

const manifestPath = join(packDir, 'index.json')
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schema === 2) {
    assert(manifest.profiles?.cs, 'v2 清单必须有 CS profile')
    for (const [key, item] of Object.entries(manifest.packs)) {
      const primary = join(packDir, item.file)
      assert(existsSync(primary), `缺少 ${item.file}`)
      assert.equal(statSync(primary).size, item.encodedBytes, `${item.file} 长度不符`)
      const inspected = await inspectEncoded(primary, 'br', item, key === 'base-cs')
      if (key === 'base-cs') {
        assert(item.bytes < 160 * 1024 * 1024, 'CS 公共包展开后必须小于 160MB')
        assert(!inspected.names.some((name) => name === 'valve/pak0.pak' || /\/(?:maps|overviews)\//.test(name)), 'CS 公共包混入 PAK 或地图')
        assert(!inspected.names.some((name) => /\.(?:dll|dylib|exe|icns|so)$/i.test(name)), 'CS 公共包混入桌面动态库')
        for (const required of [
          'valve/models/w_weaponbox.mdl', 'valve/models/mil_crategibs.mdl',
          'cstrike/sound/sentences.txt', 'cstrike/sound/events/tutor_msg.wav',
        ]) assert(inspected.names.includes(required), `CS 公共包缺服务器必预载资源：${required}`)
      }
      if (key.startsWith('map-cs-')) {
        const map = key.slice('map-cs-'.length)
        const names = []
        await inspectEncoded(primary, 'br', item, true).then((value) => names.push(...value.names))
        assert(names.includes(`cstrike/maps/${map}.bsp`), `${key} 缺 BSP`)
      }
      if (item.fallback) {
        const fallback = join(packDir, item.fallback)
        assert(existsSync(fallback), `缺少 ${item.fallback}`)
        assert.equal(statSync(fallback).size, item.fallbackBytes, `${item.fallback} 长度不符`)
        await inspectEncoded(fallback, 'gzip', item, false)
      }
    }
    console.log(`CS15 v2 资源包测试通过（${Object.keys(manifest.packs).length} 个包，逐文件 CRC + 总 SHA-256）`)
  } else {
    console.log('CS15 ZIP 流解析器测试通过；当前仍是旧版资源清单，跳过 v2 实包检查')
  }
} else {
  console.log('CS15 ZIP 流解析器测试通过；本地没有资源清单，跳过实包检查')
}
