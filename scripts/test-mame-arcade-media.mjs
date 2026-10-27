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
  BM1STMIX_MAME_MEDIA,
  identifyKnownMameArcadeMedia,
  mameDiskFromFile,
  mameDiskHeaderProblem,
  mameDiskSatisfies,
  readMameChdHeader,
} from '../src/lib/mameArcadeMedia.ts'
import { arcadeBiosOf, arcadeMameDisksOf } from '../server/src/mappers.js'
import { writeFsInjections } from '../src/emulator/fsInjection.ts'
import { combinedRomProgress, gateProgressUntilRomComplete } from '../src/emulator/romProgress.ts'
import { fastForwardBoot, mameBootFastForwardFrames } from '../src/emulator/mameBootSkip.ts'

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
  bytes.set(hexBytes(disk.dataSha1 ?? '1'.repeat(40)), 64)
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

const bm1stmixEntries = [
  ['753jab01.6a', 0x25bf8629], ['753jab02.8a', 0x6ab951de],
  ['753jaa03.19a', 0xf2b2bce8], ['753jaa04.20a', 0x85a18f9d],
  ['753jaa05.22a', 0x749b1e87], ['753jaa06.24a', 0x6d86b0fd],
  ['753jaa07.22d', 0xf03ab5d8], ['753jaa08.23d', 0x6559f0c8],
  ['753jaa09.25d', 0xb50c3dbb], ['753jaa10.27d', 0x391f4bfd],
].map(([name, crc32]) => ({ name, crc32, uncompressedSize: 524288 }))
assert.equal(identifyKnownMameArcadeMedia(bm1stmixEntries), BM1STMIX_MAME_MEDIA, 'bm1stmix 的十颗 ROM 必须显示 753jaa11 CHD 上传位')
assert.equal(identifyKnownMameArcadeMedia([{ ...bm1stmixEntries[0], crc32: 0 }, ...bm1stmixEntries.slice(1)]), null, '同名但 CRC 不符的 beatmania 包不能误绑 CHD')

const bm1stmixDisk = {
  ...BM1STMIX_MAME_MEDIA.disks[0],
  // 实盘由另一种无损压缩组合生成；内容 SHA-1 不变，压缩体积不能成为上传门槛。
  storedBytes: 134647845,
  key: 'roms/arcade-media/mame/2e70cf31a853322f29f99b6f292c187a2cf33015/753jaa11.chd',
}
assert.deepEqual(JSON.parse(arcadeMameDisksOf([bm1stmixDisk])), [bm1stmixDisk], 'bm1stmix 已核验媒体盘必须能通过后台接口保存')

const bm2ndmixEntries = [
  ['853jab01.6a', 0xc8df72c0], ['853jab02.8a', 0xbf6ace08],
  ['853jaa03.19a', 0x1462ed23], ['853jaa04.20a', 0x98c9b331],
  ['853jaa05.22a', 0x0da3fef9], ['853jaa06.24a', 0x6a66978c],
  ['853jaa07.22d', 0x728c0010], ['853jaa08.23d', 0x926fc37c],
  ['853jaa09.25d', 0x8584e21e], ['853jaa10.27d', 0x9cb92d98],
].map(([name, crc32]) => ({ name, crc32, uncompressedSize: 524288 }))
const bm2ndmix = identifyKnownMameArcadeMedia(bm2ndmixEntries, 'bm2ndmix.zip')
assert.ok(bm2ndmix, '不在旧白名单的 bm2ndmix 也必须由完整 MAME CHD 目录识别')
assert.deepEqual(bm2ndmix.disks, [{ romset: 'bm2ndmix', name: '853jaa11', chdSha1: '9683ff8462491252b6eb2e5b3aa6496884c01506' }])
const bm2ndmixHeader = fakeChdHeader({ ...bm2ndmix.disks[0], dataSha1: '1'.repeat(40), logicalBytes: 512 })
const resolvedBm2ndmix = await mameDiskFromFile(new Blob([bm2ndmixHeader]), bm2ndmix.disks[0])
assert.deepEqual(resolvedBm2ndmix, {
  romset: 'bm2ndmix', name: '853jaa11', chdSha1: '9683ff8462491252b6eb2e5b3aa6496884c01506',
  dataSha1: '1'.repeat(40), storedBytes: 124, logicalBytes: 512,
}, '通用目录必须从实际 CHD 头补齐可持久化元数据')
assert.deepEqual(JSON.parse(arcadeMameDisksOf([{
  ...resolvedBm2ndmix,
  key: 'roms/arcade-media/mame/9683ff8462491252b6eb2e5b3aa6496884c01506/853jaa11.chd',
}])), [{
  ...resolvedBm2ndmix,
  key: 'roms/arcade-media/mame/9683ff8462491252b6eb2e5b3aa6496884c01506/853jaa11.chd',
}], '通用 MAME 目录的已验 CHD 必须能通过后台保存')

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

// CHD 的压缩流可以重建，文件字节数不是 MAME 的内容身份。回归要锁住真实 bm1stmix
// 文件的大小差异：只要两组 SHA-1 与逻辑容量匹配，就应记录管理员实际选中的体积。
const bm1stmixExpected = BM1STMIX_MAME_MEDIA.disks[0]
assert.equal(bm1stmixExpected.storedBytes, undefined, '静态目录不能把某一份 chdman 的压缩体积写死')
const bm1stmixHeader = fakeChdHeader(bm1stmixExpected)
const differentlyCompressedBm1stmix = {
  size: 134647845,
  slice: (start, end) => new Blob([bm1stmixHeader]).slice(start, end),
}
assert.deepEqual(await mameDiskFromFile(differentlyCompressedBm1stmix, bm1stmixExpected), {
  romset: 'bm1stmix',
  name: '753jaa11',
  chdSha1: bm1stmixExpected.chdSha1,
  dataSha1: bm1stmixExpected.dataSha1,
  storedBytes: 134647845,
  logicalBytes: bm1stmixExpected.logicalBytes,
}, '同内容但不同压缩体积的 bm1stmix CHD 必须可上传')

const disk = {
  ...expected,
  // 持久化记录的大小来自实际上传文件，而不是静态 MAME 媒体目录。
  storedBytes: 159949410,
  key: 'roms/arcade-media/mame/cede127f3d87f894ccaa1d77c8b279f209f6a8e4/nm-002.chd',
}
assert.deepEqual(JSON.parse(arcadeMameDisksOf([disk])), [disk], '后台只保存规范化媒体盘描述')
assert.throws(() => arcadeMameDisksOf([{ ...disk, name: '../nm-002' }]), /romset|文件名/, '媒体盘名不能越过 MAME 目录')
assert.throws(() => arcadeMameDisksOf([{ ...disk, chdSha1: '0'.repeat(40), key: 'roms/arcade-media/mame/0000000000000000000000000000000000000000/nm-002.chd' }]), /当前 MAME CHD 目录|已验证目录/, '接口不能靠手工 JSON 绑定未知 CHD')
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
assert.match(adapter, /ejsMameDiskMissing|还缺必需媒体盘/, '已知 taiko2 缺盘必须在核心启动前给出明确错误')
assert.match(progress, /emulatorjs-arcade-mame-media/, 'CHD 街机应使用独立的长 ROM 进度预算')

// 2026-10-27 线上《狂热节拍》：目录不再固定 storedBytes，播放器却还逐字段 === 比较，绑好的盘恒被判「缺失」。
{
  const bound = {
    ...BM1STMIX_MAME_MEDIA.disks[0],
    key: 'roms/arcade-media/mame/x/753jaa11.chd',
    storedBytes: 134647845,
  }
  assert.equal(mameDiskSatisfies(bound, BM1STMIX_MAME_MEDIA.disks[0]), true, '已绑定的 bm1stmix 盘必须满足驱动要求，压缩后大小不参与比较')
  assert.equal(mameDiskSatisfies({ ...bound, storedBytes: 1 }, BM1STMIX_MAME_MEDIA.disks[0]), true, '无损重压后大小变了也照样算同一张盘')
  assert.equal(mameDiskSatisfies({ ...bound, chdSha1: '0'.repeat(40) }, BM1STMIX_MAME_MEDIA.disks[0]), false, 'CHD SHA-1 不符必须拦下')
  assert.equal(mameDiskSatisfies({ ...bound, dataSha1: '0'.repeat(40) }, BM1STMIX_MAME_MEDIA.disks[0]), false, '目录写了 Data SHA-1 就要比')
  assert.equal(mameDiskSatisfies({ ...bound, name: 'other' }, BM1STMIX_MAME_MEDIA.disks[0]), false)
  // 通用目录只有 CHD SHA-1：其余字段缺省时不能因此判失败
  const generic = { romset: 'bm1stmix', name: '753jaa11', chdSha1: BM1STMIX_MAME_MEDIA.disks[0].chdSha1 }
  assert.equal(mameDiskSatisfies(bound, generic), true)
  assert.doesNotMatch(adapter, /disk\.storedBytes === expected\.storedBytes/, '播放器不能再拿压缩后大小判缺盘')
  assert.match(adapter, /activeMameDisks\.some\(\(disk\) => mameDiskSatisfies\(disk, expected\)\)/)
}

// CHD 没下完之前，引擎 / 启动阶段的进度不能把单调进度条推到 99%
{
  const seen = []
  const gate = gateProgressUntilRomComplete((p) => seen.push(`${p.phase}:${p.ratio ?? p.startup ?? ''}`))
  const romOf = combinedRomProgress(gate.rom, { rom: 4, 'chd:753jaa11': 100 })
  romOf('rom')({ phase: 'rom', loaded: 4, total: 4, ratio: 1 })
  gate.other({ phase: 'engine', ratio: 0.5 })
  gate.other({ phase: 'starting', startup: 0.3 })
  romOf('chd:753jaa11')({ phase: 'rom', loaded: 50, total: 100 })
  assert.deepEqual(seen.filter((x) => !x.startsWith('rom:')), [], 'CHD 下到一半时不该放出 engine / starting 进度')
  romOf('chd:753jaa11')({ phase: 'rom', ratio: 1 })
  assert.equal(seen.at(-1), 'starting:0.3', 'CHD 一满就补发压住的最后一条进度')
  gate.other({ phase: 'starting', startup: 0.6 })
  assert.equal(seen.at(-1), 'starting:0.6', '之后的进度照常直通')
  assert.match(adapter, /gateProgressUntilRomComplete\(options\.onProgress\)/)
  assert.match(adapter, /combinedRomProgress\(progressGate\?\.rom/)
  assert.match(adapter, /const romProgress = romProgressFor\('rom'\)/, '所有被接管的 ROM 下载路径共用正确的进度回调')
}

// 《狂热节拍》开机自检（S RAM 16MB DRAM 实测 ~69 秒）要快进跑过去，到片头前恢复原速
{
  assert.equal(mameBootFastForwardFrames('bm1stmix'), 4300)
  assert.equal(mameBootFastForwardFrames('BM1STMIX'), 4300)
  assert.equal(mameBootFastForwardFrames('tekken'), 0, '没实测过的 romset 不快进')
  assert.equal(mameBootFastForwardFrames(null), 0)

  const fakeGm = (start = 0) => {
    const log = []
    let frame = start
    return {
      log,
      step: (n) => { frame += n },
      gm: {
        getFrameNum: () => frame,
        toggleFastForward: (on) => log.push(`ff:${on}`),
        setFastForwardRatio: (r) => log.push(`ratio:${r}`),
      },
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const a = fakeGm()
  fastForwardBoot(a.gm, 100, { restoreRatio: 3, pollMs: 5 })
  assert.deepEqual(a.log, ['ratio:0', 'ff:1'], '开局立刻不限倍率快进')
  await sleep(20)
  assert.deepEqual(a.log, ['ratio:0', 'ff:1'], '没到目标帧不停')
  a.step(100)
  await sleep(20)
  assert.deepEqual(a.log, ['ratio:0', 'ff:1', 'ff:0', 'ratio:3'], '到目标帧关快进并恢复用户的倍率')

  const b = fakeGm()
  const cancel = fastForwardBoot(b.gm, 100, { pollMs: 5 })
  cancel()
  cancel()
  assert.deepEqual(b.log, ['ratio:0', 'ff:1', 'ff:0', 'ratio:3'], '取消（销毁 / 进联机）立刻恢复原速，且只恢复一次')

  const c = fakeGm()
  fastForwardBoot(c.gm, 100, { pollMs: 5, timeoutMs: 15 })
  await sleep(40)
  assert.deepEqual(c.log.slice(-2), ['ff:0', 'ratio:3'], '帧计数不涨也会超时停下')

  const d = fakeGm(500)
  fastForwardBoot(d.gm, 100)
  assert.deepEqual(d.log, [], '已经过了自检（读档 / 重开）不快进')
  assert.doesNotThrow(() => fastForwardBoot({}, 100)(), '没有快进接口时什么都不做')

  assert.match(adapter, /options\.platform === 'arcade' && !netplay \? mameBootFastForwardFrames\(mameBootRomset\)/, '联机不快进（双方帧要对齐）')
  assert.match(adapter, /cancelBootFastForward = fastForwardBoot\(/)
  assert.ok((adapter.match(/cancelBootFastForward\?\.\(\)/g) ?? []).length >= 2, '销毁和进联机都要取消快进')
}

console.log('✅ MAME CHD 媒体盘回归通过')
