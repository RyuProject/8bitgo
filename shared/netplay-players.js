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

/**
 * 一款游戏是否真的允许创建联机房。
 *
 * `multiplayer` 和 `players` 是一组约束，不能各看各的：线上曾出现
 * `multiplayer=1, players=1` 的《超级马力欧兄弟》，页面因此画出「创建联机房间」，
 * 但服务端按一人配置必然拒绝，按钮对所有玩家都是坏的。把判定集中在这里，
 * 让 API、页面和开房鉴权读同一条规则，脏数据也不会再被宣传成可联机。
 */
export function gameSupportsNetplay(multiplayer, players) {
  const enabled = multiplayer === true || multiplayer === 1 || multiplayer === '1'
  return enabled && normalizeGamePlayers(players) >= 2
}
