#!/usr/bin/env node
/** 用真实核心字节验证运行时摘要与 SRI 生成，篡改、截断必须在交给模拟器前拒绝。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { BINJGB_ASSETS, applyPinnedScriptIntegrity, sha256Sri, verifyPinnedAssetBytes } from '../src/emulator/coreAssetIntegrity.ts'
import { IODINEGBA_SHA256 } from '../src/emulator/iodinegbaVersion.ts'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const wasm = readFileSync(new URL('../public/binjgb/binjgb.wasm', import.meta.url))
const verified = await verifyPinnedAssetBytes(wasm, BINJGB_ASSETS.wasm)
assert.equal(WebAssembly.validate(verified), true, '真实 Binjgb WASM 应在摘要通过后仍是有效模块')

const damaged = new Uint8Array(wasm)
damaged[Math.floor(damaged.length / 2)] ^= 0xff
await assert.rejects(verifyPinnedAssetBytes(damaged, BINJGB_ASSETS.wasm), /SHA-256 不匹配/)
await assert.rejects(verifyPinnedAssetBytes(damaged.subarray(1), BINJGB_ASSETS.wasm), /长度不符/)
await assert.rejects(verifyPinnedAssetBytes(wasm, { ...BINJGB_ASSETS.wasm, sha256: '0'.repeat(64) }), /SHA-256 不匹配/)

const script = { integrity: '', crossOrigin: '' }
applyPinnedScriptIntegrity(script, BINJGB_ASSETS.wasmScript.sha256)
assert.equal(script.integrity, sha256Sri(BINJGB_ASSETS.wasmScript.sha256))
assert.equal(script.crossOrigin, 'anonymous')
assert.match(sha256Sri(IODINEGBA_SHA256), /^sha256-[A-Za-z0-9+/]+=*$/)
assert.throws(() => sha256Sri('not-a-sha256'), /SHA-256 配置无效/)

const binjgbAdapter = readFileSync(new URL('../src/emulator/adapters/binjgb.ts', import.meta.url), 'utf8')
const iodineAdapter = readFileSync(new URL('../src/emulator/adapters/iodinegba.ts', import.meta.url), 'utf8')
assert.match(binjgbAdapter, /applyPinnedScriptIntegrity\(script/)
assert.match(binjgbAdapter, /verifyPinnedAssetBytes\(bytes, BINJGB_ASSETS\.wasm\)/)
assert.match(binjgbAdapter, /wasmBinary\s*\}/, '必须把已核验的 WASM 字节传给 Emscripten，避免第二次裸下载')
assert.match(iodineAdapter, /applyPinnedScriptIntegrity\(script, IODINEGBA_SHA256\)/)

console.log('✔ Binjgb / IodineGBA 核心在运行时加载前做 SRI / SHA-256 校验')
