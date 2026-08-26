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
}

export const FEATURES: Features = {
  live: false,
  coins: false,
  cloudGame: true,
}
