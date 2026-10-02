/** Ruffle 存档路径与恢复测试：防止不同 Flash 游戏串档，或写到一半留下坏进度。 */
import assert from 'node:assert/strict'
import {
  flashLegacySavePrefixes, flashMovieUrl, flashSavePrefix, flashSaveSwfName, isSolBase64, readFlashEntries,
  readLegacyFlashEntries, restoreFlashEntries, validFlashEntries,
} from '../src/emulator/ruffleSaves.ts'
import {
  FLASH_SAVE_TOMBSTONE, createScopedFlashStorage, moveFlashEntries, scopedFlashKey,
} from '../src/emulator/ruffleStorageScope.ts'

class FakeStorage {
  data = new Map()
  failOn = null
  get length() { return this.data.size }
  key(index) { return [...this.data.keys()][index] ?? null }
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) {
    if (key === this.failOn) {
      this.failOn = null
      throw new Error('quota exceeded')
    }
    this.data.set(key, value)
  }
  removeItem(key) { this.data.delete(key) }
}

const sol = btoa('\0\xBF\0\0\0\0TCSO\0\x04\0\0\0\0data')
assert.equal(isSolBase64(sol), true)
assert.equal(isSolBase64(btoa('not a save')), false)

const movie = flashMovieUrl('https://8bitgo.com/flash-frames/game-a/frame.html?x=1#top', 'game-a.swf')
assert.equal(movie.href, 'https://8bitgo.com/flash-frames/game-a/game-a.swf')
const prefix = flashSavePrefix(movie)
assert.equal(prefix, '8bitgo.com/flash-frames/game-a/game-a.swf/')

const store = new FakeStorage()
store.setItem(prefix + 'slot1', sol)
store.setItem(prefix + 'slot2', sol)
store.setItem('8bitgo.com/flash-frames/game-b/game-b.swf/slot1', sol)
store.setItem(prefix + 'fake', 'not a save')
store.setItem('/srcdoc/old-slot', sol)
assert.deepEqual(Object.keys(readFlashEntries(store, prefix)).sort(), ['slot1', 'slot2'])
assert.deepEqual(Object.keys(readLegacyFlashEntries(store)), ['old-slot'])
assert.equal(validFlashEntries({ slot1: sol }), true)
assert.equal(validFlashEntries({ slot1: 'bad' }), false)
assert.equal(validFlashEntries({}), false)

restoreFlashEntries(store, prefix, { slot1: sol }, true)
assert.equal(store.getItem(prefix + 'slot2'), null, '整份恢复应删除旧版多余的槽')
assert.equal(store.getItem('8bitgo.com/flash-frames/game-b/game-b.swf/slot1'), sol, '不能改动另一款游戏')
assert.equal(store.getItem('/srcdoc/old-slot'), sol, '旧版数据要保留，供玩家手动恢复')

store.failOn = prefix + 'slot3'
assert.throws(() => restoreFlashEntries(store, prefix, { slot2: sol, slot3: sol }, true), /quota exceeded/)
assert.equal(store.getItem(prefix + 'slot1'), sol, '失败后原进度必须回滚')
assert.equal(store.getItem(prefix + 'slot2'), null, '失败后不能留半份新进度')

console.log('✅ Ruffle 存档路径、游戏隔离、旧版读取与失败回滚通过')

console.log('── 存档路径跟着游戏走，不跟着文件名走 ──')
assert.equal(flashSaveSwfName('https://r2.x/roms/flash/game-a.swf?romv=1', 'game-a.swf'), 'game-a.swf', '单 SWF 路径不变，存量存档无需迁移')
assert.equal(flashSaveSwfName('https://r2.x/roms/flash/game-a.swf.8bg?romv=2', 'My Game (final).swf'), 'game-a.swf', '重传成 8BG 不能换存档路径')
assert.equal(flashSaveSwfName('https://r2.x/roms/flash/game-a/root.swf', 'root.swf'), 'game-a.swf', '改成多 SWF 包不能换存档路径')
assert.equal(flashSaveSwfName('https://r2.x/roms/flash/game-a.zh-Hans.swf.8bg', 'x.swf'), 'game-a.zh-Hans.swf', '语言版本仍各自独立')
assert.equal(flashSaveSwfName('https://r2.x/roms/flash/game-a.zh-Hans/root.swf', 'root.swf'), 'game-a.zh-Hans.swf')
assert.equal(flashSaveSwfName(null, 'local.swf'), 'local.swf', '本地文件沿用文件名')
assert.equal(flashSaveSwfName('https://r2.x/pack.zip#inner.swf', 'inner.swf'), 'inner.swf', '认不出 SWF 名时退回下载名')
const frameHref = 'https://8bitgo.com/flash-frames/game-a/frame.html'
assert.deepEqual(flashLegacySavePrefixes(frameHref, 'game-a.swf'), ['8bitgo.com/flash-frames/game-a/game-a.swf/'])
assert.ok(flashLegacySavePrefixes(frameHref, 'Game [v2].swf').includes('8bitgo.com/flash-frames/game-a/Game%20[v2].swf/'),
  '必须覆盖 Ruffle 按 WHATWG URL 落盘的那种编码')

console.log('── localPath="/" 的存档按游戏隔离，且能被导出 ──')
const scopeA = { hostPrefix: '8bitgo.com/', gameDir: 'flash-frames/game-a/', savePrefix: '8bitgo.com/flash-frames/game-a/game-a.swf/' }
const scopeB = { hostPrefix: '8bitgo.com/', gameDir: 'flash-frames/game-b/', savePrefix: '8bitgo.com/flash-frames/game-b/game-b.swf/' }
assert.equal(scopedFlashKey(scopeA, '8bitgo.com/flash-frames/game-a/game-a.swf/slot1'), scopeA.savePrefix + 'slot1')
assert.equal(scopedFlashKey(scopeA, '8bitgo.com/flash-frames/game-a/root.swf/slot1'), scopeA.savePrefix + 'slot1', '旧文件名路径归到规范前缀')
assert.equal(scopedFlashKey(scopeA, '8bitgo.com//save'), scopeA.savePrefix + '~shared//save')
assert.equal(scopedFlashKey(scopeA, '8bitgo.com/flash-frames/game-a/save'), scopeA.savePrefix + '~shared/flash-frames/game-a/save')
assert.equal(scopedFlashKey(scopeA, '8bitgo.com/flash-frames/game-a/#a/b'), scopeA.savePrefix + '~shared/flash-frames/game-a/#a/b', '含 / 的槽名不能被误认成 SWF 段')
assert.equal(scopedFlashKey(scopeA, 'ruffle-volume'), null, 'Ruffle 自己的偏好键原样透传')

const shared = new FakeStorage()
shared.setItem('8bitgo.com//save', sol) // 修复前写下的旧根路径存档
const a = createScopedFlashStorage(shared, () => scopeA)
const b = createScopedFlashStorage(shared, () => scopeB)
assert.equal(a['8bitgo.com//save'], sol, '旧的根路径存档必须还能读到')
assert.equal(shared.getItem(scopeA.savePrefix + '~shared//save'), sol, '读到后顺手迁进本局前缀')
const solB = btoa('\0\xBF\0\0\0\0TCSO\0\x04\0\0\0\0gameB')
b['8bitgo.com//save'] = solB
assert.equal(a['8bitgo.com//save'], sol, 'B 用同名存档不能再覆盖 A 的进度')
assert.equal(b.getItem('8bitgo.com//save'), solB)
assert.equal(shared.getItem('8bitgo.com//save'), sol, '旧键原样保留，不改动')
assert.deepEqual(Object.keys(readFlashEntries(shared, scopeA.savePrefix)), ['~shared//save'], '根路径存档要能被导出 / 云存档')
delete a['8bitgo.com//save']
assert.equal(a['8bitgo.com//save'], undefined, '删除后不能从旧键回退读回来')
assert.equal(shared.getItem(scopeA.savePrefix + '~shared//save'), FLASH_SAVE_TOMBSTONE)
assert.equal('8bitgo.com//save' in a, false)
assert.equal(a.length, shared.length)
assert.equal(typeof a.key, 'function')
const passthrough = createScopedFlashStorage(shared, () => null)
assert.equal(passthrough.getItem('8bitgo.com//save'), sol, 'scope 未就绪时完全透传')

console.log('── 旧文件名路径的槽搬到规范前缀 ──')
const moveStore = new FakeStorage()
moveStore.setItem('8bitgo.com/flash-frames/game-a/root.swf/slot1', solB)
moveStore.setItem(scopeA.savePrefix + 'slot1', sol)
moveStore.setItem(scopeA.savePrefix + 'slot2', sol)
assert.equal(moveFlashEntries(moveStore, '8bitgo.com/flash-frames/game-a/root.swf/', scopeA.savePrefix), 1)
assert.equal(moveStore.getItem(scopeA.savePrefix + 'slot1'), solB, 'Ruffle 当前在读的那份为准')
assert.equal(moveStore.getItem(scopeA.savePrefix + 'slot2'), sol, '规范前缀独有的槽保留')
assert.equal(moveStore.getItem('8bitgo.com/flash-frames/game-a/root.swf/slot1'), null, '搬完删旧键，下次不会再覆盖新进度')
moveStore.setItem('8bitgo.com/flash-frames/game-a/old.swf/slot9', sol)
moveStore.failOn = scopeA.savePrefix + 'slot9'
assert.equal(moveFlashEntries(moveStore, '8bitgo.com/flash-frames/game-a/old.swf/', scopeA.savePrefix), 0)
assert.equal(moveStore.getItem('8bitgo.com/flash-frames/game-a/old.swf/slot9'), sol, '配额满时旧键必须原样保留')

console.log('✅ 存档稳定路径、根路径隔离与迁移通过')
