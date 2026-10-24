import assert from 'node:assert/strict'
import { detectPsxBiosRegion, psxBiosObjectKey } from '../src/emulator/psxBiosRegion.ts'

assert.equal(detectPsxBiosRegion({ identifiers: ['roms/SLPM-86600.chd.8bg'] }), 'jp')
assert.equal(detectPsxBiosRegion({ identifiers: ['SLUS_01234'] }), 'us')
assert.equal(detectPsxBiosRegion({ identifiers: ['SLES-03321'] }), 'eu')
assert.equal(detectPsxBiosRegion({ identifiers: ['game.NTSC-J.chd'] }), 'jp')
assert.equal(detectPsxBiosRegion({ identifiers: ['game.PAL.chd'] }), 'eu')
assert.equal(detectPsxBiosRegion({ identifiers: ['game.zh-Hans.chd.8bg'] }), undefined)
assert.equal(detectPsxBiosRegion({ slug: 'world-soccer-jikkyou-winning-eleven-2000-u-23-medal-e-no-chousen' }), 'jp')
assert.equal(
  detectPsxBiosRegion({
    slug: 'same-game',
    primaryIdentifier: 'roms/SLPM-86600.chd',
    identifiers: ['roms/SLUS-90000.chd'],
  }),
  'jp',
)

const bindings = {
  psx: 'roms/bios/scph1001.bin',
  'bios:psx-jp': 'roms/bios/scph5500.bin',
  'bios:psx-us': 'roms/bios/scph5501.bin',
}
assert.equal(psxBiosObjectKey(bindings, 'jp'), 'roms/bios/scph5500.bin')
assert.equal(psxBiosObjectKey(bindings, 'us'), 'roms/bios/scph5501.bin')
assert.equal(psxBiosObjectKey(bindings, 'eu'), bindings.psx)
assert.equal(psxBiosObjectKey({ 'bios:psx-jp': '  ' }, 'jp'), undefined)

console.log('PS1 regional BIOS detection and fallback passed')
