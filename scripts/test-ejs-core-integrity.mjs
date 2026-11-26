#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { EJS_CORE_VERSIONS } from '../src/emulator/ejsCoreVersionsData.ts'
import { renderEjsCoreResumeHelper } from './lib/ejs-core-resume-helper.mjs'

const asset = 'cores/prosystem-legacy-wasm.data'
const url = `https://8bitgo.test/emulatorjs/${asset}?v=${EJS_CORE_VERSIONS[asset]}`
const file = readFileSync(new URL(`../public/emulatorjs/${asset}`, import.meta.url))
const context = {
  URL,
  Uint8Array,
  ArrayBuffer,
  crypto: webcrypto,
  location: { href: 'https://8bitgo.test/', origin: 'https://8bitgo.test' },
}
context.globalThis = context
vm.runInNewContext(`${renderEjsCoreResumeHelper()};globalThis.__testCoreIntegrity=__8bgCoreResume`, context)
const helper = context.__testCoreIntegrity

assert.equal(helper.expectedCoreBytes(url), file.byteLength)
assert.equal(await helper.verifyCore(url, new Uint8Array(file)), true, '构建清单对应的真实 EmulatorJS 核心应通过 SHA-256')
assert.equal(await helper.verifyCachedCore(url, { files: [{ bytes: new Uint8Array(file) }] }), true,
  '核心 IndexedDB 缓存命中应核验内容')

const damaged = new Uint8Array(file)
damaged[Math.floor(damaged.byteLength / 2)] ^= 0xff
await assert.rejects(helper.verifyCore(url, damaged), /SHA-256 mismatch/)
await assert.rejects(helper.verifyCachedCore(url, { files: [{ bytes: damaged }] }), /SHA-256 mismatch/)
await assert.rejects(helper.verifyCore(url, damaged.subarray(1)), /length mismatch/)
await assert.rejects(helper.verifyCore(url.replace(EJS_CORE_VERSIONS[asset], '0000000000000000'), new Uint8Array(file)), /version mismatch/)

console.log('✔ EmulatorJS 核心真实下载字节与缓存命中均按 SHA-256 分块清单校验')
