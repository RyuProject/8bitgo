#!/usr/bin/env node
/**
 * 头像的白名单与渲染。跑：npm run test:avatar
 *
 * ## 这份测试守的是一个信标漏洞（2026-09-10）
 *
 * `PATCH /api/me` 原来是 `if (req.body.avatar) patch.avatar = String(req.body.avatar)` ——
 * 一个字都不校验（同一个接口里昵称有 2–16 的长度校验）。而站内消息的头像组件会把
 * `http(s)://` 开头的值渲染成 `<img src>`。连起来就是：
 *
 *   攻击者把头像设成 `http://x.gd/abcd`（16 字符，正好塞进 users.avatar VARCHAR(16)）
 *   → 给谁发一条私信 → 对方**一打开消息面板**，浏览器就去请求那个地址
 *   → 攻击者拿到对方的 IP、UA，以及「他在这一刻读了我的消息」。
 *
 * 零交互的已读回执 + IP 探针。两头都要堵，缺一头都不算修好：
 *   · **源头**：服务端白名单（这个字段还会被推给腾讯 IM，那份数据我们永远校验不到）；
 *   · **渲染**：只当文字画。腾讯的 userProfile.avatar 是对方浏览器写的，我们管不了。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AVATARS, AVATAR_DEFAULT, avatarForShow, isAllowedAvatar, normalizeAvatar } from '../shared/avatar.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/* ---------------- 一、白名单本身 ---------------- */

check('⚠️ URL 一律不合法（这是整条漏洞的入口）', () => {
  for (const bad of [
    'http://x.gd/abcd',       // 16 字符，塞得进 VARCHAR(16)
    'https://t.co/a',
    '//evil.example/p.gif',
    'HTTP://X.GD/ABCD',
    'javascript:alert(1)',
    'data:image/gif;base64,R0lGOD',
    '//a.co/x', // 8 个码点：短到长度上限管不着，只能靠白名单拦
  ]) {
    assert.equal(normalizeAvatar(bad), '', `${bad} 竟然通过了`)
    assert.equal(isAllowedAvatar(bad), false)
  }
})

check('选择器里那 12 个都合法，前后去空格', () => {
  for (const a of AVATARS) assert.equal(normalizeAvatar(a), a)
  assert.equal(normalizeAvatar('  👾  '), '👾')
})

check('⚠️ 不在名单里的一律不收，哪怕它只是个 emoji', () => {
  // 名单之外的 emoji 本身无害，但「白名单」一旦变成「看着像 emoji 就行」，
  // 就得去想组合字、变体选择符、ZWJ 序列，那条路没有尽头
  assert.equal(normalizeAvatar('😀'), '')
  assert.equal(normalizeAvatar(''), '')
  assert.equal(normalizeAvatar(null), '')
  assert.equal(normalizeAvatar('a'), '')
})

check('⚠️ 每一个都塞得进 users.avatar（VARCHAR(16)，按字符算）', () => {
  for (const a of AVATARS) {
    const points = Array.from(a).length
    // 🕹️ = U+1F579 U+FE0F，两个码点；UTF-16 长度才是 MySQL 数的那个
    assert.ok(a.length <= 16, `${a} 的 UTF-16 长度是 ${a.length}，会被列截断`)
    assert.ok(points <= 8, `${a} 有 ${points} 个码点，超过 AVATAR_MAX_POINTS`)
  }
})

check('显示兜底：空值给默认头像，绝不返回空', () => {
  assert.equal(avatarForShow(''), AVATAR_DEFAULT)
  assert.equal(avatarForShow(null), AVATAR_DEFAULT)
  // 库里的历史遗留值照显示 —— 显示不是写入，这里不该把人家的头像换掉
  assert.equal(avatarForShow('😀'), '😀')
})

/* ---------------- 二、源头：服务端必须校验 ---------------- */

check('⚠️ PATCH /api/me 的头像要过白名单', () => {
  const src = code('server/src/routes/me.js')
  assert.match(src, /normalizeAvatar/, '没有校验 —— 任何登录用户都能把头像设成任意文本')
  assert.ok(
    !/patch\.avatar = String\(req\.body\.avatar\)/.test(src),
    '还在原样收下请求里的头像',
  )
  assert.match(src, /status\(400\)/, '不合法要拒绝，不能悄悄改成别的值')
})

check('⚠️ 前后端共用同一张表（各写一份就会「界面上能选、存进去被拒」）', () => {
  const profile = read('src/pages/ProfilePage.tsx')
  assert.match(profile, /from '\.\.\/\.\.\/shared\/avatar\.js'/, '选择器要用 shared 那份')
  assert.ok(
    !/const AVATARS = \[/.test(profile),
    'ProfilePage 里又抄了一份头像表',
  )
  // 库里可能有历史遗留值：填进编辑态之前先过一次白名单，
  // 否则用户「只改昵称」也会被整条 400 拒掉，而原因在他没动过的字段上
  assert.match(profile, /setAvatar\(normalizeAvatar\(user\.avatar\) \|\| AVATARS\[0\]\)/)
})

/* ---------------- 三、渲染：只当文字画 ---------------- */

check('⚠️ 站内消息的头像绝不能渲染成图片', () => {
  const src = code('src/components/im/ImPanel.tsx')
  assert.ok(
    !/<img/.test(src),
    '又出现了 <img> —— 对方控制的 URL 会变成一枚 IP + 已读信标（见文件头）',
  )
  assert.ok(
    !/https\?:\\\/\\\//.test(src) && !/\^https\?:/.test(src),
    '还留着「是不是 URL」的判断 —— 那是那条 <img> 分支的残骸',
  )
  assert.match(src, /avatarForShow/, '头像要走统一的显示兜底')
})

check('⚠️ 腾讯给的昵称 / 头像要先清洗再显示（那份我们校验不到）', () => {
  const src = code('src/services/imClient.ts')
  assert.match(src, /function cleanPeerText/, '缺少对方显示名的清洗')
  // 会话列表里的两处：昵称和头像都来自腾讯的 userProfile
  assert.match(src, /nick: cleanPeerText\(c\.userProfile\?\.nick\)/)
  assert.match(src, /avatar: cleanPeerText\(c\.userProfile\?\.avatar/)
  // 顶栏预览那条兜底也是腾讯给的
  assert.match(src, /cleanPeerText\(last\.nick\)/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
