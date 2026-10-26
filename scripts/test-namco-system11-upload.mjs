import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  arcadeArchiveUnsafePathProblem,
  identifyNamcoSystem11Tekken,
  namcoC76BiosProblem,
} from '../src/lib/namcoSystem11.ts'
import { arcadeArchiveLayoutProblem } from '../src/lib/arcadeArchive.ts'
import { flattenArcadeZipBlob } from '../src/lib/flattenArcadeZip.ts'
import { assertValidZipBlob, extractZipEntry } from '../src/lib/unzip.ts'
import { detectArcadeCore } from '../src/lib/arcadeCoreDetection.ts'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeStoredZip(files) {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (const { name: path, text, crcOverride } of files) {
    const name = encoder.encode(path)
    const content = encoder.encode(text)
    // 可覆写中央目录指纹，以验证“只保留完整已知 set”的分支；ROM 负载本身仍是测试字节。
    const checksum = crcOverride ?? crc32(content)
    const local = new Uint8Array(30 + name.length + content.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(12, 0x0021, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, content.length, true)
    localView.setUint32(22, content.length, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(content, 30 + name.length)
    localParts.push(local)

    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint16(14, 0x0021, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, content.length, true)
    centralView.setUint32(24, content.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, localOffset, true)
    central.set(name, 46)
    centralParts.push(central)
    localOffset += local.length
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const end = new DataView(eocd.buffer)
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, localOffset, true)
  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' })
}

const parent = [
  ['te1rom0l.ic5', 0x03786e09], ['te1rom0u.ic6', 0x75d91051],
  ['te1rom1l.ic3', 0x81416f8e], ['te1rom1u.ic8', 0xfa7ba433],
  ['te1rom2l.ic4', 0x41d77846], ['te1rom2u.ic7', 0xa678987e],
  ['te1sprog.6d', 0x849587e9], ['te1verb.2f', 0x3dc01aad],
  ['te1verb.2k', 0xb9860b29], ['te1wave.8k', 0xfce6c57a],
  ['te2verc.2j', 0x3224c298], ['te2verc.2l', 0xa24c8c57],
].map(([name, crc32]) => ({ name, crc32 }))

const withCloneExtras = [
  ...parent,
  { name: 'tekkenac/te4verc.2j', crc32: 0x3224c298 },
  { name: 'tekkenac/te4verc.2l', crc32: 0xa24c8c57 },
  { name: 'tekkenb/te2verb.2j', crc32: 0x3224c298 },
  { name: 'tekkenb/te2verb.2l', crc32: 0xa24c8c57 },
]
assert.deepEqual(identifyNamcoSystem11Tekken(withCloneExtras), {
  romset: 'tekken', board: 'Namco System 11', bios: 'namcoc76', matchedFiles: 12, nestedExtras: 4,
})
assert.match(arcadeArchiveLayoutProblem(withCloneExtras), /子目录/, '通用规则仍识别嵌套包；只由 exact Tekken 指纹授予例外')
assert.equal(identifyNamcoSystem11Tekken(parent.slice(1)), null, '缺任何父集 ROM 都不能误识别')
assert.equal(identifyNamcoSystem11Tekken(parent.map((item, i) => i ? item : { ...item, crc32: 0 }),), null, 'CRC 不匹配不能误识别')
assert.equal(identifyNamcoSystem11Tekken([...parent, parent[0]]), null, '根目录重复成员必须拒绝')
assert.equal(identifyNamcoSystem11Tekken([...parent, { name: '../outside.bin', crc32: 1 }]), null, '路径穿越不能取得例外')
assert.match(arcadeArchiveUnsafePathProblem([{ name: 'folder/../tekken.zip' }]), /不安全路径/)

const completeNamcoParentZip = makeStoredZip([
  ...parent.map((entry) => ({ name: entry.name, text: `test:${entry.name}`, crcOverride: entry.crc32 })),
  ...withCloneExtras.slice(parent.length).map((entry) => ({ name: entry.name, text: `test:${entry.name}` })),
])
const preservedNamcoParent = await flattenArcadeZipBlob(completeNamcoParentZip)
assert.equal(preservedNamcoParent.blob, completeNamcoParentZip, '完整 Tekken/System 11 父集必须原样上传，不重写父集+克隆包')
assert.equal(preservedNamcoParent.flattenedCount, 0, '保留原始归档时不能谎报已拍平')
assert.deepEqual(
  (await assertValidZipBlob(preservedNamcoParent.blob, 'Namco 保留回归')).filter((entry) => entry.name.includes('/')).map((entry) => entry.name),
  withCloneExtras.slice(parent.length).map((entry) => entry.name),
  '例外包中的克隆目录必须保持原结构',
)

assert.equal(detectArcadeCore({ exactMameBoard: true })?.core, 'mame-current')
assert.equal(detectArcadeCore({ indexedFbneoSet: true })?.core, 'fbneo')
assert.equal(detectArcadeCore({ supportedFbneoRomData: true })?.core, 'fbneo')
assert.equal(detectArcadeCore({ indexedFbneoSet: true, exactMameBoard: true })?.core, 'mame-current')
assert.equal(detectArcadeCore({}), null, '未知或不完整 ROM 不得猜核心')
assert.equal(detectArcadeCore({ indexedFbneoSet: false }), null, '只有部分 CRC 候选不能猜核心')

const nestedZip = makeStoredZip([
  { name: 'root.rom', text: 'parent bytes' },
  { name: 'tekkenac/te4verc.2j', text: 'clone one' },
  { name: 'tekkenb/te2verb.2j', text: 'clone two' },
])
const flattened = await flattenArcadeZipBlob(nestedZip)
assert.equal(flattened.flattenedCount, 2)
const flattenedEntries = await assertValidZipBlob(flattened.blob, '拍平回归')
assert.deepEqual(flattenedEntries.map((entry) => entry.name), ['root.rom', 'te4verc.2j', 'te2verb.2j'])
const flattenedBuffer = await flattened.blob.arrayBuffer()
for (const entry of flattenedEntries) {
  assert.equal(new TextDecoder().decode(await extractZipEntry(flattenedBuffer, entry)), {
    'root.rom': 'parent bytes',
    'te4verc.2j': 'clone one',
    'te2verb.2j': 'clone two',
  }[entry.name], `拍平不能改变 ${entry.name} 的 ROM 字节`)
}
const flatInput = makeStoredZip([{ name: 'root.rom', text: 'already flat' }])
const unchanged = await flattenArcadeZipBlob(flatInput)
assert.equal(unchanged.flattenedCount, 0)
assert.equal(unchanged.blob, flatInput, '本来就在根目录时不重写 ZIP')
await assert.rejects(
  flattenArcadeZipBlob(makeStoredZip([
    { name: 'parent/same.bin', text: 'one' },
    { name: 'clone/same.bin', text: 'two' },
  ])),
  /多个 ROM 重名/,
)

const validBios = [{ name: 'c76.bin', crc32: 0x399faac7, uncompressedSize: 16384 }]
assert.equal(namcoC76BiosProblem(validBios), null)
assert.match(namcoC76BiosProblem([{ ...validBios[0], crc32: 0 }]), /CRC/)
assert.match(namcoC76BiosProblem([{ ...validBios[0], name: 'folder/c76.bin' }]), /根目录/)
assert.match(namcoC76BiosProblem([...validBios, { name: 'readme.txt', crc32: 1 }]), /只包含 c76.bin/)

const gameForm = readFileSync(new URL('../src/admin/GameForm.tsx', import.meta.url), 'utf8')
const biosPanel = readFileSync(new URL('../src/admin/PlatformBiosPanel.tsx', import.meta.url), 'utf8')
assert.match(gameForm, /原始 ZIP 会保持不变；另外 \$\{mameRomset\.nestedExtras\} 个子目录成员仍留在原处/, '可信父集命中后应向管理员说明保留归档结构')
assert.match(gameForm, /manualCoreChoice = useRef\(Boolean\(initial\?\.core\?\.trim\(\)\)\)/, '历史上明确保存的核心按手工选择保护')
assert.match(gameForm, /if \(!manualCoreChoice\.current\) setForm\(\(f\) => \(\{ \.\.\.f, core \}\)\)/, '自动选核心不得覆盖管理员手工选择')
assert.match(gameForm, /manualCoreChoice\.current = Boolean\(value\)/, '选择平台默认后恢复 ROM 自动识别')
assert.match(gameForm, /detectArcadeCore\(\{ exactMameBoard: true \}\)/, '精确 MAME 板卡指纹必须选择 MAME 当前版')
assert.match(gameForm, /found\.candidates\.some\(\(candidate\) => candidate\.coverage === 1\)/, '核心识别可以依据完整 FBNeo set，但不要求克隆包名也无歧义')
assert.match(gameForm, /detectArcadeCore\(\{ indexedFbneoSet: fbneoHasExactSet \}\)/, 'CRC 完整命中 FBNeo set 必须选择 FBNeo')
assert.match(gameForm, /onBiosFound\?\.\(mameMatch\.bios\)/, '精确识别后必须填入对应 BIOS 系统名')
assert.match(gameForm, /layoutProblem && !mameMatch/, '仅已核验的 MAME set 可豁免子目录拦截')
assert.match(gameForm, /if \(isArcade && !alreadyPacked && !isPlayArcadeBundle\)[\s\S]*?flattenArcadeZipBlob\(file\)/, '普通街机 ZIP 上传必须自动检查并拍平子目录成员；Play! 专用包保留其内部清单结构')
assert.match(gameForm, /自动拍平 \$\{flattenedArcadeFiles\} 个子目录 ROM 文件/, '上传完成后应说明自动拍平结果')
assert.match(biosPanel, /namcoC76BiosProblem\(entries\)/, 'C76 BIOS 必须在上传前校验内容')
assert.match(biosPanel, /arcadeBiosFileNameForBinding\(id\)/, '固定 BIOS 文件名必须用于上传和手工绑定校验')

console.log('Namco System 11 上传识别 / BIOS 防呆回归通过。')
