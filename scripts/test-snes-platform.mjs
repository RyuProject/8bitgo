/**
 * SFC / SNES ROM 全链路回归：后缀、上传入口、在线寻址、核心选择与头部探测。
 *
 * `.sfc` / `.smc` 都是 Snes9x 接受的卡带镜像后缀；`.smc` 可能多一个 512 字节 copier
 * 头，不能仅因这个头把合法 HiROM 从本地 ROM 自动识别里漏掉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectRom } from '../src/emulator/detect.ts'
import { platformMap } from '../src/data/platforms.ts'
import { emulatorJsCoreDataFile, emulatorJsCoreForGame } from '../src/emulator/paths.ts'
import { conventionalKeys, defaultKeyFor, slugFromKey } from '../src/services/roms.ts'
import { platformMap as testPlatformMap } from '@/data/platforms'
import { ALLOWED_ROM_EXT } from '../shared/game-submission.js'

const encoder = new TextEncoder()
const fakeFile = (name, bytes) => ({
  name,
  size: bytes.byteLength,
  slice(from = 0, to = bytes.byteLength) {
    const part = bytes.subarray(from, to)
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) }
  },
})
const put16 = (bytes, offset, value) => new DataView(bytes.buffer, bytes.byteOffset).setUint16(offset, value, true)
/** 最小但结构自洽的 SNES 内部头，可放在 LoROM / HiROM 及有无 copier 头的位置。 */
function snesImage(base, copier = 0) {
  const bytes = new Uint8Array(base + copier + 0x20)
  const header = base + copier
  bytes.set(encoder.encode('SUPER FAMICOM GAME  '), header)
  const checksum = 0x1234
  put16(bytes, header + 0x1c, checksum ^ 0xffff)
  put16(bytes, header + 0x1e, checksum)
  return bytes
}

// 与播放器、后台共用同一份真实平台配置；ROM 服务里其余无关依赖由测试加载器桩住。
const snes = platformMap.snes
testPlatformMap.snes = snes
Object.assign(snes, {
  id: 'snes',
  core: 'snes',
  romExtensions: ['.sfc', '.smc', '.fig', '.zip'],
})

assert.ok(snes.romExtensions.includes('.sfc'), '平台文件选择器必须接受 .sfc')
assert.ok(snes.romExtensions.includes('.smc'), '平台文件选择器必须接受 .smc')
assert.ok(ALLOWED_ROM_EXT.includes('sfc'), '玩家提交入口必须接受 .sfc')
assert.ok(ALLOWED_ROM_EXT.includes('smc'), '玩家提交入口必须接受 .smc')

for (const [filename, expected] of [
  ['Super-Mario.sfc', new Uint8Array(0x8000)],
  ['Super-Mario.SMC', new Uint8Array(0x8000)],
]) {
  assert.equal((await detectRom(fakeFile(filename, expected))).platform, 'snes', `${filename} 必须自动识别为 SFC`)
}

for (const [name, base, copier] of [
  ['lorom.bin', 0x7fc0, 0],
  ['hirom.bin', 0xffc0, 0],
  ['copier-lorom.bin', 0x7fc0, 512],
  ['copier-hirom.bin', 0xffc0, 512],
]) {
  assert.equal((await detectRom(fakeFile(name, snesImage(base, copier)))).platform, 'snes', `${name} 的内部头应识别为 SFC`)
}

assert.equal(emulatorJsCoreForGame('snes'), 'snes9x', 'SFC 必须走本站自托管 Snes9x 核心')
const coreData = emulatorJsCoreDataFile('snes9x')
assert.equal(coreData, 'snes9x-legacy-wasm.data', '默认 Snes9x 不应预热未使用的 WebGL2 核心包')
assert.ok(readFileSync(new URL(`../public/emulatorjs/cores/${coreData}`, import.meta.url)).byteLength > 0)

const keys = conventionalKeys({ platform: 'snes', slug: 'super-mario-world' })
assert.ok(keys.includes('roms/snes/super-mario-world.sfc'), '约定 ROM 地址必须探测 .sfc')
assert.ok(keys.includes('roms/snes/super-mario-world.smc'), '约定 ROM 地址必须探测 .smc')
for (const extension of ['.sfc', '.smc']) {
  const key = defaultKeyFor('snes', 'super-mario-world', `Super Mario World${extension}`)
  assert.match(key, new RegExp(`\\/snes\\/super-mario-world${extension.replace('.', '\\.')}$`))
  assert.equal(slugFromKey(key), 'super-mario-world', `${extension} 上传后的 key 应自动匹配游戏 slug`)
}

const platformSource = readFileSync(new URL('../server/src/open/platforms.js', import.meta.url), 'utf8')
assert.match(platformSource, /romExtensions:\s*\['\.sfc',\s*'\.smc'/, '公开平台 API 必须同步公开两种后缀')

console.log('✅ SFC 体检通过：.sfc / .smc 上传、识别、寻址、slug、Snes9x 核心及 512 字节头均覆盖')
