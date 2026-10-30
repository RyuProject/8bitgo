import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_ADMIN_IMPORT_ITEMS, validateAdminImportPayload } from '../server/src/admin-import.js'

const validGame = {
  slug: 'super-mario-bros',
  title: 'Super Mario Bros.',
  platform: 'nes',
  genres: ['platformer'],
  players: 1,
  multiplayer: false,
}

assert.deepEqual(validateAdminImportPayload({ games: [validGame] }), {
  error: null,
  gameList: [validGame],
  postList: [],
})
assert.match(validateAdminImportPayload({ games: [{ ...validGame, slug: '../escape' }] }).error, /slug/)
assert.match(validateAdminImportPayload({ games: [{ ...validGame, slug: '' }] }).error, /缺少 slug/)
assert.match(validateAdminImportPayload({ games: [{ ...validGame, multiplayer: true, players: 1 }] }).error, /最大玩家数/)
assert.match(
  validateAdminImportPayload({ games: [validGame, { ...validGame, title: 'Duplicate' }] }).error,
  /重复/,
)
assert.match(
  validateAdminImportPayload({ games: Array.from({ length: MAX_ADMIN_IMPORT_ITEMS + 1 }, (_, i) => ({ ...validGame, slug: `game-${i}` })) }).error,
  /单次最多/,
)
assert.match(validateAdminImportPayload({ games: {} }).error, /必须是数组/)

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const adminGames = read('src/admin/AdminGames.tsx')
const gameForm = read('src/admin/GameForm.tsx')
const adminRoms = read('src/admin/AdminRoms.tsx')
const adminPosts = read('src/admin/AdminPosts.tsx')
const adminOverview = read('src/admin/AdminOverview.tsx')
const store = read('src/services/store.ts')
const postsService = read('src/services/posts.ts')
const gamesRoute = read('server/src/routes/games.js')
const postsRoute = read('server/src/routes/posts.js')
const usersRoute = read('server/src/routes/users.js')
const repo = read('server/src/games-repo.js')
const adminRoute = read('server/src/routes/admin.js')

// 删除资料不能再把可能由其它游戏共用的 R2 对象一起删掉。
assert.doesNotMatch(adminGames, /deleteRomObjects/)
assert.match(adminGames, /R2 文件已安全保留/)

// 新增必须走数据库唯一索引裁决的 INSERT-only，不能退回有竞态的「先查再 upsert」。
assert.match(store, /options\.createOnly \? '\?create=1'/)
assert.match(gamesRoute, /if \(createOnly\) await createGame/)
assert.match(gamesRoute, /error\?\.code === 'ER_DUP_ENTRY'/)
assert.match(repo, /if \(createOnly\) \{\s*await run\(insert/)
assert.match(postsService, /options\.createOnly \? '\?create=1'/)
assert.match(postsRoute, /createOnly \? insert/)
assert.match(postsRoute, /postsRouter\.patch\('\/:slug\/published'/)
assert.match(adminPosts, /fetchAdminPostSummaries/)
assert.doesNotMatch(adminOverview, /useAllUsers|fetchAllPosts/)

// 大表单保存和行操作都必须单飞；有改动时关页 / 取消要提醒。
assert.match(adminGames, /if \(savingRef\.current\) return/)
assert.match(adminGames, /if \(rowActionRef\.current\) return/)
assert.match(gameForm, /window\.addEventListener\('beforeunload'/)
assert.match(gameForm, /<fieldset disabled=\{submitting\}/)

// ROM 存储页的对象绑定、删除必须共用单飞锁，避免绑定请求和删除请求交错后留下悬空 key。
const romBindBlock = adminRoms.slice(adminRoms.indexOf('const bind = async'), adminRoms.indexOf('const requireCompleteReferences'))
assert.match(romBindBlock, /if \(busyRef\.current\) return/)
assert.match(romBindBlock, /finally\s*\{\s*busyRef\.current = false/)
assert.match(adminRoms, /const gamesRequestId = useRef\(0\)/)
assert.match(adminRoms, /const listRequestId = useRef\(0\)/)
assert.match(adminRoms, /gamesAbortController\.current\?\.abort\(\)/)
assert.match(adminRoms, /listAbortController\.current\?\.abort\(\)/)
assert.match(adminRoms, /fetchGamePages\(maxPages, controller\.signal\)/)
assert.match(store, /fetchAdminGames\(q: AdminGameQuery = \{\}, signal\?: AbortSignal\)/)
assert.match(read('src/services/roms.ts'), /listRomObjects\(prefix = getRomPrefix\(\), signal\?: AbortSignal\)/)
assert.match(adminRoms, /if \(toastTimer\.current !== null\) window\.clearTimeout\(toastTimer\.current\)/)
assert.match(adminRoms, /if \(requestId !== gamesRequestId\.current\) return/)
assert.match(adminRoms, /if \(requestId !== listRequestId\.current\) return/)
assert.match(adminRoms, /<datalist id=\{ROM_GAME_DATALIST_ID\}>/)
assert.match(adminRoms, /const gameMatchIndex = useMemo\(\(\) => buildGameMatchIndex\(games\), \[games\]\)/)
const objectRow = adminRoms.slice(adminRoms.indexOf('function ObjectRow('), adminRoms.indexOf('function BundleRow('))
assert.doesNotMatch(objectRow, /games\.map\(\(g\) => \(/, '不能在每一行重复渲染整份游戏选项')

// R2 删除只有拿到全库引用后才允许；共享 key 要保留所有引用，不能只记第一款游戏。
assert.match(adminRoms, /const bindingsByRom = useMemo/)
assert.match(adminRoms, /if \(allGamesLoaded\) return true/)
assert.match(adminRoms, /await unbindKeys\(keys\)/)
assert.match(gameForm, /R2 文件安全保留/)

// 用户页只取收藏 / 最近数量，不能把上百万条关联明细拖进 Node；搜索在数据库里完成。
assert.match(usersRoute, /COUNT\(\*\) AS n FROM favorites/)
assert.match(usersRoute, /COUNT\(\*\) AS n FROM recents/)
assert.doesNotMatch(usersRoute, /JOIN games g ON g\.id = [fr]\.game_id/)
assert.match(usersRoute, /nickname LIKE \? OR email LIKE \?/)

// 导入必须在第一条写库之前完成整批校验，避免第 N 条坏数据留下半批覆盖结果。
const validationAt = adminRoute.indexOf('validateAdminImportPayload(req.body)')
const writeAt = adminRoute.indexOf('for (const g of gameList)')
assert.ok(validationAt > 0 && writeAt > validationAt)

console.log('✅ 后台安全与操作保护：全部通过')
