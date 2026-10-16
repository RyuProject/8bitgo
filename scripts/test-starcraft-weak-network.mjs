import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ROM_PACK_CODEC,
  ROM_PACK_VERSION,
  bytesToBase64Url,
  encodeRomPackPrefix,
} from '../shared/rom-pack-format.js'
import {
  inspectRemoteRomPack,
  ROM_PACK_ARRAY_BUFFER_LIMIT,
} from '../src/services/romPack.ts'
import { allowsSpeculativePlayerPreload } from '../src/emulator/preloadPolicy.ts'

assert.equal(allowsSpeculativePlayerPreload({ saveData: true, effectiveType: '4g' }), false)
assert.equal(allowsSpeculativePlayerPreload({ effectiveType: '3g', downlink: 10 }), false)
assert.equal(allowsSpeculativePlayerPreload({ effectiveType: '4g', downlink: 1.5 }), false)
assert.equal(allowsSpeculativePlayerPreload({ effectiveType: '4g', downlink: 10, rtt: 450 }), false)
assert.equal(allowsSpeculativePlayerPreload({ effectiveType: '4g', downlink: 10, rtt: 80 }), true)
assert.equal(allowsSpeculativePlayerPreload(), true, 'Safari 没有 Network Information API 时维持原来的预热')

const originalSize = 1_493_743_659
const chunkSize = 64 * 1024 * 1024
const chunks = Array.from({ length: Math.ceil(originalSize / chunkSize) }, (_, index) => {
  const sourceSize = Math.min(chunkSize, originalSize - index * chunkSize)
  return { sourceSize, encodedSize: sourceSize, cipherSize: sourceSize + 16, sha256: 'b'.repeat(64) }
})
const header = {
  version: ROM_PACK_VERSION,
  packageId: '0123456789abcdef0123456789abcdef',
  keyId: 'v1',
  codec: ROM_PACK_CODEC.STORE,
  codecVersion: 1,
  codecOptions: {},
  cipher: 'aes-256-gcm',
  originalName: 'StarCraft-Complete.zip',
  originalSize,
  originalSha256: 'a'.repeat(64),
  chunkSize,
  noncePrefix: bytesToBase64Url(new Uint8Array(8)),
  chunks,
  payloadSize: chunks.reduce((total, chunk) => total + chunk.cipherSize, 0),
  createdAt: '2026-10-16T00:00:00.000Z',
}
const prefix = encodeRomPackPrefix(header)
const remoteTotal = prefix.byteLength + header.payloadSize
const ranges = []
const fakeFetch = async (_url, init) => {
  const range = String(init?.headers?.Range || '')
  ranges.push(range)
  const end = Math.min(Number(range.match(/-(\d+)$/)?.[1]), prefix.byteLength - 1)
  const body = prefix.slice(0, end + 1)
  return new Response(body, {
    status: 206,
    headers: { 'Content-Range': `bytes 0-${end}/${remoteTotal}` },
  })
}

const inspected = await inspectRemoteRomPack('https://assets.test/starcraft.8bg', undefined, fakeFetch)
assert.equal(inspected?.originalSize, header.originalSize)
assert.ok(header.originalSize > ROM_PACK_ARRAY_BUFFER_LIMIT)
assert.equal(ranges.length, 1, '常见文件头应只需一次小 Range 请求')

let cancelled = false
const noRange = await inspectRemoteRomPack('https://assets.test/no-range.8bg', undefined, async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
    },
    cancel() {
      cancelled = true
    },
  })
  return new Response(stream, { status: 200 })
})
assert.equal(noRange, null)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(cancelled, true, 'Range 被忽略时必须立刻取消响应体，不能把整包当预检下载')

const jsdos = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
assert.match(jsdos, /inspectRemoteRomPack\(game, signal\)/)
assert.match(jsdos, /尚未配置流式游戏盘/)
assert.match(jsdos, /Boolean\(options\.dosSystemUrl\)/)

const ageGate = readFileSync(new URL('../src/components/game/AgeGate.tsx', import.meta.url), 'utf8')
assert.match(ageGate, /ACCESS_REQUEST_TIMEOUT_MS = 8_000/)
assert.match(ageGate, /controller\.abort\(new DOMException\('年龄检查请求超时'/)
assert.match(ageGate, /controller\.signal/)
assert.match(ageGate, /requestController\?\.abort\(\)/)

const playerChunk = readFileSync(new URL('../src/emulator/PlayerChunk.tsx', import.meta.url), 'utf8')
assert.match(playerChunk, /allowsSpeculativePlayerPreload\(connection\)/)

console.log('StarCraft 弱网保护通过：年龄检查有限超时，超大 8BG 在下载前拦截，Range 失效不会误吞整包')
