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

/**
 * 联机人数从哪来（games.netplay_mode）。
 *
 * - `auto`：默认。人数按 ROM 推断（街机读 FBNeo 驱动表的 Players，见
 *   server/src/netplay-auto.js），推断不出的街机按 2 人；其它平台暂时沿用已存的值。
 * - `on`：管理员强制开，人数用后台填的值（至少 2）。
 * - `off`：管理员强制关。
 *
 * `players` / `multiplayer` 两列仍是**生效值**，由服务端在每次写入后重算 —— 公开 API、
 * 游戏库筛选、开房鉴权都继续只读这两列，不会出现某个读者漏看 mode 的情况。
 */
export const NETPLAY_MODES = ['auto', 'on', 'off']

export function normalizeNetplayMode(value) {
  return NETPLAY_MODES.includes(value) ? value : 'auto'
}

/**
 * 请求里的联机模式。显式给了 netplayMode 就用它；旧客户端 / 批量导入只带 multiplayer：
 * 勾了联机当作「强制开」（保留他们的意图），没勾返回 undefined = 不改库里的模式。
 */
export function netplayModeFromInput(game) {
  if (game && NETPLAY_MODES.includes(game.netplayMode)) return game.netplayMode
  const flag = game?.multiplayer
  if (flag === true || flag === 1 || flag === '1') return 'on'
  return undefined
}
