/**
 * 「这个人算不算玩了这款游戏」。
 *
 * 站上有两处要回答它，判据不同、结论必须一致：
 *   · 详情页：一进页面就往侧边栏的「曾经玩过」里记一笔（services/auth 的 recordRecent），
 *     那时候还没有会话，只有 URL。
 *   · 播放器：引擎报 onReady 时上报一次游玩次数（services/store 的 recordPlay），
 *     那时候有会话。
 *
 * ## 规矩：看别人玩不算玩
 *
 * 直播间的观众**一帧都没跑过** —— 画面是主播推过来的视频流，本机既没有 ROM
 * 也没有引擎。可 liveview 适配器照样会报 onReady（它指的是「流接上了」），
 * 于是在加这道门之前：每进一次直播间就给那款游戏 +1 次游玩，
 * 并且把它塞进侧边栏的「曾经玩过」。玩家的侧边栏里堆满了自己根本没玩过的游戏。
 *
 * 联机（P2P / 云游戏）**算**。游戏确实跑在房主或服务器上，但访客真的在操作这一局 ——
 * 那就是在玩，和本机有没有跑引擎无关。
 *
 * ⚠️ **联机房的观众席（详情页 `?watch=1`）目前算「玩过」。**
 * 严格说他也只是在看，和直播观众是一回事。之所以留着，是因为「联机算玩过」
 * 是产品定的规矩，而观众席在产品眼里属于联机。要改的话改这里一处，
 * 别在两个调用点各判一次 —— 那正是这个文件存在的理由。
 */

/** 详情页那一侧。判据是 URL 上的 `?live=`：那时候还没有会话 */
export function visitCountsAsPlayed(liveInvite?: string | null): boolean {
  return !liveInvite
}

/** 播放器那一侧。判据是会话种类 */
export function sessionCountsAsPlayed(session?: { live?: unknown } | null): boolean {
  if (!session) return false
  return !session.live
}
