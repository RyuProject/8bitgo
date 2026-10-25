import assert from 'node:assert/strict'
import { isValidPlatformBiosKey } from '../src/platform-bios-key.js'

assert.equal(isValidPlatformBiosKey('psx'), true)
assert.equal(isValidPlatformBiosKey('bios:neogeo'), true)
assert.equal(isValidPlatformBiosKey('bios:psx-jp'), true)
assert.equal(isValidPlatformBiosKey('bios:psx-us'), true)
assert.equal(isValidPlatformBiosKey('bios:psx-eu'), true)
assert.equal(isValidPlatformBiosKey('bios:pgm'), true)
assert.equal(isValidPlatformBiosKey('bios:-psx'), false)
assert.equal(isValidPlatformBiosKey('bios:psx/jp'), false)
assert.equal(isValidPlatformBiosKey('bios:'), false)

console.log('Platform BIOS binding-key validation passed')
