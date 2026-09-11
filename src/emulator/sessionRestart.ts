/**
 * 「这一局能不能原地重开」。
 *
 * 原地重开 = 拆掉当前引擎、用同样的 ROM / 平台 / 运行时再挂一次，页面不刷新
 * （见 EmulatorPlayer 的 restartSession）。**它同时是 DOS 读档的实现**：
 * js-dos 存的是盘上被改过的文件，而它只在开机时调一次 fsChanges.pull ——
 * 存档只能在「新的一局」开机那一刻装回盘上。
 *
 * 之所以把这个判断单独拎出来，而不是在播放器里写一串 `!s.netplay && !s.cloud && ...`：
 * 这几个「不能重开」的会话种类是**一条会被新功能悄悄破坏的规矩**。
 * 以后再加一种「游戏不在本机跑」的会话（云存档直连、录像回放……），
 * 漏掉一个的表现不是报错，而是玩家点一下读档、整个房间没了 —— 而且只在联机时才复现。
 * 拎出来之后它可以被直接测（见 scripts/test-dos-load.mjs），
 * 也逼着新增会话种类的人来这里做决定。
 */

/** 会话里那些「游戏不在本机这一份引擎里」的标记。只关心有没有，不关心内容 */
export interface RestartableSession {
  /** P2P 联机：游戏跑在房主浏览器里 */
  netplay?: unknown
  /** 云游戏：机器在服务器上 */
  cloud?: unknown
  /** 看直播：本机压根没有游戏状态 */
  live?: unknown
}

/**
 * 能不能原地重开。
 *
 * - 没有会话（还没开始 / 已经收掉）：不能，没有东西可重开
 * - 联机 / 云游戏 / 看直播：不能。重开只会把房间拆掉或者断掉那一路，
 *   而玩家点的是「读档」—— 他绝不会预期这个结果
 * - 其余（本地文件、云端 ROM）：可以
 */
export function canRestartInPlace(session: RestartableSession | null | undefined): boolean {
  if (!session) return false
  return !session.netplay && !session.cloud && !session.live
}
