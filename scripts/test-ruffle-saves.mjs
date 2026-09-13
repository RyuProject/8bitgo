/** Ruffle 存档路径与恢复测试：防止不同 Flash 游戏串档，或写到一半留下坏进度。 */
import assert from 'node:assert/strict'
import {
  flashMovieUrl, flashSavePrefix, isSolBase64, readFlashEntries,
  readLegacyFlashEntries, restoreFlashEntries, validFlashEntries,
} from '../src/emulator/ruffleSaves.ts'

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
