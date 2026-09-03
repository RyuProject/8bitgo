/**
 * 功能开关。
 *
 * 尚未开放的功能在这里统一关掉，相关 UI 会整块隐藏（代码仍然保留，
 * 想上线时把对应的值改成 true 即可，不用再去各个页面找）。
 */
export interface Features {
  /** 直播：首页直播区块、侧边栏「直播」入口、页脚 8BitGo TV */
  live: boolean
  /** G 币：顶栏余额、卡片角标、每日任务、详情页奖励卡、赢取 G 币筛选、个人页余额 */
  coins: boolean
  /**
   * 云端联机（cloud-game）：游戏跑在服务器上，每个房间占一个 CPU 核。
   * 默认关闭 —— 联机走 P2P（房主浏览器直推，零服务器成本）。
   * 这条通道留给付费会员：接入会员判断后，把这里改成按用户等级返回。
   */
  cloudGame: boolean
  /**
   * 密码登录：登录弹窗的「密码登录」那一栏、个人中心的「登录密码」面板。
   *
   * 关掉时只留验证码登录。服务端的密码接口照常在（已经设过密码的人不会被锁在门外），
   * 关的只是入口 —— 想重新开放把这里改成 true 即可。
   *
   * 两处必须一起关：只关登录弹窗的话，个人中心还能设密码，设完却没有任何地方能用，
   * 那个设置项本身就成了坑。
   */
  passwordLogin: boolean
  /**
   * 游戏评论：详情页侧栏的评论区、后台的「评论」那一页。
   *
   * 关掉时前台整块不渲染，接口仍然在（已有的评论不会丢）。
   * 想上线把这里改成 true —— 前提是后端跑过 npm run migrate 建出 game_comments 表。
   */
  comments: boolean
}

export const FEATURES: Features = {
  // 直播 = P2P 房间的观众席：房主的画面和声音本来就在往房间里推，
  // 「直播」入口就是这些房间按在看人数排的列表，没有额外成本。
  live: true,
  coins: false,
  cloudGame: true,
  passwordLogin: false,
  comments: true,
}
