/** FBNeo 源码 ROM 宏必须进入后台 CRC 索引，避免把完整 CPS-3 包误判成 MAME/CHD。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { identifyArcadeRomset } from '../src/lib/arcadeRomset.ts'
import { identifyKnownMameArcadeMedia } from '../src/lib/mameArcadeMedia.ts'
import { detectArcadeCore } from '../src/lib/arcadeCoreDetection.ts'

const index = await readFile(new URL('../public/arcade-romsets.bin', import.meta.url))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => new Response(index)

try {
  // 《街头霸王 III：新世代》Euro 970204，来自 FBNeo d_cps3.cpp 的 BIOS + SIMM 清单。
  const crcs = [
    0xcfc9e45a, 0x57920546, 0x0d8f2680, 0xea4ca054, 0x080b3bd3, 0x5c356f2f,
    0xf9c97a45, 0x09de3ead, 0x7dd7e1f3, 0x47a03a3a, 0xe9eb7a26, 0x7f44395c,
    0x9ac080fc, 0x6e2c4c94, 0x8afc22d4, 0x9f3873b8, 0x166b3c97, 0xe5ea2547,
    0xe85b9fdd, 0x362c01b7, 0x9bc108b2, 0xc6f1c066, 0x27699ddc,
  ].map((crc32) => ({ crc32 }))

  const found = await identifyArcadeRomset(crcs, 'sfiii.zip')
  assert.equal(found?.confident?.name, 'sfiii', 'FBNeo 宏展开后必须完整识别 Euro SFIII set')
  assert.equal(found?.confident?.matched, 23)
  assert.equal(found?.confident?.total, 23)

  const mameOnlySubset = identifyKnownMameArcadeMedia([
    { name: 'sfiii_euro.29f400.u2', crc32: 0x27699ddc, uncompressedSize: 0x80000 },
  ])
  assert.equal(mameOnlySubset?.romset, 'sfiii', '共享的 MAME BIOS CRC 仍能识别出 CHD 候选')

  assert.equal(
    detectArcadeCore({ indexedFbneoSet: true, mameChdSet: true })?.core,
    'fbneo',
    '完整 FBNeo set 必须优先于只命中共享 BIOS 的 MAME CHD 候选',
  )
  assert.equal(
    detectArcadeCore({ mameChdSet: true })?.core,
    'mame-current',
    '没有完整 FBNeo 指纹时仍保留 MAME CHD 自动识别',
  )
} finally {
  globalThis.fetch = originalFetch
}

console.log('✅ FBNeo 宏索引与 SFIII 核心优先级回归通过')
