/**
 * 友情链接输入与建表文件的轻量自检。不连数据库：校验协议白名单、88×31 图片字段
 * 的两种形状，以及新旧部署路径都确实带上了 friend_links 表。
 *
 * 用法：cd server && npm run test:friend-links
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateFriendLinkPayload } from '../src/routes/friend-links.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`✅ ${name}`)
}

check('文字友链允许空图片，并默认启用', () => {
  const result = validateFriendLinkPayload({ name: 'Ruffle', url: 'https://ruffle.rs', image: '', sortOrder: 10 })
  assert.deepEqual(result.value, { name: 'Ruffle', url: 'https://ruffle.rs', image: '', sortOrder: 10, enabled: true })
})

check('图片友链允许 R2 key、站内路径和 https URL', () => {
  for (const image of ['friend-links/ruffle.gif', '/images/ruffle.png', 'https://cdn.example.com/ruffle.webp']) {
    const result = validateFriendLinkPayload({ name: 'Ruffle', url: 'http://ruffle.rs', image, sortOrder: 0, enabled: false })
    assert.equal(result.value?.image, image)
    assert.equal(result.value?.enabled, false)
  }
})

check('链接拒绝 javascript 等危险协议', () => {
  assert.match(validateFriendLinkPayload({ name: 'x', url: 'javascript:alert(1)' }).error, /http/)
  assert.match(validateFriendLinkPayload({ name: 'x', url: 'https://example.com', image: 'data:image/svg+xml,x' }).error, /图片/)
})

check('排序号必须落在 SMALLINT UNSIGNED 范围内', () => {
  assert.match(validateFriendLinkPayload({ name: 'x', url: 'https://example.com', sortOrder: -1 }).error, /排序/)
  assert.match(validateFriendLinkPayload({ name: 'x', url: 'https://example.com', sortOrder: 65536 }).error, /排序/)
  assert.match(validateFriendLinkPayload({ name: 'x', url: 'https://example.com', sortOrder: 1.5 }).error, /排序/)
})

check('启用状态只接受 JSON 布尔值', () => {
  assert.match(validateFriendLinkPayload({ name: 'x', url: 'https://example.com', enabled: 'false' }).error, /布尔/)
})

check('三条 MySQL 建表路径和 D1 结构都包含 friend_links', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  for (const name of ['schema-v2.sql', '8bitgo-v2-install.sql', 'schema-d1.sql', 'scripts/migrate.mjs']) {
    const text = readFileSync(`${root}/${name}`, 'utf8')
    assert.match(text, /friend_links/, name)
  }
})

console.log(`\n全部通过（${passed} 组）`)
