import assert from 'node:assert/strict'
import {
  dosBackendOf,
  dosLaunchDelayOf,
  dosMouseCaptureOf,
  dosSystemOf,
  gameApiToPartialRow,
  gameApiToRow,
  gameRowToApi,
} from '../server/src/mappers.js'

assert.equal(dosBackendOf('dosboxX'), 'dosboxX')
assert.equal(dosBackendOf('dosbox'), null)
assert.equal(dosBackendOf('DOSBOX-X'), null)
assert.equal(dosBackendOf(undefined), null)
assert.equal(dosMouseCaptureOf(true), 1)
assert.equal(dosMouseCaptureOf(false), 0)
assert.equal(dosMouseCaptureOf(undefined), null)

const win95 = gameRowToApi({
  slug: 'win95',
  dos_backend: 'dosboxX',
  dos_mouse_capture: 1,
  dos_system: 'systems/win95.jsdos',
  dos_launch_delay: 24,
})
assert.equal(win95.dosBackend, 'dosboxX')
assert.equal(win95.dosMouseCapture, true)
assert.equal(win95.dosSystem, 'systems/win95.jsdos')
assert.equal(win95.dosLaunchDelay, 24)
assert.equal(gameRowToApi({ slug: 'dos', dos_backend: null }).dosBackend, undefined)
assert.equal(gameRowToApi({ slug: 'dos', dos_mouse_capture: 0 }).dosMouseCapture, false)

assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX', dosSystem: 'systems/win95.jsdos', dosLaunchDelay: 24 }).dos_backend, 'dosboxX')
assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX', dosSystem: 'systems/win95.jsdos', dosLaunchDelay: 24 }).dos_system, 'systems/win95.jsdos')
assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX', dosSystem: 'systems/win95.jsdos', dosLaunchDelay: 24 }).dos_launch_delay, 24)
assert.equal(gameApiToRow({ slug: 'dos', dosBackend: 'dosbox' }).dos_backend, null)
assert.equal(gameApiToRow({ slug: 'theme-hospital', dosMouseCapture: true }).dos_mouse_capture, 1)
assert.equal(gameApiToRow({ slug: 'dos', dosMouseCapture: false }).dos_mouse_capture, 0)

assert.deepEqual(gameApiToPartialRow({ dosBackend: 'dosboxX' }), { dos_backend: 'dosboxX' })
assert.deepEqual(gameApiToPartialRow({ dosBackend: undefined }), { dos_backend: null })
assert.deepEqual(gameApiToPartialRow({ dosMouseCapture: false }), { dos_mouse_capture: 0 })
assert.deepEqual(gameApiToPartialRow({ dosMouseCapture: undefined }), { dos_mouse_capture: null })

assert.equal(dosSystemOf(' systems/win98.jsdos '), 'systems/win98.jsdos')
assert.equal(dosSystemOf('bad\nvalue'), null)
assert.equal(dosLaunchDelayOf(2), 5)
assert.equal(dosLaunchDelayOf(999), 120)
assert.deepEqual(gameApiToPartialRow({ dosSystem: '', dosLaunchDelay: undefined }), {
  dos_system: null,
  dos_launch_delay: null,
})

console.log('DOS / Windows 9x 核心映射测试通过')
