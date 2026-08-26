/**
 * 功能开关。
 *
 * 尚未开放的功能在这里统一关掉，相关 UI 会整块隐藏（代码仍然保留，
 * 想上线时把对应的值改成 true 即可，不用再去各个页面找）。
 */
export interface Features {
  /** 直播：首页直播区块、侧边栏「直播」入口、页脚 8BitGo TV */
  live: boolean
  /** G 币：顶栏余额、卡片角标、每日任务、详情页奖励卡、赢取 G 币筛选 */
  coins: boolean
}

export const FEATURES: Features = {
  live: false,
  coins: false,
}
