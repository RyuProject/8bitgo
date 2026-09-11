/**
 * 站内头像的**唯一事实来源**：一张 emoji 白名单，外加一条写入校验。
 *
 * 放在 shared/ 是因为前端的选择器和服务端的校验必须是同一张表 ——
 * 各写一份的结果是「界面上能选、存进去被拒」或者反过来（更糟）「界面上没有的值也存得进去」。
 *
 * ## 为什么必须校验，而且必须是白名单
 *
 * 2026-09-10 查出来的问题：`PATCH /api/me` 原来是 `if (req.body.avatar) patch.avatar = String(...)`，
 * **一个字都不校验**。于是任何登录用户都能把自己的头像设成一段任意文本，包括一个 URL。
 * 后果不是「界面难看」：
 *
 *   1. **信标（最要紧的一条）**。站内消息的头像组件原来会把 `http(s)://` 开头的值渲染成
 *      `<img src>`。攻击者把头像设成 `http://x.gd/abcd`（16 个字符，正好塞进 VARCHAR(16)），
 *      再给谁发一条私信 —— 对方一打开消息面板，浏览器就去请求那个地址：
 *      攻击者拿到对方的 **IP、UA、以及「他在这一刻读了我的消息」**。
 *      渲染那一侧已经改成纯文本（见 components/im/ImPanel.tsx 的 Avatar），
 *      这里是把源头一起堵上 —— 那个字段还会被推给腾讯（updateMyProfile），
 *      而腾讯那份数据我们**永远校验不到**。
 *   2. **users.avatar 是 VARCHAR(16)**。超长的值在 MySQL 严格模式下直接报错，
 *      于是「改个昵称」这件事会以一个 500 收场；非严格模式下被静默截断成半个字符。
 *   3. 昵称有 2–16 的长度校验，头像一条都没有 —— 同一个接口里的两个字段不该有两套标准。
 *
 * 白名单而不是「形状校验」：本站的头像**只有**选择器里这 12 个（注册时一律 🕹️，
 * 没有任何别的写入路径），所以能选的就是全部合法值。形状校验（比如「不含 ASCII」）
 * 还要去想 emoji 的组合字、变体选择符、ZWJ 序列，而白名单一行就说完了。
 *
 * ⚠️ 往这张表里加 emoji 时记得：`users.avatar` 是 **VARCHAR(16)**，按字符算，
 * 一个带变体选择符的 emoji 占 2 个（🕹️ = U+1F579 U+FE0F）。AVATAR_MAX_POINTS 守着这一条。
 */

/** 头像选择器里的全部选项。顺序就是界面上的顺序 */
export const AVATARS = ['🕹️', '👾', '🎮', '🍄', '⭐', '🐉', '🦔', '🤖', '👻', '🐱', '🔥', '💎']

/** 注册时给的默认头像，也是所有兜底位置用的那一个 */
export const AVATAR_DEFAULT = '🕹️'

/** 单个头像最多几个码点。users.avatar 是 VARCHAR(16)，留一半余量 */
export const AVATAR_MAX_POINTS = 8

/** 这个值能不能存进 users.avatar */
export function isAllowedAvatar(raw) {
  const s = typeof raw === 'string' ? raw : ''
  if (Array.from(s).length > AVATAR_MAX_POINTS) return false
  return AVATARS.includes(s)
}

/**
 * 规范化一个头像值：合法就原样返回，**不合法一律返回空串**（调用方只需判空）。
 *
 * 只 trim，不做别的修补 —— 「把不合法的值改成一个像是合法的值」是最坏的一种宽容：
 * 用户以为存上了，实际存的是别的东西。
 */
export function normalizeAvatar(raw) {
  const s = String(raw ?? '').trim()
  return isAllowedAvatar(s) ? s : ''
}

/** 显示用兜底：空的 / 库里是历史遗留值时给默认头像，绝不返回空 */
export function avatarForShow(raw) {
  const s = String(raw ?? '').trim()
  return s || AVATAR_DEFAULT
}
