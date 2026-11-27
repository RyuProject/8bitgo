#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { createVerifiedInstantiateAsync, patchEmscriptenWasmLoader } from './lib/jsdos-wasm-integrity.mjs'

const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const goodBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 9, 8, 7, 6])
const expected = { file: 'wdosbox.wasm', bytes: goodBytes.byteLength, sha256: hex(goodBytes) }

function makeRuntime({ fetch, webAssembly, crypto = webcrypto }) {
  const context = vm.createContext({
    fetch,
    crypto,
    Uint8Array,
    ArrayBuffer,
    WebAssembly: webAssembly,
    globalThis: null,
  })
  context.globalThis = context
  vm.runInContext(`${createVerifiedInstantiateAsync(expected)}\nglobalThis.runVerified = instantiateAsync`, context)
  return context.runVerified
}

function streamResponse(chunks, options = {}) {
  let index = 0
  let cancelled = false
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true }
            return { done: false, value: chunks[index++] }
          },
          async cancel() { cancelled = true },
        }
      },
    },
    async arrayBuffer() { return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).buffer },
    wasCancelled: () => cancelled,
  }
}

let fetchCount = 0
let instantiateCount = 0
let received = null
const wasm = {
  async instantiate(bytes, imports) {
    instantiateCount++
    received = new Uint8Array(bytes)
    return { instance: { exports: { ok: true } }, module: { imports } }
  },
}

const goodResponse = streamResponse([goodBytes.subarray(0, 5), goodBytes.subarray(5)])
const runGood = makeRuntime({
  fetch: async (url, init) => { fetchCount++; assert.equal(url, '/emulators/wdosbox.wasm'); assert.equal(init.credentials, 'same-origin'); return goodResponse },
  webAssembly: wasm,
})
const goodResult = await runGood(undefined, '/emulators/wdosbox.wasm', { env: true })
assert.equal(goodResult.instance.exports.ok, true)
assert.equal(fetchCount, 1, '验证过程只发起一次下载')
assert.equal(instantiateCount, 1)
assert.deepEqual(Buffer.from(received), Buffer.from(goodBytes))

const damaged = goodBytes.slice()
damaged[damaged.length - 1] ^= 1
const beforeTamper = instantiateCount
const runTamper = makeRuntime({ fetch: async () => streamResponse([damaged]), webAssembly: wasm })
await assert.rejects(runTamper(undefined, '/emulators/wdosbox.wasm', {}), /SHA-256 不匹配/)
assert.equal(instantiateCount, beforeTamper, '摘要失败时绝不编译 WASM')

const runShort = makeRuntime({ fetch: async () => streamResponse([goodBytes.subarray(0, -1)]), webAssembly: wasm })
await assert.rejects(runShort(undefined, '/emulators/wdosbox.wasm', {}), /下载不完整/)
assert.equal(instantiateCount, beforeTamper, '截断响应时绝不编译 WASM')

const overlong = streamResponse([goodBytes, Uint8Array.of(1)])
const runLong = makeRuntime({ fetch: async () => overlong, webAssembly: wasm })
await assert.rejects(runLong(undefined, '/emulators/wdosbox.wasm', {}), /超过可信长度/)
assert.equal(overlong.wasCancelled(), true, '超过可信长度时取消流')

const runHttpError = makeRuntime({ fetch: async () => streamResponse([], { ok: false, status: 502 }), webAssembly: wasm })
await assert.rejects(runHttpError(undefined, '/emulators/wdosbox.wasm', {}), /请求失败：502/)

const beforeMissingCrypto = instantiateCount
const runNoCrypto = makeRuntime({ fetch: async () => streamResponse([goodBytes]), webAssembly: wasm, crypto: null })
await assert.rejects(runNoCrypto(undefined, '/emulators/wdosbox.wasm', {}), /不支持 js-dos WASM SHA-256/)
assert.equal(instantiateCount, beforeMissingCrypto, '缺少 SHA-256 时关闭启动，不运行未校验核心')

const source = `function findWasmBinary(){return locateFile("wdosbox.wasm")}function getBinarySync(file){}async function instantiateAsync(binary,binaryFile,imports){if(!binary&&!isFileURI(binaryFile)&&!ENVIRONMENT_IS_NODE){try{var response=fetch(binaryFile,{credentials:"same-origin"});var instantiationResult=await WebAssembly.instantiateStreaming(response,imports);return instantiationResult}catch(reason){err("wasm streaming compile failed: "+reason);err("falling back to ArrayBuffer instantiation")}}return instantiateArrayBuffer(binaryFile,imports)}function getWasmImports(){return {}}`
const patched = patchEmscriptenWasmLoader(source, expected)
assert.match(patched, /__8bitgoWasmIntegrity=Object\.freeze/)
assert.match(patched, /crypto\.subtle\.digest\("SHA-256"/)
assert.doesNotMatch(patched, /WebAssembly\.instantiateStreaming/)
assert.throws(() => patchEmscriptenWasmLoader(source, { ...expected, file: 'other.wasm' }), /定位结构与可信清单不符/)
assert.throws(() => createVerifiedInstantiateAsync({ ...expected, sha256: 'bad' }), /配置无效/)

console.log('✔ js-dos DOSBox / 压缩 / 网络 WASM 单次流式下载后校验长度与 SHA-256，再编译；篡改、截断、超长、HTTP 错误与无 WebCrypto 均失败关闭')
