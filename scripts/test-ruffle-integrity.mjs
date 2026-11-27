import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { applyRuffleScriptIntegrity, installRuffleRuntimeIntegrity, verifyRuffleWasmResponse } from '../src/emulator/ruffleIntegrity.ts'

const root = 'https://edge.example/ruffle/v0.7.1-8bitgo.1/'
const base = 'https://8bitgo.com/flash-frames/game/frame.html'
const modernWasm = 'fc897fa050f6083d84aa.wasm'
const wasmBytes = new Uint8Array(await readFile(new URL(`../public/ruffle/v0.7.1-8bitgo.1/${modernWasm}`, import.meta.url)))

const script = { integrity: '', crossOrigin: '', _src: '', setAttribute(name, value) { this[name] = value } }
applyRuffleScriptIntegrity(script, `${root}ruffle.js`, root, base)
assert.equal(script.integrity, 'sha256-hBisUL0l99zouBuEwC/bq53jo1X37nMP4LGePwRV2NI=')
assert.equal(script.crossOrigin, 'anonymous')

class FakeScript {}
Object.defineProperty(FakeScript.prototype, 'src', {
  configurable: true,
  get() { return this._src },
  set(value) { this._src = value },
})
FakeScript.prototype.setAttribute = function(name, value) { this[name] = value }
const originalAttribute = FakeScript.prototype.setAttribute
const requested = []
let respond = () => new Response(wasmBytes.slice(), { headers: { 'content-type': 'application/wasm', 'content-length': String(wasmBytes.byteLength) } })
const win = {
  HTMLScriptElement: FakeScript,
  fetch: async (input) => {
    requested.push(String(input))
    return respond()
  },
}
const doc = { baseURI: base }
const restore = installRuffleRuntimeIntegrity(win, doc, () => root)

const dynamicScript = new FakeScript()
dynamicScript.src = `${root}core.ruffle.1e8ba0ba354ac1c1caa1.js`
assert.equal(dynamicScript.integrity, 'sha256-QxF2YJQ/vKmFPh+aCqb0L1sw8q2eTAo8fGfVnRzrbLA=')
assert.equal(dynamicScript.crossOrigin, 'anonymous')
const attrScript = new FakeScript()
attrScript.setAttribute('src', `${root}core.ruffle.d9827e036807622b5ae9.js`)
assert.equal(attrScript.integrity, 'sha256-+My0oa+3Vop1GeXKFMGbjj4ranc4gvSdg/r/OrA+7mQ=')

const verified = await win.fetch(`${root}${modernWasm}`)
assert.equal(verified.status, 200)
assert.equal(verified.headers.get('content-length'), null)
assert.deepEqual(new Uint8Array(await verified.arrayBuffer()), wasmBytes)
assert.equal(requested.length, 1, '摘要必须复用真实下载，不应为验签重复请求核心')

respond = () => new Response(new Uint8Array([0, 1, 2, 3]))
await assert.rejects(() => win.fetch(`${root}${modernWasm}`), /Ruffle WASM SHA-256 不匹配/)

const passthrough = new Response('font')
respond = () => passthrough
assert.equal(await win.fetch('https://fonts.example/font.swf'), passthrough, '外部字体请求不应被核心规则拦截')

restore()
assert.equal(FakeScript.prototype.setAttribute, originalAttribute)
console.log('✔ Ruffle ruffle.js / 动态核心 JS 使用 SRI；WASM 下载复用原响应验 SHA-256，篡改失败关闭')
