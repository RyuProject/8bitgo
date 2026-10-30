import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const route = read('server/src/routes/comments.js')
const panel = read('src/components/comments/Comments.tsx')
const admin = read('src/admin/AdminComments.tsx')
const migration = read('server/scripts/migrate.mjs')
const schema = read('server/schema-v2.sql')
const service = read('src/services/comments.ts')
const mapper = read('server/src/mappers.js')
const types = read('src/types.ts')
const gameRepo = read('server/src/games-repo.js')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

check('公开评论列表在查询数据库前按 IP 与全站限流', () => {
  const start = route.indexOf("commentsRouter.get('/', async")
  const end = route.indexOf("commentsRouter.patch('/:id'", start)
  const publicList = route.slice(start, end)
  assert.match(publicList, /takeAnonymous\(req, 'comments-list'/)
  assert.ok(publicList.indexOf('takeAnonymous') < publicList.indexOf('resolveTarget'))
})

check('后台筛选和模糊搜索都校验允许值与长度', () => {
  assert.match(route, /MAX_SEARCH_LEN = 120/)
  assert.match(route, /评论状态筛选值不合法/)
  assert.match(route, /评论归属筛选值不合法/)
  assert.match(route, /q\.length > MAX_SEARCH_LEN/)
  assert.match(route, /c\.pending_review = 0 AND c\.hidden = 1 AND c\.deleted_at IS NULL/)
  assert.match(route, /c\.pending_review = 1 AND c\.deleted_at IS NULL/)
})

check('后台会将已失效的页码夹到真实末页', () => {
  assert.match(route, /const page = Math\.min\(requestedPage, Math\.max\(1, Math\.ceil\(total \/ size\)\)\)/)
  assert.match(route, /const offset = \(page - 1\) \* size/)
})

check('评论编辑在数据库更新时再次校验所有权、可见性和五分钟窗口', () => {
  assert.match(route, /WHERE id = \? AND user_id = \? AND hidden = 0 AND deleted_at IS NULL[\s\S]{0,100}created_at >= CURRENT_TIMESTAMP\(3\) - INTERVAL 5 MINUTE/)
  assert.match(route, /评论状态已变化，请刷新后重试/)
})

check('前台加载更多失败有独立重试状态，不污染发表错误', () => {
  assert.match(panel, /const \[loadMoreError, setLoadMoreError\]/)
  assert.match(panel, /setLoadMoreError\(e instanceof Error \? e\.message : c\.loadFailed\)/)
  assert.match(panel, /loadMoreError \? c\.retry : c\.loadMore/)
  assert.doesNotMatch(panel, /setFormError\(e instanceof Error \? e\.message : c\.loadFailed\)[\s\S]{0,200}if \(append\)/)
})

check('管理端丢弃过期列表响应，审核动作后按当前筛选重新读取', () => {
  assert.match(admin, /const requestSeq = useRef\(0\)/)
  assert.match(admin, /if \(seq !== requestSeq\.current\) return/)
  assert.match(admin, /const \[reloadVersion, setReloadVersion\]/)
  assert.match(admin, /setReloadVersion\(\(n\) => n \+ 1\)/)
})

check('游客发言可入库但始终待审核，登录用户发表后立即可见', () => {
  const post = route.slice(route.indexOf("commentsRouter.post('/', optionalUser"), route.indexOf("commentsRouter.patch('/:id'"))
  assert.match(post, /pendingReview = !req\.user/)
  assert.match(post, /req\.user\?\.id \?\? null/)
  assert.match(post, /pending_review\) VALUES[\s\S]*pendingReview \? 1 : 0/)
  assert.match(post, /takeAnonymous\(req, 'comment:guest'/)
  assert.match(post, /req\.user\?\.status === 'banned'/)
  assert.match(route, /c\.pending_review = 0 AND c\.hidden = 0 AND c\.deleted_at IS NULL/)
  assert.match(panel, /if \(!content \|\| sending \|\| !authReady\) return/)
})

check('游客可回复公开评论，但不能回复尚未审核的内容', () => {
  assert.match(route, /pending_review = 0 AND hidden = 0 AND deleted_at IS NULL/)
  assert.match(panel, /onReply=\{startReply\}/)
  assert.match(panel, /created\.pendingReview[\s\S]*setFormNotice\(c\.pendingNotice\)/)
  assert.match(panel, /待审核内容不能乐观插入公开列表/)
})

check('后台可筛选、通过游客评论，并继续隐藏或删除任何非删除项', () => {
  assert.match(route, /pendingReview: value/)
  assert.match(route, /必须且只能提供 hidden 或 pendingReview/)
  assert.match(admin, /\{ id: 'pending', label: '待审核' \}/)
  assert.match(admin, /approveComment\(item\.id\)/)
  assert.match(service, /pendingReview: false/)
  assert.match(admin, /item\.pendingReview &&/)
})

check('数据库允许游客作者为空且为审核状态建立索引，迁移保留旧评论可见', () => {
  assert.match(schema, /user_id\s+VARCHAR\(40\)\s+NULL/)
  assert.match(schema, /pending_review\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/)
  assert.match(schema, /idx_cmt_review_time/)
  assert.match(migration, /game_comments（游客评论待审核 \+ 可空作者）/)
  assert.match(migration, /ADD COLUMN `pending_review` TINYINT\(1\) NOT NULL DEFAULT 0/)
  assert.match(migration, /MODIFY `user_id` VARCHAR\(40\) NULL/)
})

check('API 类型和映射明确标记游客、待审核状态，不向前台公开待审核正文', () => {
  assert.match(types, /id: string \| null/)
  assert.match(types, /pendingReview: boolean/)
  assert.match(mapper, /const readable = admin \|\| \(!pendingReview && !hidden && !deleted\)/)
  assert.match(mapper, /nickname: r\.nickname \?\? ''/)
  assert.match(gameRepo, /pending_review = 0 AND hidden = 0 AND deleted_at IS NULL/)
})

console.log(`✅ 评论/留言回归：${passed} 项检查通过`)
