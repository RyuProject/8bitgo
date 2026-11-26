#!/usr/bin/env node
/** 运行时回归：执行 PPSSPP 实际校验器，确认正确核心放行、任意字节损坏被拦截。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const shellDir = new URL('../public/ppsspp/v0dbfaca/v26/', import.meta.url)
const coreDir = new URL('../public/ppsspp/v0dbfaca/v25/', import.meta.url)
const host = readFileSync(new URL('host.js', shellDir), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('runtime.json', shellDir), 'utf8'))
const events = new Map()
const nativeFetchQueue = []
const nativeFetchCalls = []
const window = {
  fetch: async (input, init = {}) => {
    nativeFetchCalls.push({ url: String(input), init })
    const response = nativeFetchQueue.shift()
    if (!response) throw new Error('test harness 没有排队该核心响应')
    return response
  },
  addEventListener(type, listener) { events.set(type, listener) },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  parent: { postMessage() {} },
}
const document = {
  getElementById: (id) => ({ id, style: {}, dataset: {}, setAttribute() {}, removeAttribute() {} }),
  createElement: () => ({ style: {}, dataset: {}, setAttribute() {} }),
  head: { appendChild() {} },
}
const location = new URL('https://8bitgo.test/ppsspp/v0dbfaca/v26/index.html?embed=1&edge=cn')
const WebAssemblyShim = {
  Module: WebAssembly.Module,
  async instantiate(source) { return { bytes: source.byteLength, ok: true } },
  async instantiateStreaming(response) { return { bytes: (await response.arrayBuffer()).byteLength, ok: true } },
}
const context = vm.createContext({
  window,
  document,
  location,
  URL,
  URLSearchParams,
  WebAssembly: WebAssemblyShim,
  AbortController,
  Uint8Array,
  ArrayBuffer,
  TextEncoder,
  Response,
  ReadableStream,
  crypto: webcrypto,
  navigator: { hardwareConcurrency: 4, userAgent: 'node-test' },
  console: { warn() {}, info() {}, error() {}, log() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
})
vm.runInContext(host, context, { filename: 'ppsspp-v26-host.js' })

const integrity = window.__8bitgoPspCoreIntegrity
assert.ok(integrity, 'v26 host 必须装载实际使用的 PSP 核心校验器')
const data = readFileSync(new URL('PPSSPPSDL.data', coreDir))
const wasm = readFileSync(new URL('PPSSPPSDL.wasm', coreDir))
assert.equal(manifest.integrityBlocks['PPSSPPSDL.data'].bytes, data.byteLength)
assert.equal(manifest.integrityBlocks['PPSSPPSDL.wasm'].bytes, wasm.byteLength)

await integrity.verifyCoreBytes(data, 'PPSSPPSDL.data')
await integrity.verifyCoreBytes(wasm, 'PPSSPPSDL.wasm')

const badData = new Uint8Array(data)
badData[31] ^= 0xff
await assert.rejects(integrity.verifyCoreBytes(badData, 'PPSSPPSDL.data'), /SHA-256 校验失败/)
await assert.rejects(integrity.verifyCoreBytes(data.subarray(0, data.byteLength - 1), 'PPSSPPSDL.data'), /长度与可信清单不符/)

// 以不同于校验块的边界送入真实 Wasm，覆盖网络 chunk 与 2 MiB 校验块错位的情况。
let offset = 0
const streamedWasm = new Response(new ReadableStream({
  pull(controller) {
    if (offset >= wasm.byteLength) {
      controller.close()
      return
    }
    const end = Math.min(wasm.byteLength, offset + 131_071)
    controller.enqueue(wasm.subarray(offset, end))
    offset = end
  },
}))
await integrity.verifyCoreResponse(streamedWasm, 'PPSSPPSDL.wasm')

const corruptStream = new Uint8Array(manifest.blockBytes)
await assert.rejects(
  integrity.verifyCoreResponse(new Response(corruptStream), 'PPSSPPSDL.wasm'),
  /SHA-256 校验失败/,
)

// 两个同源/加速入口请求并发时，必须把完整性 Promise 绑定到各自 Response，不能串用最后一次请求的结果。
const edgeBase = 'https://cn.8bitgo.test/_cn/ppsspp/v0dbfaca/v25/'
const edgeUrlA = `${edgeBase}PPSSPPSDL.wasm?request=a`
const edgeUrlB = `${edgeBase}PPSSPPSDL.wasm?request=b`
const corruptWasm = new Uint8Array(wasm)
corruptWasm[31] ^= 0xff
nativeFetchQueue.push(new Response(corruptWasm), new Response(wasm), new Response(wasm))
const [responseA, responseB] = await Promise.all([
  window.fetch(edgeUrlA, { cache: 'force-cache' }),
  window.fetch(edgeUrlB, { cache: 'force-cache' }),
])
const [badInstantiation, goodInstantiation] = await Promise.allSettled([
  WebAssemblyShim.instantiateStreaming(responseA, {}),
  WebAssemblyShim.instantiateStreaming(responseB, {}),
])
assert.equal(badInstantiation.status, 'rejected', '损坏的 EdgeOne 响应必须按自己的校验 Promise 拒绝')
assert.equal(goodInstantiation.status, 'fulfilled', '并发中的正确核心不能被另一份损坏响应误伤')

// Emscripten 在流式编译失败后会用同一 URL 再取 ArrayBuffer；第二次必须跳过 EdgeOne、改从同版本源站重取。
const recoveredResponse = await window.fetch(edgeUrlA, { cache: 'force-cache' })
assert.equal(nativeFetchCalls[2].url, 'https://8bitgo.test/ppsspp/v0dbfaca/v25/PPSSPPSDL.wasm?request=a')
assert.equal(nativeFetchCalls[2].init.cache, 'reload')
const recoveredBytes = await recoveredResponse.arrayBuffer()
assert.deepEqual(await WebAssemblyShim.instantiate(recoveredBytes, {}), { bytes: wasm.byteLength, ok: true })
const badBytes = new Uint8Array(wasm)
badBytes[31] ^= 0xff
await assert.rejects(WebAssemblyShim.instantiate(badBytes, {}), /SHA-256 校验失败/)

console.log('✔ PPSSPP 运行时 SHA-256：正确核心放行、截断与篡改拒绝、流式分块边界、并发隔离和 EdgeOne 回源恢复通过')
