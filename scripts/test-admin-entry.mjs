/**
 * 「管理员用自己的账号进后台」这条路的回归测试。跑：npm run test:admin-entry
 *
 * ## 背景
 *
 * 服务端一直认两种凭据（`server/src/auth.js` 的 roleOfRequest）：
 *   1. 后台口令 `ADMIN_TOKEN` —— 不对应任何账号
 *   2. 登录用户自己的 `users.role`（admin / volunteer）
 *
 * 但前端第 2 条一直是断的：AdminLayout 一上来就要求 sessionStorage 里已经有口令，
 * 否则连问都不问就弹密钥框。**2026-09-12 关掉 ADMIN_AUTH_DISABLED 那个后门之后**
 * （在那之前所有人都是 admin，没人注意到），管理员账号就被自己的界面挡在了外面。
 *
 * ## 这套测试守什么
 *
 *   1. **前端一行授权都不做**。入口按钮按 isStaff 显示只是「别画一个点进去会 403 的按钮」，
 *      真正放行的只有 `/api/admin/verify`。gate 的初始值永远不能是 'unlocked'。
 *   2. **服务端那道闸不许松**：verify 仍然是 isStaff(roleOfRequest(req))。
 *   3. **ADMIN_AUTH_DISABLED 的「拒绝启动」闸必须还在**。进后台不方便的时候，
 *      最省事的坏主意就是把它关掉 —— 那正是让站点后台对全网敞开四天的那件事。
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

const profile = strip(read('src/pages/ProfilePage.tsx'))
const layout = strip(read('src/admin/AdminLayout.tsx'))
const auth = strip(read('server/src/auth.js'))
const adminRoutes = strip(read('server/src/routes/admin.js'))
const serverIndex = strip(read('server/src/index.js'))

console.log('\n── 个人页的后台入口 ──')

check('入口按 isStaff 显示，和服务端读同一张权限表', () => {
  assert.match(profile, /isStaff\(user\.role\)/, '没有按 isStaff 判断')
  assert.match(profile, /from '\.\.\/\.\.\/shared\/roles\.js'/, '没从 shared/roles.js 引进来')
})

check('⚠️ 不许自己手写角色比较（会和 ROLE_ABILITIES 漂开）', () => {
  const i = profile.indexOf('t.profile.adminPanel')
  assert.ok(i > 0, '找不到后台入口按钮')
  const around = profile.slice(Math.max(0, i - 400), i)
  assert.doesNotMatch(around, /role === 'admin'/, "入口的条件写成了 role === 'admin'，改用 isStaff")
})

check('入口是链接不是本地放行（点进去还要过服务端）', () => {
  assert.match(profile, /to="\/admin"/, '按钮没有指向 /admin')
})

console.log('\n── 后台外壳：授权只在服务端 ──')

check('有登录令牌时先去问服务端，而不是直接弹密钥框', () => {
  assert.match(layout, /return getToken\(\) \? 'checking' : 'locked'/, '没有「有令牌就先验一次」这条路')
})

check("⚠️ gate 的初始值永远不能是 'unlocked'（那等于前端自己发权限）", () => {
  const i = layout.indexOf("useState<GateState>(")
  assert.ok(i > 0, '找不到 gate 的初始化')
  const init = layout.slice(i, layout.indexOf('})', i))
  assert.doesNotMatch(init, /'unlocked'/, "初始化里出现了 'unlocked'")
})

check('验不过就退回锁定（403 / 401 都算）', () => {
  assert.match(layout, /\.catch\(\(\) => \{\s*if \(!cancelled\) lock\(\)/, 'verify 失败没有退回锁定')
})

check('⚠️ 前端不缓存服务端认下来的身份（缓存就等于自己给自己发权限）', () => {
  assert.doesNotMatch(layout, /localStorage\.setItem\([^)]*role/i, '把角色写进了 localStorage')
})

console.log('\n── 服务端的闸 ──')

check('/api/admin/verify 仍然按 isStaff(roleOfRequest) 判', () => {
  const i = adminRoutes.indexOf("adminRouter.get('/verify'")
  assert.ok(i > 0, '找不到 verify 路由')
  const body = adminRoutes.slice(i, i + 420)
  assert.match(body, /roleOfRequest\(req\)/, '没有再问一次服务端的角色')
  assert.match(body, /if \(!isStaff\(role\)\) return res\.status\(403\)/, '没有 403 的兜底')
})

check('roleOfRequest 仍然认「登录用户的 users.role」这条路', () => {
  assert.match(auth, /return isRole\(user\.role\) \? user\.role : null/, '账号这条路被改掉了')
  assert.match(auth, /user\.status !== 'banned'/, '封禁账号不再被当作未登录 —— 封了还能写后台')
})

check('⚠️ ADMIN_AUTH_DISABLED 的「拒绝启动」闸还在（别为了进后台方便把它关掉）', () => {
  assert.match(auth, /export function adminBackdoorFatal|adminBackdoorFatal/, 'auth.js 里没有这道闸了')
  assert.match(auth, /I_KNOW_ADMIN_AUTH_IS_DISABLED/, '逃生开关没了，说明整道闸被改过')
  assert.match(serverIndex, /adminBackdoorFatal/, '启动时不再调用这道闸 —— 后门开着也能起来了')
})

check('⚠️ 后门仍然是「后门」：它一旦开着就直接返回 admin，没有别的语义', () => {
  const i = auth.indexOf('export async function roleOfRequest')
  const body = auth.slice(i, i + 260)
  assert.match(body, /if \(ADMIN_AUTH_DISABLED\) return 'admin'/, 'roleOfRequest 的第一行变了')
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 后台入口：${pass} 条全过`)
