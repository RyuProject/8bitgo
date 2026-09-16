/**
 * 一局游戏可占用的手柄位上限。
 *
 * 后台表单、公开 API、云端房间与 P2P 信令必须读同一个值；各处手写 4 的结果是
 * 后台看起来只允许四人，旧客户端却仍能向接口塞进更多玩家。
 */
export const NETPLAY_MAX_PLAYERS = 4

/** 把数据库或接口里的玩家数收敛到 1..4；脏值按单人处理，不擅自开放联机。 */
export function normalizeGamePlayers(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.min(NETPLAY_MAX_PLAYERS, Math.trunc(parsed)))
}
