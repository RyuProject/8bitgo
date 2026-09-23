/**
 * 志愿者独立库的无数据库回归测试。
 *
 * 这里既跑对象归一化，也钉住最关键的安全边界：所有个人库 SQL 必须同时带
 * owner_id + slug，前台服务必须主动请求 library=mine，后台直达路由要在
 * Outlet 挂载前拦住。真正的 MySQL 建表由 migrate / 启动 schema-check 兜底。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_ABILITIES } from '../../shared/roles.js'
import {
  normalizeVolunteerGame,
  normalizeVolunteerPost,
  pageVolunteerGames,
} from '../src/volunteer-libraries.js'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const read = (path) => readFileSync(join(repoRoot, path), 'utf8')

assert.deepEqual(
  ROLE_ABILITIES.volunteer,
  ['games:edit', 'posts:edit'],
  '志愿者只能拥有游戏库和文章库两个权限点',
)

const game = normalizeVolunteerGame('same-slug', {
  slug: 'ignored-slug',
  title: 'Personal Game',
  titleZh: '个人游戏',
  platform: 'nes',
  genres: ['action', 'action'],
  tags: ['测试', '测试'],
  roms: { zh: 'roms/nes/personal.nes' },
  plays: 999,
  rating: 5,
  ratingCount: 100,
  players: 2,
  multiplayer: true,
  hidden: false,
  description: '只在个人库里',
  addedAt: '2026-09-23',
})
assert.equal(game.slug, 'same-slug', 'URL slug 必须覆盖请求体里的 slug')
assert.equal(game.plays, 0, '个人库不能伪造主站游玩数')
assert.equal(game.rating, 0, '个人库不能伪造主站评分')
assert.deepEqual(game.genres, ['action'])
assert.deepEqual(game.tags, ['测试'])
assert.equal(game.roms?.zh, 'roms/nes/personal.nes')

const other = normalizeVolunteerGame('other', {
  title: 'Hidden Other',
  platform: 'snes',
  hidden: true,
  genres: [],
  tags: ['second'],
})
assert.deepEqual(pageVolunteerGames([game, other], { status: 'visible' }).items.map((g) => g.slug), ['same-slug'])
assert.deepEqual(pageVolunteerGames([game, other], { q: 'second' }).items.map((g) => g.slug), ['other'])

const post = normalizeVolunteerPost('same-post', {
  slug: 'ignored-post',
  title: '个人文章',
  excerpt: '摘要',
  content: '# 正文',
  tags: ['攻略', '攻略'],
  published: true,
  author: '志愿者',
  date: '2026-09-23',
})
assert.equal(post.slug, 'same-post')
assert.deepEqual(post.tags, ['攻略'])
assert.equal(post.published, true)

const librarySource = read('server/src/volunteer-libraries.js')
for (const table of ['volunteer_games', 'volunteer_posts']) {
  assert.match(librarySource, new RegExp(`DELETE FROM ${table} WHERE owner_id = \\? AND slug = \\?`))
  assert.match(librarySource, new RegExp(`SELECT payload FROM ${table} WHERE owner_id = \\? AND slug = \\?`))
}

const gamesRoute = read('server/src/routes/games.js')
assert.ok(gamesRoute.includes("requireAbility('games:edit')"))
assert.ok(gamesRoute.includes("req.staffRole === 'volunteer'"))
assert.ok(gamesRoute.includes('saveVolunteerGame(ownerId, slug, req.body)'))
assert.ok(gamesRoute.includes('deleteVolunteerGame(ownerId, req.params.slug)'))

const postsRoute = read('server/src/routes/posts.js')
assert.ok(postsRoute.includes("requireAbility('posts:edit')"))
assert.ok(postsRoute.includes("req.staffRole === 'volunteer'"))
assert.ok(postsRoute.includes('saveVolunteerPost(ownerId, slug, req.body)'))
assert.ok(postsRoute.includes('deleteVolunteerPost(ownerId, slug)'))

// 公网站点的主库仓储层不允许认识个人表；这是“个人草稿绝不会漏到前台”的结构保证。
for (const path of ['server/src/games-repo.js', 'server/src/content.js']) {
  const source = read(path)
  assert.equal(source.includes('volunteer_games'), false, `${path} 不得查询志愿者游戏表`)
  assert.equal(source.includes('volunteer_posts'), false, `${path} 不得查询志愿者文章表`)
}

assert.ok(read('src/services/store.ts').includes("library: 'mine'"))
assert.ok(read('src/services/posts.ts').includes('/api/posts?all=1&library=mine'))

const layout = read('src/admin/AdminLayout.tsx')
assert.ok(layout.includes("'/admin/games', label: '游戏', need: 'games:edit'"))
assert.ok(layout.includes("'/admin/posts', label: '文章', need: 'posts:edit'"))
assert.ok(layout.includes("me?.role === 'volunteer'"))
assert.ok(layout.includes('<Navigate to={firstAllowed} replace />'))

const gamesUi = read('src/admin/AdminGames.tsx')
assert.ok(gamesUi.includes('const keys = personalLibrary ? []'))
assert.ok(gamesUi.includes('personalLibrary={personalLibrary}'))
assert.ok(read('src/admin/GameForm.tsx').includes('const canUpload = allowStorage &&'))

for (const path of [
  'server/schema-v2.sql',
  'server/schema-d1.sql',
  'server/8bitgo-v2-install.sql',
  'server/scripts/migrate.mjs',
  'server/src/schema-check.js',
]) {
  const source = read(path)
  assert.ok(source.includes('volunteer_games'), `${path} 缺 volunteer_games`)
  assert.ok(source.includes('volunteer_posts'), `${path} 缺 volunteer_posts`)
}

console.log('志愿者独立游戏库 / 文章库：权限、归一化、账号隔离、路由与建表检查全部通过')
