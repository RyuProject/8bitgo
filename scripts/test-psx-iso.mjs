import assert from 'node:assert/strict'
import { psxIsoValidationProblem } from '../src/admin/psxIso.ts'

const bytes = new Uint8Array(2048 * 40)
bytes[0x8000] = 1
bytes.set(new TextEncoder().encode('CD001'), 0x8001)
bytes[0x8006] = 1
const view = new DataView(bytes.buffer)
view.setUint16(0x8000 + 128, 2048, true)
view.setUint16(0x8000 + 130, 2048, false)
const rootRecord = 0x8000 + 156
bytes[rootRecord] = 34
view.setUint32(rootRecord + 2, 20, true)
view.setUint32(rootRecord + 6, 20, false)
view.setUint32(rootRecord + 10, 2048, true)
view.setUint32(rootRecord + 14, 2048, false)
bytes[rootRecord + 25] = 2
bytes[rootRecord + 32] = 1
bytes[rootRecord + 33] = 0
const name = new TextEncoder().encode('SYSTEM.CNF;1')
const entry = 20 * 2048
bytes[entry] = 33 + name.length
view.setUint32(entry + 2, 21, true)
view.setUint32(entry + 6, 21, false)
view.setUint32(entry + 10, 64, true)
view.setUint32(entry + 14, 64, false)
bytes[entry + 32] = name.length
bytes.set(name, entry + 33)

assert.equal(await psxIsoValidationProblem(new Blob([bytes])), null)
const noBoot = new Uint8Array(bytes)
// 保持目录记录长度不变，只改文件名；否则会覆盖下一条记录并测试到损坏 ISO。
noBoot[20 * 2048 + 33] = 'N'.charCodeAt(0)
assert.match(await psxIsoValidationProblem(new Blob([noBoot])), /SYSTEM\.CNF/)
assert.match(await psxIsoValidationProblem(new Blob([bytes.subarray(0, 1500)])), /2048-byte/)
const badPvd = new Uint8Array(bytes)
badPvd[0x8001] = 0
assert.match(await psxIsoValidationProblem(new Blob([badPvd])), /ISO9660/)

console.log('✅ PS1 上传前 ISO9660 / SYSTEM.CNF 轻量校验通过')
