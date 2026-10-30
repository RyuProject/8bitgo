import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const page = read('src/pages/RoomsPage.tsx')
const allRooms = read('src/services/allRooms.ts')
const netplay = read('src/services/netplay.ts')
const roomCard = read('src/components/game/RoomCard.tsx')

assert.match(page, /const ROOM_PAGE_SIZE = 24/)
assert.match(page, /const visibleRooms = rooms\.slice\(0, visibleRoomCount\)/)
assert.match(page, /visibleRooms\.map\(\(room\) =>/)
assert.match(page, /setVisibleRoomCount\(\(count\) => Math\.min\(count \+ ROOM_PAGE_SIZE, rooms\.length\)\)/)
assert.match(page, /t\.rooms\.loadedOf/)
assert.match(page, /useEffect\(\(\) => \{\s*setVisibleRoomCount\(ROOM_PAGE_SIZE\)\s*\}, \[live\]\)/)
assert.match(page, /all\.filter\(\(room\) => room\.kind !== 'cloud'\)/)
assert.match(page, /<RoomCard room=\{room\} watchOnly=\{live\} \/>/)
assert.match(roomCard, /\(full \|\| watchOnly\) && watchable/)

assert.match(allRooms, /const ALL_GAME_SLUGS = games\.map\(\(g\) => g\.slug\)/)
assert.doesNotMatch(allRooms, /const slugs = games\.map/)

const start = netplay.indexOf('const store = (() => {')
const end = netplay.indexOf('\n})()', start)
assert.ok(start >= 0 && end > start, '找不到共享的 P2P 房间列表 store')
const store = netplay.slice(start, end)
assert.match(store, /if \(inFlight\?\.generation === generation\) return inFlight\.promise/, '列表刷新必须 single-flight')
assert.match(store, /AbortController\(\)/)
assert.match(store, /LIST_REQUEST_TIMEOUT_MS/)
assert.match(store, /revision !== listRevision/, '迟到 HTTP 响应不能覆盖更新的 SSE 快照')
assert.match(store, /mine !== generation/, '断开订阅后的迟到响应不能改写缓存')
assert.match(store, /Array\.isArray\(next\)/, '服务端异常响应不能让房间页拿到非数组快照')
assert.match(store, /const connect = \(\) => \{[\s\S]*?activeRequest\?\.abort\(\)/, '重新订阅时必须终止上一代列表请求')
assert.match(store, /document\.visibilityState === 'hidden'/, '隐藏标签页必须暂停轮询')
assert.match(store, /document\.addEventListener\('visibilitychange', onVisible\)/)
assert.match(store, /POLL_MAX_MS/)
assert.doesNotMatch(store, /window\.setInterval/, '大厅降级轮询不能固定频率并发打请求')

for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'de', 'es', 'fr', 'it', 'ja']) {
  const source = read(`src/locales/${locale}.ts`)
  const roomsStart = source.indexOf('  rooms: {')
  assert.ok(roomsStart >= 0, `${locale} 缺少 rooms 文案`)
  const roomsBlock = source.slice(roomsStart, source.indexOf('\n  },', roomsStart))
  assert.match(roomsBlock, /loadedOf:/, `${locale} 缺少房间分页计数文案`)
  assert.doesNotMatch(roomsBlock, /VITE_CLOUDGAME_URL/, `${locale} 的禁用提示误称必须部署 cloud-game`)
  assert.doesNotMatch(roomsBlock, /Games run in the cloud|游戏在云端运行|Die Spiele laufen in der Cloud/, `${locale} 的介绍与 P2P 默认模式矛盾`)
}

console.log('✅ 房间大厅分页、观看意图、P2P 降级轮询和多语言说明通过检查')
