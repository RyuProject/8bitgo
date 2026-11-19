#!/usr/bin/env node
/**
 * 街机系统 BIOS 的自动推导（server/src/arcade-bios-index.js 的 inferArcadeSystemBios + mappers.js 接线）。
 *
 *   cd server && npm run test:arcade-bios-infer
 *
 * 2026-11-18《圣魔世纪》（svg，PGM 板）没填 arcade_bios，播放器只下了 neogeo.zip，FBNeo 报缺 pgm_t01s.rom。
 * 这里守住：认得出的 PGM 包自动补上 pgm；后台填过的优先；neogeo、混板、认不出的名字不推导。
 */
import assert from 'node:assert/strict'
import { defaultRomsetLookup, inferArcadeSystemBios } from '../src/arcade-bios-index.js'
import { gameRowToApi } from '../src/mappers.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✖ ${name}`)
    throw err
  }
}

const fake = {
  known: new Set(['svg', 'kov', 'kof97', 'dino', 'cchipgame', 'skgame']),
  biosByName: new Map([['svg', 'pgm'], ['kov', 'pgm'], ['kof97', 'neogeo'], ['cchipgame', 'cchip'], ['skgame', 'skns']]),
}

console.log('街机系统 BIOS 自动推导')

test('PGM 包推出 pgm（8BG / 明文 / 带 romv 都认）', () => {
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg.zip.8bg'], fake), 'pgm')
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg.zip?romv=abc'], fake), 'pgm')
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg.zip', 'roms/arcade/kov.zip.8bg'], fake), 'pgm')
})

test('neogeo、不需要 BIOS、认不出、两块板混在一起：都不推导', () => {
  assert.equal(inferArcadeSystemBios(['roms/arcade/kof97.zip'], fake), '')
  assert.equal(inferArcadeSystemBios(['roms/arcade/dino.zip'], fake), '')
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg-chs.zip'], fake), '')
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg.zip', 'roms/arcade/skgame.zip'], fake), '')
  assert.equal(inferArcadeSystemBios([], fake), '')
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg.zip'], null), '')
})

test('真实索引：svg 要 pgm，1942 / kof97 不推导', () => {
  const lookup = defaultRomsetLookup()
  assert.ok(lookup, '找不到 public/arcade-romsets.bin')
  assert.equal(inferArcadeSystemBios(['roms/arcade/svg.zip.8bg'], lookup), 'pgm')
  assert.equal(inferArcadeSystemBios(['roms/arcade/1942.zip.8bg'], lookup), '')
  assert.equal(inferArcadeSystemBios(['roms/arcade/kof97.zip'], lookup), '')
})

const row = (extra) => ({ id: 1, slug: 'spectral-vs-generation', title: 'SVG', platform: 'arcade', ...extra })

test('接线：没填系统名的 PGM 游戏下发 arcadeBios=pgm，后台填过的原样保留', () => {
  const inferred = gameRowToApi(row({}), { roms: { en: 'roms/arcade/svg.zip.8bg' } })
  assert.equal(inferred.arcadeBios, 'pgm')
  assert.equal(inferred.arcadeNoBios, undefined)
  const explicit = gameRowToApi(row({ arcade_bios: 'pgm' }), { roms: { en: 'roms/arcade/svg.zip.8bg' } })
  assert.equal(explicit.arcadeBios, 'pgm')
  const custom = gameRowToApi(row({ arcade_bios: 'skns' }), { roms: { en: 'roms/arcade/svg.zip.8bg' } })
  assert.equal(custom.arcadeBios, 'skns', '后台填的值必须优先')
})

test('接线：RomData、非 FBNeo 核心、不需要 BIOS 的游戏不推导', () => {
  assert.equal(gameRowToApi(row({ arcade_romdata: 'ZipName:x' }), { roms: { en: 'roms/arcade/svg.zip' } }).arcadeBios, undefined)
  assert.equal(gameRowToApi(row({ core: 'mame2003_plus' }), { roms: { en: 'roms/arcade/svg.zip' } }).arcadeBios, undefined)
  const dino = gameRowToApi(row({ slug: 'cadillacs-and-dinosaurs' }), { roms: { en: 'roms/arcade/dino.zip.8bg' } })
  assert.equal(dino.arcadeBios, undefined)
  assert.equal(dino.arcadeNoBios, true)
})

console.log(`✓ 街机系统 BIOS 自动推导 ${passed} 项通过`)
