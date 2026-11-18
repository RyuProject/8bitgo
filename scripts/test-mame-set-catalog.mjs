/**
 * MAME 源码目录（Sega Model 2 …）的识别、merged 包重组与接线回归。
 *
 * 不需要任何游戏文件：真实目录只拿 ZIP「中央目录」形状的条目去比（名字 / CRC / 长度），
 * 重组 ZIP 的字节级检查用一张小的合成目录 + 测试字节完成。
 *
 *   npm run test:mame-set-catalog
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { unzipSync, zipSync } from 'fflate'
import {
  buildMameCatalog,
  buildMameCatalogSetZip,
  identifyMameCatalogSets,
  mameCatalogBiosName,
  mameCatalogDeviceBiosProblem,
  mameCatalogStatusNote,
  mayContainMameCatalogSet,
  pickMameCatalogSetForPlayback,
} from '../src/lib/mameSetCatalog.ts'
import {
  MAME_SET_CATALOG,
  MAME_SET_CATALOG_DEVICES,
  MAME_SET_CATALOG_REVISION,
} from '../src/lib/mameSetCatalogData.ts'
import { assertValidZipBlob } from '../src/lib/unzip.ts'
import { flattenArcadeZipBlob } from '../src/lib/flattenArcadeZip.ts'

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.stack : error}`)
  }
}

const catalog = buildMameCatalog(MAME_SET_CATALOG, MAME_SET_CATALOG_DEVICES, MAME_SET_CATALOG_REVISION)
const setByName = new Map(catalog.sets.map((set) => [set.romset, set]))

/** 按目录里某个 set 造一组「中央目录条目」；rename 把 ROM 改成 merged 包里的父集名 */
function entriesFor(romset, { rename = {}, prefix = '' } = {}) {
  const set = setByName.get(romset)
  assert.ok(set, `目录里没有 ${romset}`)
  return set.roms.map((rom) => ({
    name: `${prefix}${rename[rom.name] ?? rom.name}`,
    crc32: rom.crc32,
    uncompressedSize: rom.size,
    compressedSize: rom.size,
    method: 0,
    offset: 0,
  }))
}

/** 按 MAME merged 规则拼一份 doa.zip：同 CRC 的只留第一个出现的名字 */
function mergedEntries(romsets, extra = []) {
  const seen = new Map()
  for (const romset of romsets) {
    for (const entry of entriesFor(romset)) {
      const key = `${entry.crc32}:${entry.uncompressedSize}`
      if (!seen.has(key)) seen.set(key, entry)
    }
  }
  return [...seen.values(), ...extra]
}

const SEGABILL = { name: 'epr-18022.ic2', crc32: 0x0ca70f80, uncompressedSize: 0x10000, compressedSize: 0x10000, method: 0, offset: 0 }
const DOA_FAMILY = ['doa', 'doab', 'doaa', 'doaab', 'doaae']

await check('目录：数据来自 MAME 0.289，doaae 的 ROM 清单与驱动源码一致', () => {
  assert.match(MAME_SET_CATALOG_REVISION, /^mame0289-/)
  assert.equal(new Set(catalog.sets.map((set) => set.romset)).size, catalog.sets.length, 'romset 短名不能重复')
  const doaae = setByName.get('doaae')
  assert.equal(doaae.title, 'Dead or Alive (Export, Model 2A, Revision A)')
  assert.equal(doaae.parent, 'doa')
  assert.equal(doaae.board, 'Sega Model 2A-CRX')
  assert.equal(doaae.status, 'ok')
  assert.equal(doaae.buttons, 4, 'DOA 是 Hold / Punch / Kick 三键 → 本站 4 键布局')
  assert.equal(doaae.roms.length, 32, 'doaae = 23 颗游戏 ROM + MODEL2_CPU_BOARD 6 颗 + MODEL2A_VID_BOARD 3 颗')
  const program = doaae.roms.filter((rom) => rom.name.startsWith('epr-1938'))
  assert.deepEqual(program.map((rom) => [rom.name, rom.crc32.toString(16)]), [['epr-19383a.12', '42e61481'], ['epr-19384a.13', '34a3ab9']])
  assert.ok(doaae.roms.some((rom) => rom.name === 'opr-14742a.45' && rom.crc32 === 0x90c6b117), 'MODEL2_CPU_BOARD 宏必须展开')
  assert.ok(doaae.roms.some((rom) => rom.name === 'mpr-16310.15' && rom.size === 0x80000), 'MODEL2A_VID_BOARD 宏必须展开')
  assert.deepEqual(doaae.devices.map((device) => device.id), ['segabill'])
  assert.deepEqual(doaae.devices[0].roms.map((rom) => [rom.name, rom.crc32, rom.size]), [['epr-18022.ic2', 0x0ca70f80, 0x10000]])
})

await check('目录：机台配置里的设备 BIOS 改写（set_default_bios_tag）被正确追踪', () => {
  assert.deepEqual(setByName.get('daytona').devices.map((device) => device.id), ['model1io@epr14869c'])
  assert.deepEqual(setByName.get('vcop').devices.map((device) => device.id).sort(), ['hd44780', 'model1io2@epr17181'])
  for (const set of catalog.sets) {
    for (const rom of set.roms) assert.ok(rom.crc32 >>> 0 === rom.crc32 && rom.name === rom.name.toLowerCase(), `${set.romset}/${rom.name}`)
  }
})

await check('merged 包：doa.zip 里五个版本都能凑齐，克隆集 ROM 按 CRC 找到父集名的那一份', () => {
  const entries = mergedEntries(DOA_FAMILY)
  const result = identifyMameCatalogSets(catalog, entries, 'doa.zip')
  assert.deepEqual(result.candidates.map((candidate) => candidate.romset).sort(), [...DOA_FAMILY].sort())
  assert.equal(result.chosen?.romset, 'doa', '文件名正好是父集短名时落定父集')
  const doaae = result.candidates.find((candidate) => candidate.romset === 'doaae')
  const data = doaae.items.find((item) => item.name === 'mpr-19318.10')
  assert.equal(data.entry.name, 'mpr-19318.11', 'doaae 的 mpr-19318.10 在 merged 包里存为父集的 mpr-19318.11')
  assert.equal(doaae.exact, false)
  assert.ok(doaae.droppedEntries > 0, '其它版本的程序 ROM 应被丢弃')
  assert.deepEqual(doaae.missingDevices.map((device) => device.shortname), ['segabill'])
  assert.equal(mameCatalogBiosName(doaae), 'segabill')
})

await check('merged 包：文件名不是短名时不替管理员猜；播放器侧按父集兜底', () => {
  const entries = mergedEntries(DOA_FAMILY)
  const result = identifyMameCatalogSets(catalog, entries, 'Dead or Alive (merged).zip')
  assert.equal(result.chosen, null)
  assert.equal(pickMameCatalogSetForPlayback(result)?.romset, 'doa')
  assert.equal(identifyMameCatalogSets(catalog, entries, 'doaae.zip').chosen?.romset, 'doaae')
  assert.equal(identifyMameCatalogSets(catalog, entries, 'roms/arcade/doaae.zip.8bg').chosen?.romset, 'doaae')
})

await check('设备 ROM：包里自带 segabill（根目录或子目录）就一并打进单集，不再要 BIOS 包', () => {
  for (const device of [SEGABILL, { ...SEGABILL, name: 'segabill/epr-18022.ic2' }]) {
    const result = identifyMameCatalogSets(catalog, mergedEntries(DOA_FAMILY, [device]), 'doaae.zip')
    const doaae = result.chosen
    assert.equal(doaae.romset, 'doaae')
    assert.deepEqual(doaae.bundledDevices.map((item) => item.shortname), ['segabill'])
    assert.deepEqual(doaae.missingDevices, [])
    assert.equal(mameCatalogBiosName(doaae), '')
    assert.ok(doaae.items.some((item) => item.name === 'epr-18022.ic2' && item.entry === device))
  }
})

await check('单集：原名、根目录、恰好这些成员时标记 exact，不重组', () => {
  const entries = [...entriesFor('doaae'), SEGABILL]
  const result = identifyMameCatalogSets(catalog, entries, 'whatever.zip')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.chosen.romset, 'doaae')
  assert.equal(result.chosen.exact, true)
  assert.equal(result.chosen.droppedEntries, 0)
  const withoutDevice = identifyMameCatalogSets(catalog, entriesFor('doaae'), 'doaae.zip').chosen
  assert.equal(withoutDevice.exact, true)
})

await check('不完整、长度不符或路径不安全的包不识别', () => {
  const missing = entriesFor('doaae').slice(1)
  assert.equal(identifyMameCatalogSets(catalog, missing, 'doaae.zip').candidates.length, 0, '少一颗 ROM 不能认')
  const wrongSize = entriesFor('doaae').map((entry, index) => (index === 0 ? { ...entry, uncompressedSize: 1 } : entry))
  assert.equal(identifyMameCatalogSets(catalog, wrongSize, 'doaae.zip').candidates.length, 0, '同 CRC 但长度不对不能算')
  const unsafe = [...entriesFor('doaae'), { ...SEGABILL, name: '../epr-18022.ic2' }]
  assert.equal(identifyMameCatalogSets(catalog, unsafe, 'doaae.zip').candidates.length, 0, '路径穿越包不给任何豁免')
})

await check('运行时预筛：只有 Sega 式 ROM 名才加载数据表', () => {
  assert.equal(mayContainMameCatalogSet(entriesFor('doaae')), true)
  assert.equal(mayContainMameCatalogSet([{ name: 'doa/EPR-19383A.12' }]), true)
  assert.equal(mayContainMameCatalogSet([{ name: '232-p1.p1' }, { name: '232-c1.c1' }]), false)
})

await check('BIOS 包校验：segabill.zip 必须在根目录有正确 CRC 的 epr-18022.ic2', () => {
  assert.equal(mameCatalogDeviceBiosProblem(catalog, 'segabill', [SEGABILL]), null)
  assert.match(mameCatalogDeviceBiosProblem(catalog, 'segabill', [{ ...SEGABILL, crc32: 1 }]), /epr-18022\.ic2/)
  assert.match(mameCatalogDeviceBiosProblem(catalog, 'segabill', [{ ...SEGABILL, name: 'x/epr-18022.ic2' }]), /根目录/)
  assert.equal(mameCatalogDeviceBiosProblem(catalog, 'neogeo', [{ name: 'sp-s2.sp1', crc32: 1 }]), null, '不是目录里的设备交给通用检查')
  assert.equal(mameCatalogDeviceBiosProblem(catalog, 'model1io', [{ name: 'epr-14869c.25', crc32: 0x24b68e64 }]), null)
})

await check('状态提示：多组设备缺失时明确说 BIOS 栏只能挂一个', () => {
  const vcop = identifyMameCatalogSets(catalog, entriesFor('vcop'), 'vcop.zip').chosen
  assert.equal(vcop.missingDevices.length, 2)
  assert.equal(mameCatalogBiosName(vcop), '')
  assert.match(mameCatalogStatusNote(vcop), /只能挂一个/)
})

// ── 字节级：合成小目录 + 真 ZIP ─────────────────────────────

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
const bytes = (text) => new TextEncoder().encode(text)
const romSpec = (name, data) => `${name}:${crc32(data).toString(16).padStart(8, '0')}:${data.length.toString(16)}`

const shared = bytes('shared graphics data '.repeat(50))
const parentProgram = bytes('parent program')
const cloneProgram = bytes('clone program!')
const deviceRom = bytes('billboard mcu')
const tiny = buildMameCatalog([
  { r: 'tparent', p: '', t: 'Test Parent', y: 1996, b: 'Sega Model 2B-CRX', s: 'ok', v: ['tdev'], d: [], f: `${romSpec('p.15', parentProgram)} ${romSpec('gfx.11', shared)}` },
  // 克隆集：同一份图形数据换了芯片位置名；另有一颗与图形同 CRC 的别名，验证一个成员可供两个名字
  { r: 'tclone', p: 'tparent', t: 'Test Clone', y: 1996, b: 'Sega Model 2A-CRX', s: 'ok', v: ['tdev'], d: [], f: `${romSpec('c.12', cloneProgram)} ${romSpec('gfx.10', shared)} ${romSpec('gfx-mirror.9', shared)}` },
], [{ i: 'tdev', n: 'tdev', t: 'Test Device', f: romSpec('dev.ic2', deviceRom) }], 'test')

await check('重组：从 merged 包抽出克隆集，原名写回、数据逐字节不变、其它版本被丢弃', async () => {
  const merged = new Blob([zipSync({
    'p.15': parentProgram,
    'gfx.11': [shared, { level: 9 }],
    'tclone/c.12': cloneProgram,
    'dev.ic2': deviceRom,
    'readme.txt': bytes('hello'),
  })])
  const entries = await assertValidZipBlob(merged, '测试 merged 包')
  const result = identifyMameCatalogSets(tiny, entries, 'tparent.zip')
  assert.deepEqual(result.candidates.map((candidate) => candidate.romset).sort(), ['tclone', 'tparent'])
  const clone = result.candidates.find((candidate) => candidate.romset === 'tclone')
  assert.deepEqual(clone.bundledDevices.map((device) => device.id), ['tdev'])
  const rebuilt = await buildMameCatalogSetZip(merged, clone)
  const out = unzipSync(new Uint8Array(await rebuilt.arrayBuffer()))
  assert.deepEqual(Object.keys(out).sort(), ['c.12', 'dev.ic2', 'gfx-mirror.9', 'gfx.10'])
  assert.deepEqual(out['c.12'], cloneProgram)
  assert.deepEqual(out['gfx.10'], shared)
  assert.deepEqual(out['gfx-mirror.9'], shared)
  assert.deepEqual(out['dev.ic2'], deviceRom)
  const again = identifyMameCatalogSets(tiny, await assertValidZipBlob(rebuilt, '重组结果'), 'tclone.zip')
  assert.equal(again.chosen?.romset, 'tclone')
  assert.equal(again.chosen.exact, true, '重组结果本身就是自洽单集')
  assert.equal(await buildMameCatalogSetZip(rebuilt, again.chosen), rebuilt, '已是单集时原样返回，不再重写')
})

await check('拍平器仍走共享 ZIP 写出器且行为不变', async () => {
  const nested = new Blob([zipSync({ 'folder/kof97.rom': new Uint8Array([1, 2, 3]) })])
  const flattened = await flattenArcadeZipBlob(nested)
  assert.equal(flattened.flattenedCount, 1)
  assert.deepEqual(unzipSync(new Uint8Array(await flattened.blob.arrayBuffer()))['kof97.rom'], new Uint8Array([1, 2, 3]))
  await assert.rejects(
    flattenArcadeZipBlob(new Blob([zipSync({ 'a/x.rom': new Uint8Array([1]), 'b/x.rom': new Uint8Array([2]) })])),
    /多个 ROM 重名/,
  )
})

// ── 接线：后台上传、BIOS 面板、播放器 ──────────────────────

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

await check('后台上传：先按目录识别 / 重组 merged 包，再走拍平；分不清版本时让管理员选', () => {
  const form = read('src/admin/GameForm.tsx')
  const catalogAt = form.indexOf('identifyMameCatalogSets(catalog, arcadeEntries, uploadSourceFile.name)')
  const flattenAt = form.indexOf('flattenArcadeZipBlob(uploadSourceFile, arcadeEntries)')
  assert.ok(catalogAt > 0 && flattenAt > catalogAt, 'merged 包必须在拍平之前重组，否则克隆子目录会因重名被拒')
  assert.match(form, /chooseCatalogSet\(identification\.candidates, uploadSourceFile\.name\)/)
  assert.match(form, /buildMameCatalogSetZip\(uploadSourceFile, pick\)/)
  assert.match(form, /onBiosFound\?\.\(mameCatalogBiosName\(catalogSet\)\)/, '设备 ROM 缺失时自动填 BIOS 系统名；自带时撤掉旧的自动值')
  assert.match(form, /sniffArcade\(uploadSourceFile, uploadSourceFile === arcadeEntriesOf \? arcadeEntries : undefined\)/, '重组后不能拿旧中央目录的偏移去识别')
})

await check('BIOS 面板：segabill 是已知系统包并按目录核对内容', () => {
  const panel = read('src/admin/PlatformBiosPanel.tsx')
  assert.match(panel, /name: 'segabill'/)
  assert.match(panel, /mameCatalogDeviceBiosProblem\(catalog, id\.slice\('bios:'\.length\), entries\)/)
})

await check('播放器：认出 Model 2 set 后强制 mame-current、按 CRC 结果命名、不下无用的平台 BIOS', () => {
  const adapter = read('src/emulator/adapters/emulatorjs.ts')
  assert.match(adapter, /const mameCatalogSet = hack \|\| namcoSet \? null : await identifyRuntimeMameCatalogSet\(entries, name\)/)
  assert.match(adapter, /if \(!mayContainMameCatalogSet\(entries\)\) return null/, '非 Sega 包不能为数据表多一次请求')
  assert.match(adapter, /engineGameName = `\$\{mameCatalogSet\.romset\}\.zip`/)
  assert.match(adapter, /core = 'mame-current'/)
  assert.match(adapter, /namcoSet\?\.buttons \?\? mameCatalogSet\?\.buttons/)
})

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\nMAME set 目录回归全部通过')
