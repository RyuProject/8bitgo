#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import {
  verifyPlayWasmResponse,
  preloadVerifiedPlayModule,
  PLAY_JS_SHA256,
  PLAY_WASM_BYTES,
  PLAY_WASM_SHA256,
} from '../src/emulator/playIntegrity.ts'

const runtime = JSON.parse(readFileSync(new URL('../public/play/runtime.json', import.meta.url), 'utf8'))
const record = runtime.files[`${runtime.runtimePath}/Play.wasm`]
const jsRecord = runtime.files[`${runtime.runtimePath}/Play.js`]
const wasm = readFileSync(new URL(`../public/play/${runtime.runtimePath}/Play.wasm`, import.meta.url))
const js = readFileSync(new URL(`../public/play/${runtime.runtimePath}/Play.js`, import.meta.url))
assert.equal(record.bytes, PLAY_WASM_BYTES)
assert.equal(record.sha256, PLAY_WASM_SHA256)
assert.equal(wasm.byteLength, PLAY_WASM_BYTES)
assert.equal(jsRecord.sha256, PLAY_JS_SHA256)
assert.equal(createHash('sha256').update(js).digest('hex'), PLAY_JS_SHA256)
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
assert.ok(globalThis.crypto?.subtle, '测试运行时必须提供 WebCrypto SHA-256')

const moduleLink = {
  relList: { supports: (value) => value === 'modulepreload' },
  remove() { this.removed = true },
  removed: false,
}
const moduleDocument = {
  createElement: (tag) => { assert.equal(tag, 'link'); return moduleLink },
  head: { append: (link) => queueMicrotask(() => link.onload?.()) },
}
await preloadVerifiedPlayModule('/play/Play.js', moduleDocument)
assert.equal(moduleLink.rel, 'modulepreload')
assert.equal(moduleLink.as, 'script')
assert.equal(moduleLink.href, '/play/Play.js')
assert.equal(moduleLink.crossOrigin, 'anonymous')
assert.equal(moduleLink.integrity, `sha256-${createHash('sha256').update(js).digest('base64')}`)
assert.equal(moduleLink.removed, true)

const rejectedLink = {
  relList: { supports: () => true },
  remove() { this.removed = true },
}
await assert.rejects(preloadVerifiedPlayModule('/play/bad.js', {
  createElement: () => rejectedLink,
  head: { append: (link) => queueMicrotask(() => link.onerror?.()) },
}), /SRI 完整性校验不匹配/)
assert.equal(rejectedLink.removed, true)

await assert.rejects(preloadVerifiedPlayModule('/play/Play.js', {
  createElement: () => ({ relList: { supports: () => false } }),
  head: { append: () => assert.fail('不支持 modulepreload 时不能发未校验导入') },
}), /不支持安全加载/)

const stalledLink = {
  relList: { supports: () => true },
  remove() { this.removed = true },
}
await assert.rejects(preloadVerifiedPlayModule('/play/slow.js', {
  createElement: () => stalledLink,
  head: { append: () => {} },
}, 5), /预加载超时/)
assert.equal(stalledLink.removed, true, '超时后移除挂起的 modulepreload')

const accepted = await verifyPlayWasmResponse(new Response(wasm, { headers: {
  'Content-Type': 'application/wasm',
  'Content-Length': String(wasm.byteLength),
  'Content-Encoding': 'br',
} }))
assert.equal(accepted.headers.get('content-type'), 'application/wasm')
assert.equal(accepted.headers.has('content-encoding'), false, '已解码响应不能保留压缩编码头')
assert.equal(accepted.headers.has('content-length'), false, '重建 Response 不能沿用旧长度头')
assert.deepEqual(Buffer.from(await accepted.arrayBuffer()), wasm)

const corrupted = Buffer.from(wasm)
corrupted[corrupted.length >> 1] ^= 0x80
await assert.rejects(verifyPlayWasmResponse(new Response(corrupted)), /SHA-256 不匹配/)
await assert.rejects(verifyPlayWasmResponse(new Response(wasm.subarray(0, -1))), /长度不符/)
await assert.rejects(verifyPlayWasmResponse(new Response('error page', { status: 503 })), /HTTP 503/)

console.log('✔ Play! 浏览器端核心校验：真实 WASM 放行，篡改、截断和 HTTP 错误均拒绝')
