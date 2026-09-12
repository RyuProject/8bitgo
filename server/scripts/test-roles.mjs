/**
 * 权限分级的自检。不连数据库、不起服务，只查三件容易悄悄坏掉的事：
 *
 *  1. 权限表本身对不对（志愿者到底能不能碰用户）；
 *  2. 各路由里写的权限点名字都是**存在的** —— `requireAbility('content:edt')`
 *     这种拼错不会报错，只会让所有人都被拒，看起来还像是「权限配错了」；
 *  3. 数据库里的 ENUM 和 shared/roles.js 的 ROLES 是同一套值 ——
 *     代码里加了角色而库里没加，写进去直接是一条 SQL 错误。
 *
 * 用法：cd server && npm run test:roles
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ABILITIES, ROLES, ROLE_ABILITIES, can, isRole, isStaff } from '../../shared/roles.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const ok = []
const bad = []
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' — ' + extra : ''}`)

// ---------- 1. 权限表 ----------
check('角色顺序是 user < volunteer < admin', ROLES.join(',') === 'user,volunteer,admin', ROLES.join(','))
check('玩家没有任何权限', ROLE_ABILITIES.user.length === 0)
check('玩家进不了后台', isStaff('user') === false)
check('志愿者能改内容', can('volunteer', 'content:edit'))
check('志愿者能审评论', can('volunteer', 'comments:review'))
check('志愿者不能管用户', can('volunteer', 'users:manage') === false)
check('志愿者不能发权限', can('volunteer', 'users:role') === false)
check('志愿者不能碰站级操作', can('volunteer', 'site:manage') === false)
/*
  ⚠️ 发 key 这件事的权限线要比「改内容」硬：批一个应用上产 = 把站外的一把 key
  放进生产环境。改错内容看得见也改得回来，发出去的 key 收不回来。
*/
check('志愿者不能审开放平台的应用', can('volunteer', 'apps:review') === false)
check('管理员能审开放平台的应用', can('admin', 'apps:review'))

/*
  ⚠️ 手写的 shared/roles.d.ts 会和 roles.js 漂开。
  2026-09-11 实测发现它少了 collections:review（早就加进 ABILITIES 了）——
  症状是前端引用那个权限点时 TS 报「不可赋值」，于是有人会顺手写个 as 断言绕过去，
  而那一刀下去整张权限表在前端就不再受类型保护了。
*/
{
  const dts = readFileSync(join(root, '../shared/roles.d.ts'), 'utf8')
  const missing = ABILITIES.filter((a) => !dts.includes(`'${a}'`))
  check('roles.d.ts 的 Ability 联合类型和 ABILITIES 一致', missing.length === 0, missing.join(' '))
}
check('志愿者进得了后台', isStaff('volunteer'))
check('管理员是全集', ABILITIES.every((a) => can('admin', a)))
check('认不出的角色一律没权限', !can('root', 'content:edit') && !can(undefined, 'content:edit') && !isStaff(null))
check('isRole 挡得住脏值', isRole('admin') && !isRole('Admin') && !isRole('') && !isRole(null) && !isRole(0))

// ---------- 2. 路由里引用的权限点都存在 ----------
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (e.name.endsWith('.js')) out.push(full)
  }
  return out
}
const used = new Map() // ability -> [文件]
for (const file of walk(join(root, 'src'))) {
  const code = readFileSync(file, 'utf8')
  for (const m of code.matchAll(/(?:requireAbility\(|hasAbility\(\s*\w+\s*,\s*)'([^']+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], [])
    used.get(m[1]).push(file.slice(root.length))
  }
}
check('路由里确实用上了权限点', used.size > 0, `找到 ${used.size} 个`)
for (const [ability, files] of used) {
  check(`权限点 '${ability}' 是存在的`, ABILITIES.includes(ability), files.join(', '))
}

// ---------- 3. 数据库 ENUM 与 ROLES 对得上 ----------
const wanted = ROLES.map((r) => `'${r}'`).join(',')
for (const f of ['schema.sql', 'schema-v2.sql', '8bitgo-v2-install.sql', '8bitgo-setup.sql', '8bitgo-setup-empty.sql']) {
  const m = readFileSync(join(root, f), 'utf8').match(/role\s+ENUM\(([^)]*)\)/i)
  check(`${f} 的 role ENUM 和 ROLES 一致`, Boolean(m) && m[1].replace(/\s/g, '') === wanted, m ? m[1] : '没找到 role ENUM')
}
const d1 = readFileSync(join(root, 'schema-d1.sql'), 'utf8').match(/CHECK\s*\(role\s+IN\s*\(([^)]*)\)/i)
check('schema-d1.sql 的 CHECK 和 ROLES 一致', Boolean(d1) && d1[1].replace(/\s/g, '') === wanted, d1 ? d1[1] : '没找到')
const mig = readFileSync(join(root, 'scripts/migrate.mjs'), 'utf8').match(/MODIFY\s+`role`\s+ENUM\(([^)]*)\)/i)
check('migrate.mjs 的 ALTER 和 ROLES 一致', Boolean(mig) && mig[1].replace(/\s/g, '') === wanted, mig ? mig[1] : '没找到')

// ---------- 4. 鉴权失败时要说真正的原因 ----------
/*
  ⚠️ 这一节是一次真实排查逼出来的（2026-09-12）。

  后台有两种入场方式：管理员账号，和一个不对应任何账号的后台口令（ADMIN_TOKEN）。
  前端取值时**后台口令优先**，于是一个填错 / 过期 / 服务端换过的口令会把一个完全正常的
  管理员登录态整个盖掉 —— 而报出来的是「权限不足：需要 content:edit」。
  排查的人于是去查角色、查 ROLE_ABILITIES、查数据库，而真正的问题在口令上。

  只读接口多半是公开的，所以症状还特别偏：后台看得见、一点保存就没权限。

  bearerKind 不碰数据库，所以这里是**真的跑**，不是扫源码。
*/
process.env.ADMIN_TOKEN = 'the-back-door'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-roles'
const { bearerKind } = await import('../src/auth.js')
const jwtMod = await import('jsonwebtoken')
const sign = (payload) => jwtMod.default.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256' })
const withAuth = (v) => ({ headers: v ? { authorization: v } : {} })

check('没带 Authorization → none', bearerKind(withAuth('')) === 'none')
check('带对了后台口令 → admin-token', bearerKind(withAuth('Bearer the-back-door')) === 'admin-token')
check('带了合法的站内令牌 → session', bearerKind(withAuth('Bearer ' + sign({ uid: 1 }))) === 'session')
check(
  '⭐ 带了一串既不是令牌也不是口令的东西 → invalid（这正是填错后台口令时的样子）',
  bearerKind(withAuth('Bearer wrong-back-door')) === 'invalid',
  bearerKind(withAuth('Bearer wrong-back-door')),
)
check(
  '⚠️ 开放平台的令牌不算站内会话（带 aud / scope / cid 的一律拒）',
  bearerKind(withAuth('Bearer ' + sign({ uid: 1, aud: 'x', scope: 'y', cid: 'z' }))) === 'invalid',
)

const authSrc = readFileSync(join(root, 'src/auth.js'), 'utf8')
check(
  '⭐ requireAbility 先问 authFailure，再报「权限不足」',
  authSrc.includes('const why = authFailure(req, role)') && authSrc.includes('if (why) return res.status(403).json(why)'),
)
check(
  '⭐ 口令坏掉时回的是机器可读的 invalid_admin_token（前端靠它自愈）',
  authSrc.includes("code: 'invalid_admin_token'"),
)
check('登录令牌失效时说「登录已失效」，不说「权限不足」', authSrc.includes("code: 'session_expired'"))

// ---------- 5. 前端：坏口令要能自愈 ----------
/*
  服务端说清楚了还不够：那个口令存在 sessionStorage 里，不清掉的话**后面每一次写操作
  都会继续被它盖住**。所以前端收到 invalid_admin_token 要清掉它、改用登录令牌重试一次。
*/
const apiSrc = readFileSync(join(root, '../src/services/api.ts'), 'utf8')
check(
  '⭐ 收到 invalid_admin_token 会清掉口令并重试',
  apiSrc.includes('setAdminApiToken(null)') && apiSrc.includes('return request<T>(method, path, { body, admin }, true)'),
)
check(
  '⚠️ 只重试这一种 code —— 别放宽（403 才保证服务端什么都没做，重试 PUT 不会写两遍）',
  apiSrc.includes("code === 'invalid_admin_token'"),
)
// ⚠️ 必须钉在**重试条件那一整串**上：authHeaders 里也有一个 !skipAdminToken，
// 全文搜关键字的话，把重试条件里的挡板删掉这条照样绿（变异测试抓出来的）。
check(
  '⚠️ 只重试一次（skipAdminToken 挡住第二轮）',
  apiSrc.includes("code === 'invalid_admin_token' && !skipAdminToken"),
)
check('⚠️ 没有登录令牌可退回时就不重试（否则等于白跑一趟）', apiSrc.includes('&& getToken()'))
// authHeaders 的取值优先级本身也要钉住：变异测试发现把它改成「永远不用后台口令」
// 时，上面那些断言一条都没红 —— 那样没有账号的人就再也进不了后台了。
check(
  '⚠️ 后台口令优先于登录令牌（口令是给没有账号的人留的）',
  apiSrc.includes('admin && !skipAdminToken ? getAdminApiToken() || getToken() : getToken()'),
)

console.log('通过 %d 项：\n  %s', ok.length, ok.join('\n  '))
if (bad.length) {
  console.log('\n失败 %d 项：\n  %s', bad.length, bad.join('\n  '))
  process.exit(1)
}
console.log('\n全部通过')
