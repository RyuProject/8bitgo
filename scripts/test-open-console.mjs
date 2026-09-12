/**
 * 开发者控制台 `/open` 上「回调地址」那一节的回归测试。跑：npm run test:open-console
 *
 * ## 这条测试是被一个真实的死胡同逼出来的（2026-09-12）
 *
 * 后端从第一天就收 `redirectUris`（创建和 PATCH 都收，校验在 open-apps.js 的 cleanList），
 * 提交审核时也会拦：申请了用户级 scope（library.* / saves.* / openid…）而没登记回调地址，
 * review.js 回一句「申请登录类权限必须先登记回调地址」。
 *
 * 但**控制台上根本没有这个字段**。于是申请人看到一句「必须先登记」，然后在界面上遍寻不着 ——
 * 一个指向不存在的东西的错误提示，比没有提示更糟。
 *
 * 所以这里守两件事：
 *   1. 控制台上**确实有**能登记回调地址的地方，而且真的发 PATCH；
 *   2. 「要不要回调地址」这个判断**只有服务端一份**（appForOwner 的 needsRedirect），
 *      前端不许自己抄一份 scope 分类表 —— 抄了就会漂，漂的后果是
 *      「界面说不用填、提交时说必须填」这种最难查的自相矛盾。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

let pass = 0
const fails = []
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}

const page = strip(read('src/pages/OpenPlatformPage.tsx'))
const repo = strip(read('server/src/open/apps-repo.js'))
const review = strip(read('server/src/open/review.js'))
const routes = strip(read('server/src/routes/open-apps.js'))

/** RedirectUris 组件的函数体 */
const uiBody = (() => {
  const i = page.indexOf('function RedirectUris')
  if (i < 0) return ''
  const j = page.indexOf('\nfunction ', i + 10)
  return page.slice(i, j === -1 ? page.length : j)
})()

console.log('\n── 控制台上真的能登记 ──')

check('⚠️ 有回调地址这一节（以前完全没有，错误提示指向一个不存在的字段）', () => {
  assert.ok(uiBody, '找不到 RedirectUris 组件')
  assert.match(page, /<RedirectUris\b/, '组件没有被用起来')
})

check('保存时真的发 PATCH，而不是只改本地状态', () => {
  assert.match(page, /patchMyApp\(app\.id, \{ redirectUris: uris \}\)/, '没有把 redirectUris PATCH 回服务端')
})

check('⚠️ 地址原样提交，不做任何规整（精确匹配就是拿这个串去比的）', () => {
  assert.doesNotMatch(uiBody, /\.toLowerCase\(\)/, '把回调地址小写化了 —— 线上会 redirect_uri_mismatch')
  assert.doesNotMatch(uiBody, /replace\(\/\\\/\$\//, '动了末尾斜杠')
  assert.match(uiBody, /text\.split\(\/\\s\+\/\)\.filter\(Boolean\)/, '拆分方式变了，确认没有顺手「修」地址')
})

check('审核中不让改（否则「审的是 A、批的是 B」）', () => {
  assert.match(uiBody, /app\.reviewState === 'pending'/, '审核中没有锁住')
})

console.log('\n── 判断只有服务端一份 ──')

check('appForOwner 把 needsRedirect 算好给前端', () => {
  assert.match(repo, /needsRedirect: needsRedirectUri\(app\.requested_scopes\)/, 'appForOwner 没有这个字段')
})

check('⚠️ 和提交审核用的是同一个判定函数', () => {
  assert.match(review, /export function needsRedirectUri/, 'review.js 不再导出这个判定')
  assert.match(review, /OPEN_SCOPES\[s\]\?\.kind === 'user'/, '用户级 scope 的判定变了')
  const i = review.indexOf('const needsRedirect = scopes.some')
  assert.ok(i > 0, '提交审核那条路不再判回调地址了')
})

check('⚠️ 前端不自己抄 scope 分类（只读服务端给的 needsRedirect）', () => {
  assert.match(page, /app\.needsRedirect/, '界面没用服务端算好的那个字段')
  assert.doesNotMatch(uiBody, /kind === 'user'/, '控制台自己抄了一份 scope 分类表')
  assert.doesNotMatch(uiBody, /\['library\.|includes\('saves\./, '控制台自己硬编码了 scope 名单')
})

check('提交审核那条闸还在（没有回调地址就打回）', () => {
  assert.match(review, /return no\('no_redirect'/, 'no_redirect 这条被拿掉了')
})

check('服务端仍然校验回调地址（https / 不带 # / 条数上限）', () => {
  assert.match(routes, /if \(u\.hash\) return \{ error/, '不再拒绝带 # 的地址')
  assert.match(routes, /必须是 https（沙箱可以用 http:\/\/localhost）/, 'https 那道闸变了')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 开放平台控制台：${pass} 条全过`)
