import assert from 'node:assert/strict'
import {
  dosBackendOf,
  dosboxConfigOf,
  dosLaunchDelayOf,
  dosSystemOf,
  dosWindowsVersionOf,
  gameApiToPartialRow,
  gameApiToRow,
  gameRowToApi,
} from '../server/src/mappers.js'

assert.equal(dosBackendOf('dosboxX'), 'dosboxX')
assert.equal(dosBackendOf('dosbox'), null)
assert.equal(dosBackendOf('DOSBOX-X'), null)
assert.equal(dosBackendOf(undefined), null)
assert.equal(dosboxConfigOf(' [gus]\r\ngus=false '), '[gus]\ngus=false')
assert.equal(dosboxConfigOf(undefined), null)
assert.throws(() => dosboxConfigOf('[autoexec]\nmount c .'), /不允许编辑/)
assert.throws(() => dosboxConfigOf('[sdl]\nmouse_emulation=always'), /统一管理/)

const win95 = gameRowToApi({
  slug: 'win95',
  dos_backend: 'dosboxX',
  dos_system: 'systems/win95.jsdos',
  dos_launch_delay: 24,
  dosbox_config_override: '[gus]\ngus=false',
})
assert.equal(win95.dosBackend, 'dosboxX')
assert.equal(win95.dosSystem, 'systems/win95.jsdos')
assert.equal(win95.dosLaunchDelay, 24)
assert.equal(win95.dosboxConfig, '[gus]\ngus=false')
assert.equal(gameRowToApi({ slug: 'dos', dos_backend: null }).dosBackend, undefined)

assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX', dosSystem: 'systems/win95.jsdos', dosLaunchDelay: 24 }).dos_backend, 'dosboxX')
assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX', dosSystem: 'systems/win95.jsdos', dosLaunchDelay: 24 }).dos_system, 'systems/win95.jsdos')
assert.equal(gameApiToRow({ slug: 'win95', dosBackend: 'dosboxX', dosSystem: 'systems/win95.jsdos', dosLaunchDelay: 24 }).dos_launch_delay, 24)
assert.equal(gameApiToRow({ slug: 'dos', dosBackend: 'dosbox' }).dos_backend, null)
assert.equal(gameApiToRow({ slug: 'win95', dosboxConfig: '[cpu]\ncycles=20000' }).dosbox_config_override, '[cpu]\ncycles=20000')

assert.deepEqual(gameApiToPartialRow({ dosBackend: 'dosboxX' }), { dos_backend: 'dosboxX' })
assert.deepEqual(gameApiToPartialRow({ dosBackend: undefined }), { dos_backend: null })
assert.deepEqual(gameApiToPartialRow({ dosboxConfig: '' }), { dosbox_config_override: null })

assert.equal(dosSystemOf(' systems/win98.jsdos '), 'systems/win98.jsdos')
assert.equal(dosSystemOf('bad\nvalue'), null)
assert.equal(dosWindowsVersionOf('3x'), '3x')
assert.equal(dosWindowsVersionOf('9x'), '9x')
assert.equal(dosWindowsVersionOf('win31'), null)
assert.equal(dosLaunchDelayOf(2), 5)
assert.equal(dosLaunchDelayOf(999), 120)
assert.deepEqual(gameApiToPartialRow({ dosSystem: '', dosLaunchDelay: undefined }), {
  dos_system: null,
  dos_launch_delay: null,
})

const win31 = gameRowToApi({
  slug: 'win31',
  dos_backend: 'dosboxX',
  dos_system: 'systems/win31.jsdos',
  dos_windows_version: '3x',
})
assert.equal(win31.dosWindowsVersion, '3x')
assert.equal(gameApiToRow({ slug: 'win31', dosWindowsVersion: '3x' }).dos_windows_version, '3x')
assert.deepEqual(gameApiToPartialRow({ dosWindowsVersion: '9x' }), { dos_windows_version: '9x' })

console.log('DOS / Windows 客体核心映射测试通过')
