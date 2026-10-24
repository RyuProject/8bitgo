/**
 * 本地游玩页的格式路由回归。
 *
 * 这里特意不测「某种扩展名能不能映射」这么浅的一层：真正容易把用户送进错误模拟器的
 * 是共享盘容器（ISO / CHD / PBP / CISO）和 ZIP 内多文件。PS2 被误送 PS1、或未知 ZIP
 * 被默认 NES 接走，都会表现成「模拟器加载失败」而不是一个可解释的识别错误。
 *
 * 跑：npm run test:local-rom
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectRom } from '../src/emulator/detect.ts'

const encoder = new TextEncoder()
const fakeFile = (name, bytes) => ({
  name,
  size: bytes.byteLength,
  slice(from = 0, to = bytes.byteLength) {
    const part = bytes.slice(from, to)
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) }
  },
})

const put32 = (bytes, offset, value) => new DataView(bytes.buffer).setUint32(offset, value, true)
const put16 = (bytes, offset, value) => new DataView(bytes.buffer).setUint16(offset, value, true)

/** 做一个只含存储成员的最小 ZIP，足够覆盖中央目录识别而不用引入压缩库。 */
function storedZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, bytes } of entries) {
    const nameBytes = encoder.encode(name)
    const local = new Uint8Array(30 + nameBytes.length + bytes.length)
    put32(local, 0, 0x04034b50)
    put16(local, 4, 20)
    put16(local, 26, nameBytes.length)
    put32(local, 18, bytes.length)
    put32(local, 22, bytes.length)
    local.set(nameBytes, 30)
    local.set(bytes, 30 + nameBytes.length)
    locals.push(local)

    const cd = new Uint8Array(46 + nameBytes.length)
    put32(cd, 0, 0x02014b50)
    put16(cd, 4, 20)
    put16(cd, 6, 20)
    put16(cd, 28, nameBytes.length)
    put32(cd, 20, bytes.length)
    put32(cd, 24, bytes.length)
    put32(cd, 42, offset)
    cd.set(nameBytes, 46)
    central.push(cd)
    offset += local.length
  }
  const centralBytes = central.reduce((total, entry) => total + entry.length, 0)
  const end = new Uint8Array(22)
  put32(end, 0, 0x06054b50)
  put16(end, 8, entries.length)
  put16(end, 10, entries.length)
  put32(end, 12, centralBytes)
  put32(end, 16, offset)
  const out = new Uint8Array(offset + centralBytes + end.length)
  let at = 0
  for (const local of locals) {
    out.set(local, at)
    at += local.length
  }
  for (const cd of central) {
    out.set(cd, at)
    at += cd.length
  }
  out.set(end, at)
  return out
}

/** 在 ISO9660 PVD + 根目录内放 SYSTEM.CNF，模拟能可靠区分的 PS1 / PS2 镜像。 */
function isoWithSystemConfig(config) {
  const bytes = new Uint8Array(64 * 1024)
  const pvd = 16 * 2048
  bytes[pvd] = 1
  bytes.set(encoder.encode('CD001'), pvd + 1)
  // 根目录记录：extent 20、大小一个扇区。
  bytes[pvd + 156] = 34
  put32(bytes, pvd + 158, 20)
  put32(bytes, pvd + 166, 2048)
  bytes[pvd + 188] = 1

  const root = 20 * 2048
  const name = encoder.encode('SYSTEM.CNF;1')
  bytes[root] = 46
  put32(bytes, root + 2, 21)
  put32(bytes, root + 10, config.length)
  bytes[root + 32] = name.length
  bytes.set(name, root + 33)
  bytes.set(encoder.encode(config), 21 * 2048)
  return bytes
}

assert.equal((await detectRom(fakeFile('ps1.iso', isoWithSystemConfig('BOOT = cdrom:\\SLUS_000.00;1')))).platform, 'psx')
assert.equal((await detectRom(fakeFile('ps2.iso', isoWithSystemConfig('BOOT2 = cdrom0:\\SLUS_000.00;1')))).platform, 'ps2')

for (const [name, expected] of [
  ['unknown.chd', ['psx', 'psp', 'ps2', 'segaCD', 'pce']],
  ['unknown.pbp', ['psp', 'psx']],
  ['unknown.cso', ['psp', 'ps2']],
  ['unknown.iso', ['psx', 'psp', 'ps2', 'segaCD', 'pce']],
]) {
  const detection = await detectRom(fakeFile(name, new Uint8Array(128)))
  assert.equal(detection.platform, undefined, `${name} 不能被硬塞进默认核心`)
  assert.deepEqual(detection.candidates, expected, `${name} 的安全候选不完整`)
}

assert.equal((await detectRom(fakeFile('one-file.cue', encoder.encode('FILE "disc.bin" BINARY')))).requiresCompanion, true,
  '单独 CUE 没有相邻 BIN 时不能假装能启动')
assert.equal((await detectRom(fakeFile('archive.7z', new Uint8Array(64)))).unsupported, true,
  '浏览器没有 7z 解包器时不能让手动选平台制造必败启动')
assert.equal((await detectRom(fakeFile('dos-game.jsdos', new Uint8Array(64)))).platform, 'dos', '.jsdos 必须直达 js-dos')
assert.equal((await detectRom(fakeFile('ps2-game.zso', new Uint8Array(64)))).platform, 'ps2', '.zso 必须直达 Play!')
assert.equal((await detectRom(fakeFile('homebrew.prx', new Uint8Array(64)))).platform, 'psp', '.prx 必须直达 PPSSPP')
assert.deepEqual((await detectRom(fakeFile('disc.rvz', new Uint8Array(64)))).candidates, ['gamecube', 'wii'],
  'Dolphin 压缩盘没有原始盘头时只能在 GC / Wii 之间确认')
assert.deepEqual((await detectRom(fakeFile('homebrew.elf', new Uint8Array(64)))).candidates, ['psp', 'ps2', 'gamecube', 'wii'],
  'ELF 不能再被武断路由到一个平台')

const discZip = storedZip([
  { name: 'disc/game.cue', bytes: encoder.encode('FILE "game.bin" BINARY') },
  { name: 'disc/game.bin', bytes: new Uint8Array(128) },
])
const zipDetection = await detectRom(fakeFile('multi-disc.zip', discZip))
assert.equal(zipDetection.platform, undefined, 'ZIP 内 CUE/BIN 不能因目录顺序被猜成 PS1')
assert.deepEqual(zipDetection.candidates, ['psx', 'segaCD', 'pce'])

const nes = new Uint8Array(16)
nes.set(encoder.encode('NES\x1a'))
assert.equal((await detectRom(fakeFile('game.nes', nes))).platform, 'nes', '确定的 iNES 必须保留自动快路径')

const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/pages/PlayLocalPage.tsx', import.meta.url), 'utf8')
assert.match(player, /needsPlatformConfirmation/, '低置信度容器必须先确认平台，不能落回默认 NES')
assert.match(player, /confirmedPlatform/, '人工确认后必须允许按所选平台继续启动')
assert.match(player, /if \(targetPlatform === 'arcade'\)/, '街机改版识别必须放在平台已确定之后')
assert.match(player, /onRuntimeChange\?\.\(runtime, targetPlatform\)/, '本地页必须收到最终运行时，而不是展示平台默认值')
assert.match(page, /pendingCandidates.*includes\(candidate\.id\)/s, '本地页必须只展示容器的合理候选平台')
assert.match(page, /activeRuntimeId/, '本地页键位与状态必须随实际运行时更新')

console.log('✔ 本地 ROM：ISO 的 PS1/PS2 区分、跨平台容器确认、ZIP 多文件与街机启动顺序通过')
