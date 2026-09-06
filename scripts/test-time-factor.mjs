// 头条「时间因子」与「自动收录（js 提交）」的回归测试。跑：npm run test:timefactor
//
// 这两块都是纯文本层面的约束 —— 相关代码在浏览器侧（React + i18n），
// 在 node 里整体 import 代价太大，所以这里按源码文本盯住几条不能再退回去的规则。
//
// 背景（2026-09-06 修）：站长平台的字段解释表写的是
//   published_time = 内容发布时间 / updated_time = 内容更新时间
//   lrDate_time    = 内容**最新回复时间**
// 而代码原来把 lrDate_time 也填成了更新时间 —— 那是照着平台**示例**推断的，
// 示例里这两个恰好是同一个时间戳，于是被当成「两个字段一个意思」。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

const seo = read('src/services/seo.ts')
const indexHtml = read('index.html')
const autoInclude = read('src/services/autoInclude.ts')
const gamesRepo = read('server/src/games-repo.js')
const commentsRoute = read('server/src/routes/comments.js')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

check('三个时间因子标签都还在输出', () => {
  for (const tag of ['bytedance:published_time', 'bytedance:updated_time', 'bytedance:lrDate_time']) {
    assert.ok(seo.includes(tag), `${tag} 不见了`)
  }
})

check('lrDate_time 用的是回复时间，不是更新时间', () => {
  const line = seo.split('\n').find((l) => l.includes("'bytedance:lrDate_time'"))
  assert.ok(line, '找不到输出 lrDate_time 的那一行')
  assert.match(line, /\breplied\b/, 'lrDate_time 必须填最新回复时间')
  assert.doesNotMatch(line, /\bupdated\b/, 'lrDate_time 又被填成更新时间了 —— 见本文件开头')
  // 而 updated_time 必须还是更新时间
  const updatedLine = seo.split('\n').find((l) => l.includes("'bytedance:updated_time'"))
  assert.match(updatedLine ?? '', /\bupdated\b/)
})

check('没有回复时整条不输出，且客户端换页会把上一页的删掉', () => {
  assert.match(seo, /if \(replied\) metas\.push\(\['property', 'bytedance:lrDate_time'/)
  assert.match(seo, /if \(!replied\)[\s\S]{0,160}bytedance:lrDate_time[\s\S]{0,40}remove\(\)/)
})

check('最新回复时间的「可见」定义与前台评论列表一致', () => {
  const predicate = 'hidden = 0 AND deleted_at IS NULL'
  // 前台列表用了 c. 别名，去掉后两边必须是同一句
  assert.ok(commentsRoute.replace(/\bc\./g, '').includes(predicate), '前台评论列表的可见条件变了')
  assert.ok(gamesRepo.includes(predicate), 'getGameBySlug 取最新回复时间的可见条件对不上前台列表')
})

check('自动收录脚本仍在 index.html 的 head 里', () => {
  assert.match(indexHtml, /id = 'ttzz'/)
  assert.match(indexHtml, /goofy\/ttzz\/push\.js\?[0-9a-f]{64,}/)
})

check('补推逻辑不许把站点凭证抄第二份', () => {
  const token = /goofy\/ttzz\/push\.js\?([0-9a-f]{64,})/.exec(indexHtml)?.[1]
  assert.ok(token, 'index.html 里取不到 ttzz 的 token')
  assert.ok(!autoInclude.includes(token), 'autoInclude.ts 里硬编码了 token，必须从 DOM 上的 #ttzz 读')
  assert.match(autoInclude, /getElementById\('ttzz'\)\?\.getAttribute\('src'\)/)
})

check('补推只按 pathname 触发，且跳过没有收录价值的路径', () => {
  assert.match(autoInclude, /\[pathname\]\)/, '依赖数组里必须只有 pathname（查询串不推）')
  for (const seg of ['admin', 'embed', 'auth', 'login', 'me']) {
    assert.ok(new RegExp(`\\b${seg}\\b`).test(autoInclude.match(/const SKIP = .*/)?.[0] ?? ''), `SKIP 少了 ${seg}`)
  }
})

console.log(`✅ 时间因子 / 自动收录：${passed} 项检查通过`)
