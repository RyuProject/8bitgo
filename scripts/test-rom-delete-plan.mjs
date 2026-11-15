import assert from 'node:assert/strict'
import {
  buildObjectReferenceIndex,
  objectKeyOf,
  objectReferenceMatches,
  planRomObjectDeletion,
  referencesForObject,
  scanUnreferencedObjects,
  unbindRomObjectKeys,
} from '../src/admin/romDeletePlan.ts'

const game = (overrides = {}) => ({
  slug: 'game',
  title: 'Game',
  platform: 'gba',
  rom: undefined,
  roms: {},
  romBackups: {},
  ...overrides,
})

const shared = game({
  slug: 'shared',
  rom: 'roms/gba/shared.gba',
  roms: { en: 'roms/gba/shared.gba', ja: 'roms/gba/other.gba' },
  romBackups: { en: 'roms/gba/other.gba' },
})
const other = game({ slug: 'other', roms: { zhHans: 'roms/gba/shared.gba' } })
const backupOnly = game({ slug: 'backup-only', romBackups: { en: 'roms/gba/other.gba' } })
const bundlePlan = planRomObjectDeletion([shared, other, backupOnly], ['roms/gba/shared.gba', 'roms/gba/other.gba'])
assert.deepEqual(bundlePlan.romGames.map(({ slug }) => slug), ['shared', 'other', 'backup-only'])
assert.deepEqual(bundlePlan.otherReferences, [])

const protectedPlan = planRomObjectDeletion([
  game({ slug: 'poster', cover: 'roms/gba/shared.gba' }),
  game({ slug: 'arcade-disk', arcadeMameDisks: [{ key: 'roms/gba/shared.gba' }] }),
  game({ slug: 'dos-addon', dosExtras: ['?roms/gba/shared.gba|PATCH.DAT'] }),
], ['roms/gba/shared.gba'])
assert.deepEqual(protectedPlan.otherReferences.map(({ slug, field }) => [slug, field]), [
  ['poster', '封面'],
  ['arcade-disk', 'MAME 媒体盘'],
  ['dos-addon', 'DOS 附加文件'],
])
assert.equal(objectReferenceMatches('DOS 流式盘', 'roms/dos/game/sockdrive-v1', new Set(['roms/dos/game/sockdrive-v1/0.raw'])), true)
assert.equal(objectReferenceMatches('封面', 'roms/dos/game/sockdrive-v1', new Set(['roms/dos/game/sockdrive-v1/0.raw'])), false)

const patch = unbindRomObjectKeys(shared, ['roms/gba/shared.gba', 'roms/gba/other.gba'])
assert.equal(patch.rom, undefined)
assert.deepEqual(patch.roms, undefined)
assert.equal(patch.romBackups, undefined)
assert.deepEqual(unbindRomObjectKeys(shared, ['roms/gba/not-bound.gba']), {})

// —— 2026-11-15 清理时补的引用来源：平台 BIOS、8BG 派生、外链规范化 ——
assert.equal(objectKeyOf('https://assets.8bitgo.com/roms/dos/%E8%B6%85.zip?romv=1'), 'roms/dos/超.zip')
assert.equal(objectKeyOf('https://cn-assets.8bitgo.com/roms/nes/a.nes'), 'roms/nes/a.nes')
assert.equal(objectKeyOf('/systems/dos/win95.jsdos'), 'systems/dos/win95.jsdos')
assert.equal(objectKeyOf('https://example.com/roms/nes/a.nes'), null)
assert.equal(objectKeyOf('   '), null)

const absoluteRom = game({ slug: 'absolute-rom', rom: 'https://assets.8bitgo.com/roms/gba/absolute.gba?romv=2' })
assert.deepEqual(planRomObjectDeletion([absoluteRom], ['roms/gba/absolute.gba']).romGames.map(({ slug }) => slug), ['absolute-rom'], '本站绝对 URL 也必须参与精确解绑')
assert.deepEqual(unbindRomObjectKeys(absoluteRom, ['roms/gba/absolute.gba']), { rom: undefined }, '删除对象时必须清除规范化后匹配的原始 URL 绑定')

const biosPlan = planRomObjectDeletion([], ['roms/bios/neogeo.zip'], { arcade: 'roms/bios/neogeo.zip' })
assert.deepEqual(biosPlan.otherReferences.map(({ title, field }) => [title, field]), [['平台 BIOS', 'arcade']], '平台 BIOS 必须拦住删除')

const plain = game({ slug: 'plain', roms: { en: 'roms/nes/plain.en.zip' } })
assert.deepEqual(
  planRomObjectDeletion([plain], ['roms/nes/plain.en.zip.8bg']).otherReferences.map(({ field }) => field),
  ['ROM（8BG 派生）'],
  '游戏绑 a.zip 时播放器先加载 a.zip.8bg；删它会悄悄换掉玩家实际加载的文件',
)
const packed = game({ slug: 'packed', roms: { en: 'roms/nes/packed.en.zip.8bg' } })
assert.deepEqual(planRomObjectDeletion([packed], ['roms/nes/packed.en.zip']).otherReferences, [], '8BG 原件播放器不加载，单个删除按钮不拦')

// —— 批量清理扫描 ——
const library = [
  plain,
  packed,
  game({ slug: 'dos', platform: 'dos', roms: { en: 'roms/dos/dos.en.zip.8bg' }, dosSockdrives: { en: 'sockdrives/dos-en-v2' }, dosSystem: 'systems/dos/win95.jsdos' }),
  game({ slug: 'flash', platform: 'flash', roms: { en: 'roms/flash/pack.en/root.swf' } }),
  game({ slug: 'mame', platform: 'arcade', roms: { en: 'roms/arcade/dj.zip' }, arcadeMameDisks: [{ key: 'roms/arcade-media/mame/abc/disk.chd' }] }),
]
const index = buildObjectReferenceIndex(library, { psx: 'roms/bios/scph1001.bin' })
assert.ok(referencesForObject(index, 'sockdrives/dos-en-v2/0.raw').length, '流式盘目录下的分块算引用')
assert.equal(referencesForObject(index, 'sockdrives/dos-en-v1/0.raw').length, 0, '旧版本目录不能被前缀误伤成「已引用」')
assert.ok(referencesForObject(index, 'roms/_route-probe/v1.bin').length, '线路探针是系统保留对象')

const old = '2026-09-01T00:00:00.000Z'
const objects = [
  { key: 'roms/', size: 0, uploaded: old },
  { key: 'roms/nes/plain.en.zip', size: 10, uploaded: old },
  { key: 'roms/nes/plain.en.zip.8bg', size: 9, uploaded: old },
  { key: 'roms/nes/packed.en.zip.8bg', size: 8, uploaded: old },
  { key: 'roms/nes/packed.en.zip', size: 7, uploaded: old },
  { key: 'roms/nes/stale.en.zip', size: 100, uploaded: old },
  { key: 'roms/nes/fresh.en.zip', size: 5, uploaded: '2026-11-15T00:00:00.000Z' },
  { key: 'roms/flash/pack.en/root.swf', size: 3, uploaded: old },
  { key: 'roms/flash/pack.en/main21.swf', size: 3, uploaded: old },
  { key: 'roms/flash/gone.en/root.swf', size: 4, uploaded: old },
  { key: 'roms/flash/gone.en/main.swf', size: 4, uploaded: old },
  { key: 'roms/arcade-media/mame/abc/disk.chd', size: 50, uploaded: old },
  { key: 'roms/bios/scph1001.bin', size: 1, uploaded: old },
  { key: 'roms/bios/unused.bin', size: 1, uploaded: old },
  { key: 'sockdrives/dos-en-v2/0.raw', size: 20, uploaded: old },
  { key: 'sockdrives/dos-en-v2/sockdrive.metaj', size: 1, uploaded: old },
  { key: 'sockdrives/dos-en-v1/0.raw', size: 20, uploaded: old },
  { key: 'sockdrives/dos-en-v1/sockdrive.metaj', size: 1, uploaded: old },
]
const scan = scanUnreferencedObjects(objects, index, { now: Date.parse('2026-11-15T09:00:00.000Z') })
assert.deepEqual(scan.orphans.map(({ id, keys, size }) => [id, keys.length, size]), [
  ['roms/nes/stale.en.zip', 1, 100],
  ['sockdrives/dos-en-v1/', 2, 21],
  ['roms/flash/gone.en/', 2, 8],
  ['roms/bios/unused.bin', 1, 1],
], '孤儿按组：旧流式盘目录、无人引用的多文件包整目录、单文件；BIOS / MAME 盘 / 8BG 派生与原件 / 目录占位都不算')
assert.deepEqual(scan.recent.map(({ id }) => id), ['roms/nes/fresh.en.zip'], '72 小时内上传的只列出不勾选')

const partlyBound = scanUnreferencedObjects([
  { key: 'roms/flash/pack.en/root.swf', size: 3, uploaded: old },
  { key: 'roms/flash/pack.en/stray.swf', size: 3, uploaded: old },
], index, { now: Date.parse('2026-11-15T09:00:00.000Z') })
assert.deepEqual(partlyBound.orphans, [], '多文件包里任何一个文件被引用，整包都不能出现在清理清单里')

console.log('✅ ROM 删除前引用检查、共享槽解绑与非 ROM 引用保护通过')
console.log('✅ 平台 BIOS / 8BG 派生 / 外链规范化与批量清理扫描通过')
