/**
 * MAME 游戏专属 CHD 媒体盘回归。
 *
 * 不依赖开发机下载目录：用合成的 v5 文件头锁住 taiko2 的 ROM 指纹、CHD 元数据、
 * 后台 JSON 形状和“必需注入失败必须阻止开局”的语义。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TAIKO2_MAME_MEDIA,
  identifyKnownMameArcadeMedia,
  mameDiskHeaderProblem,
  readMameChdHeader,
} from '../src/lib/mameArcadeMedia.ts'
import { arcadeBiosOf, arcadeMameDisksOf } from '../server/src/mappers.js'
import { writeFsInjections } from '../src/emulator/fsInjection.ts'

const hexBytes = (value) => Uint8Array.from(value.match(/../g).map((part) => Number.parseInt(part, 16)))
const expected = TAIKO2_MAME_MEDIA.disks[0]

function fakeChdHeader(disk = expected) {
  const bytes = new Uint8Array(124)
  bytes.set(new TextEncoder().encode('MComprHD'), 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 124, false)
  view.setUint32(12, 5, false)
  for (const [index, fourcc] of ['cdlz', 'cdzl', 'cdfl'].entries()) {
    for (let byte = 0; byte < fourcc.length; byte++) bytes[16 + index * 4 + byte] = fourcc.charCodeAt(byte)
  }
  view.setUint32(32, Math.floor(disk.logicalBytes / 2 ** 32), false)
  view.setUint32(36, disk.logicalBytes >>> 0, false)
  view.setUint32(56, 19584, false)
  view.setUint32(60, 2448, false)
  bytes.set(hexBytes(disk.dataSha1), 64)
  bytes.set(hexBytes(disk.chdSha1), 84)
  return bytes
}

const taikoEntries = [
  { name: 'tk21verc_0.8e', crc32: 0xf3842791, uncompressedSize: 17301504 },
  { name: 'tk21verc_1.8d', crc32: 0xe294f460, uncompressedSize: 17301504 },
  { name: 'tk21verc_2.7e', crc32: 0xf1dbe387, uncompressedSize: 17301504 },
]

assert.equal(identifyKnownMameArcadeMedia(taikoEntries), TAIKO2_MAME_MEDIA, '三颗 taiko2 NAND 必须精确认出所需 CHD')
assert.equal(identifyKnownMameArcadeMedia([{ ...taikoEntries[0], crc32: 0 }, ...taikoEntries.slice(1)]), null, 'CRC 不一致不能误认媒体盘')
assert.equal(identifyKnownMameArcadeMedia([...taikoEntries, { name: 'readme.txt', crc32: 0, uncompressedSize: 1 }]), null, '额外成员不能误认完整 set')

const header = fakeChdHeader()
assert.deepEqual(readMameChdHeader(header), {
  version: 5,
  headerBytes: 124,
  compressors: ['cdlz', 'cdzl', 'cdfl'],
  logicalBytes: expected.logicalBytes,
  hunkBytes: 19584,
  unitBytes: 2448,
  dataSha1: expected.dataSha1,
  chdSha1: expected.chdSha1,
})
assert.equal(await mameDiskHeaderProblem(new Blob([header]), { ...expected, storedBytes: header.byteLength }), null, '正确 v5 头应通过上传前检查')
assert.match(await mameDiskHeaderProblem(new Blob([header]), { ...expected, dataSha1: '0'.repeat(40), storedBytes: header.byteLength }), /SHA-1/, '同名错误 CHD 必须在上传前挡住')

const disk = { ...expected, key: 'roms/arcade-media/mame/cede127f3d87f894ccaa1d77c8b279f209f6a8e4/nm-002.chd' }
assert.deepEqual(JSON.parse(arcadeMameDisksOf([disk])), [disk], '后台只保存规范化媒体盘描述')
assert.throws(() => arcadeMameDisksOf([{ ...disk, name: '../nm-002' }]), /romset|文件名/, '媒体盘名不能越过 MAME 目录')
assert.throws(() => arcadeMameDisksOf([{ ...disk, chdSha1: '0'.repeat(40), key: 'roms/arcade-media/mame/0000000000000000000000000000000000000000/nm-002.chd' }]), /已验证目录/, '接口不能靠手工 JSON 绑定未知 CHD')
assert.throws(() => arcadeBiosOf('nm-002'), /不是 BIOS/, 'nm-002 不能再被当作 BIOS 保存')

const writes = []
const failures = await writeFsInjections({
  mkdir: () => {},
  writeFile: (path, bytes) => writes.push([path, bytes]),
}, [
  { path: '/roms/taiko2/nm-002.chd', required: true, bytes: Promise.resolve(null) },
  { path: '/optional.dat', bytes: 'ok' },
], () => {})
assert.equal(writes.length, 1, '一份必需盘失败不能阻断后续可选写入的隔离语义')
assert.deepEqual(failures, [{ path: '/roms/taiko2/nm-002.chd', required: true, message: '资源未下载完成' }])

const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const progress = readFileSync(new URL('../src/emulator/loadProgress.ts', import.meta.url), 'utf8')
assert.match(adapter, /`\/roms\/\$\{disk\.romset\}\/\$\{disk\.name\}\.chd`/, 'CHD 必须挂在 MAME 的 romset 子目录')
assert.match(adapter, /required: true/, 'CHD 挂载失败必须阻止 startGame，不能静默进入 MAME 菜单')
assert.match(adapter, /还缺必需媒体盘/, '已知 taiko2 缺盘必须在核心启动前给出明确错误')
assert.match(progress, /emulatorjs-arcade-mame-media/, 'CHD 街机应使用独立的长 ROM 进度预算')

console.log('✅ MAME CHD 媒体盘回归通过')
