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

console.log('通过 %d 项：\n  %s', ok.length, ok.join('\n  '))
if (bad.length) {
  console.log('\n失败 %d 项：\n  %s', bad.length, bad.join('\n  '))
  process.exit(1)
}
console.log('\n全部通过')
