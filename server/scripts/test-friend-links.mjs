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
import { hostOf, normalizeHost } from '../src/friend-link-hits.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 读源码并**先剥掉注释** —— 否则「注释里提到了」会被当成「代码里做了」 */
const src = (rel) => readFileSync(`${ROOT}/${rel}`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const webSrc = (rel) => readFileSync(`${ROOT}/../${rel}`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

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


/* ---------------- 双向埋点（2026-09-11） ---------------- */

check('⚠️ 域名归一：www. 必须去掉，否则对方带来的人一个都记不上', () => {
  /*
    友链填的是 https://example.com/，而访客往往是从 https://www.example.com/links.html 点来的。
    不归一的话这一条永远匹配不上 —— 而且表现成「对方没给我们带人」，
    是个会直接导致错误决策的静默失败。
  */
  assert.equal(normalizeHost('www.example.com'), 'example.com')
  assert.equal(normalizeHost('Example.COM:8443'), 'example.com')
  assert.equal(hostOf('https://www.example.com/links.html?a=1#x'), 'example.com')
  assert.equal(hostOf('http://example.com'), 'example.com')
})

check('拿不出域名时返回空串，不抛', () => {
  for (const bad of ['', 'not a url', 'javascript:alert(1)', null, undefined, 'about:blank']) {
    assert.equal(typeof hostOf(bad), 'string', String(bad))
  }
  assert.equal(hostOf('not a url'), '')
})

check('⚠️ 鸣谢位的链接是 noopener 不是 noreferrer', () => {
  /*
    noreferrer 会把 Referer 一起抹掉，对方的统计里我们带过去的人显示成「直接访问」——
    他永远看不到 8bitgo 给他带了多少量，互换友链时我们也拿不出凭据。
    noopener 同样防 window.opener 劫持，但保留来源域名。
  */
  const text = webSrc('src/components/home/sections.tsx')
  const at = text.indexOf('FriendLinkButton')
  assert.ok(at > 0, '找不到 FriendLinkButton')
  const seg = text.slice(at, at + 1200)
  assert.match(seg, /rel="noopener"/, '不是 noopener')
  assert.ok(!/rel="noreferrer"/.test(seg), '还挂着 noreferrer，对方看不到我们带去的流量')
})

check('⚠️ 出站上报走 sendBeacon，不是 fetch', () => {
  /*
    点击的下一件事就是导航离开，浏览器会把还在飞的 fetch 掐掉 ——
    那样统计到的只是「点了但没跳走」的那部分人，而且失败得毫无声息。
  */
  const text = webSrc('src/services/friendLinks.ts')
  assert.match(text, /navigator\.sendBeacon\?\./, '没用 sendBeacon')
  const at = text.indexOf('reportFriendLinkClick')
  assert.ok(!/fetch\(/.test(text.slice(at)), '上报里混进了 fetch')
})

check('⚠️ 出站上报接口是公开的，且挡爬虫 + 限流 + 一律 204', () => {
  const text = src('src/routes/friend-links.js')
  const at = text.indexOf("friendLinksRouter.post('/:id/click'")
  assert.ok(at > 0, '找不到 click 路由')
  // ⚠️ 切到**下一条路由**为止，不能用固定长度：第一版取了 900 字符，
  // 尾巴伸进了下面那条带 requireAbility 的后台路由，断言当场误报
  const end = text.indexOf('friendLinksRouter.', at + 10)
  const seg = text.slice(at, end > at ? end : at + 900)
  assert.ok(!seg.includes('requireAbility'), '点友链的绝大多数是游客，不能要登录')
  assert.match(seg, /isCrawlerUa/, '没挡爬虫 —— 爬虫会把页面上每条链接都「点」一遍')
  assert.match(seg, /take\(/, '没限流 —— 一行 curl 循环就能把某条友链刷成第一')
  assert.match(seg, /res\.status\(204\)/, 'sendBeacon 不读响应体，应当一律 204')
})

check('⚠️⚠️ 入站统计必须先 next() 再写库，不能反过来', () => {
  /*
    这段挂在 SSR 兜底之前，是首屏渲染的必经之路。先 await 再 next()
    等于把一次写库挂在用户等首字节的那条线上 —— 而且**看不出来**：
    页面照常出，只是每个人都慢那么几毫秒到几十毫秒。
  */
  const text = src('src/index.js')
  // ⚠️ 不能找 friendLinkHostMap：那个名字**第一次出现是在文件顶上的 import 里**，
  // 第一版就是这么写的，于是锚点落在第 1 行、往前找 app.get( 什么也找不到
  const at = text.indexOf('recordFriendLinkHit(id, IN')
  assert.ok(at > 0, '找不到入站统计')
  const start = text.lastIndexOf('app.get(', at)
  const seg = text.slice(start, at)
  const nextAt = seg.indexOf('next()')
  const awaitAt = seg.indexOf('await')
  assert.ok(nextAt > 0, '没调用 next()')
  assert.ok(awaitAt === -1 || nextAt < awaitAt, 'next() 排在 await 后面了，首屏会被统计拖慢')
})

check('⚠️ 入站统计排除站内跳转', () => {
  // 站内每一次前进都带着自己的域名当 Referer，不排除的话数字会离谱地虚高
  const text = src('src/index.js')
  assert.match(text, /normalizeHost\(req\.hostname\)/, '没有排除站内来源')
})

check('后台列表把「最近多少天」一起给出来', () => {
  // 光给一个数字，看的人无从判断它是今天的还是开站以来的 —— 那种数字比没有更糟
  assert.match(src('src/routes/friend-links.js'), /statsDays/, '后端没给')
  assert.match(webSrc('src/admin/AdminFriendLinks.tsx'), /statsDays/, '后台没显示')
})

check('⚠️ 前端两种响应形状都认（前后端不是同时部署的）', () => {
  // 这个仓库踩过：前端是当天的、后端还是两天前的。只认新形状的话友链后台会空着且不报错
  assert.match(webSrc('src/services/friendLinks.ts'), /Array\.isArray\(result\)/, '旧的数组形状不认了')
})

check('埋点表进了所有部署路径', () => {
  for (const name of ['schema-v2.sql', '8bitgo-v2-install.sql', 'schema-d1.sql', 'scripts/migrate.mjs']) {
    assert.match(readFileSync(`${ROOT}/${name}`, 'utf8'), /friend_link_hits/, name)
  }
})

console.log(`\n全部通过（${passed} 组）`)
