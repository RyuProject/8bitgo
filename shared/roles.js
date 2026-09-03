/**
 * 用户角色与权限分级。
 *
 * 三级，前后端共用一份定义 —— 后台把按钮藏起来只是体面，真正说了算的是服务端，
 * 两边读同一张表才不会出现「界面上有这个按钮，点了 403」或者反过来的情况。
 *
 *   admin      管理员：全站，包括用户、角色、ROM 存储和数据导入
 *   volunteer  志愿者：内容协管 —— 游戏资料、文章、开发商、评论审核
 *   user       玩家：后台一概进不去（这是注册时的默认值）
 *
 * ── 为什么志愿者到「内容」为止 ──────────────────────────────
 * 志愿者是来帮忙整理游戏库和看评论的，不是来管人的。所以这条线画在
 * 「改的是内容，还是改的是人和站本身」：
 *
 *   能改内容     → 改错了看得见、也改得回来（游戏资料、文章、开发商、评论可见性）
 *   不能碰人和站 → 封号、删号、改别人的角色、ROM 存储、批量导入、数据导出，
 *                  这些要么不可逆，要么一步就能让全站出问题
 *
 * 想调整分工，改下面那张 ROLE_ABILITIES 就行 —— 服务端的 requireAbility 和
 * 后台的导航都从它读，不用再去各个路由里找。
 */

/** 全部角色，按权限从小到大 */
export const ROLES = ['user', 'volunteer', 'admin']

/** 后台里显示给人看的名字 */
export const ROLE_LABELS = {
  user: '玩家',
  volunteer: '志愿者',
  admin: '管理员',
}

/**
 * 权限点。名字按「对象:动作」写，加新的时候优先复用已有的对象名。
 *
 *   content:edit    游戏、文章、开发商的增删改
 *   comments:review 评论审核（改可见性、删评论）
 *   users:manage    用户列表、封禁 / 解封、删号
 *   users:role      改别人的角色
 *   site:manage     ROM 存储、平台 BIOS、批量导入、数据导出这类站级操作
 */
export const ABILITIES = ['content:edit', 'comments:review', 'users:manage', 'users:role', 'site:manage']

/** 角色 -> 权限点。admin 直接引用 ABILITIES，以后加权限点它自动跟着长 */
export const ROLE_ABILITIES = {
  user: [],
  volunteer: ['content:edit', 'comments:review'],
  admin: ABILITIES,
}

/** 这个角色有没有这个权限点。角色名不认识（老数据、脏数据）一律当作没有 */
export function can(role, ability) {
  const list = ROLE_ABILITIES[role]
  return Array.isArray(list) && list.includes(ability)
}

/** 进不进得了后台 —— 有任意一个权限点就进得去，进去之后再按权限收窄导航 */
export function isStaff(role) {
  const list = ROLE_ABILITIES[role]
  return Array.isArray(list) && list.length > 0
}

/** 是不是一个合法的角色名。用来校验接口传进来的值 */
export function isRole(value) {
  return typeof value === 'string' && ROLES.includes(value)
}
