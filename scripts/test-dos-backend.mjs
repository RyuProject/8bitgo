import assert from 'node:assert/strict'
import { dosBackendOf, gameApiToPartialRow, gameApiToRow, gameRowToApi } from '../server/src/mappers.js'

assert.equal(dosBackendOf('dosboxX'), 'dosboxX')
assert.equal(dosBackendOf('dosbox'), null)
assert.equal(dosBackendOf('DOSBOX-X'), null)
assert.equal(dosBackendOf(undefined), null)

assert.equal(gameRowToApi({ slug: 'win95', dos_backend: 'dosboxX' }).dosBackend, 'dosboxX')
assert.equal(gameRowToApi({ slug: 'dos', dos_backend: null }).dosBackend, undefined)

assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX' }).dos_backend, 'dosboxX')
assert.equal(gameApiToRow({ slug: 'dos', dosBackend: 'dosbox' }).dos_backend, null)

assert.deepEqual(gameApiToPartialRow({ dosBackend: 'dosboxX' }), { dos_backend: 'dosboxX' })
assert.deepEqual(gameApiToPartialRow({ dosBackend: undefined }), { dos_backend: null })

console.log('DOS / Windows 9x 核心映射测试通过')
