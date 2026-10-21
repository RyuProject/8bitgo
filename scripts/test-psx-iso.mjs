import assert from 'node:assert/strict'
import { psxIsoValidationProblem } from '../src/admin/psxIso.ts'

const bytes = new Uint8Array(2048 * 40)
bytes[0x8000] = 1
bytes.set(new TextEncoder().encode('CD001'), 0x8001)
bytes[0x8006] = 1
const view = new DataView(bytes.buffer)
view.setUint32(0x8000 + 156 + 2, 20, true)
view.setUint32(0x8000 + 156 + 10, 2048, true)
const name = new TextEncoder().encode('SYSTEM.CNF;1')
bytes[20 * 2048] = 33 + name.length
bytes[20 * 2048 + 32] = name.length
bytes.set(name, 20 * 2048 + 33)

assert.equal(await psxIsoValidationProblem(new Blob([bytes])), null)
const noBoot = new Uint8Array(bytes)
noBoot.set(new TextEncoder().encode('NOTSYSTEM.CNF'), 20 * 2048 + 33)
assert.match(await psxIsoValidationProblem(new Blob([noBoot])), /SYSTEM\.CNF/)
assert.match(await psxIsoValidationProblem(new Blob([bytes.subarray(0, 1500)])), /2048-byte/)
const badPvd = new Uint8Array(bytes)
badPvd[0x8001] = 0
assert.match(await psxIsoValidationProblem(new Blob([badPvd])), /ISO9660/)

console.log('✅ PS1 上传前 ISO9660 / SYSTEM.CNF 轻量校验通过')
