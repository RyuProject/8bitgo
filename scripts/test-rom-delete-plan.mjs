import assert from 'node:assert/strict'
import { objectReferenceMatches, planRomObjectDeletion, unbindRomObjectKeys } from '../src/admin/romDeletePlan.ts'

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

console.log('✅ ROM 删除前引用检查、共享槽解绑与非 ROM 引用保护通过')
