import { normalizeGamePlayers } from '../../../shared/netplay-players.js'

/**
 * 联机协议测试不连接数据库：测试只替换「查后台配置」这一层，其余开房/进房逻辑仍走生产代码。
 * 个别用例可以传 game_slug=backend-two，验证客户端即使报 4，服务端也只开放后台给的 2 个位置。
 */
export function testGameRoomPolicy({ gameId, gameSlug, requestedMax } = {}) {
  let maxPlayers = Math.max(2, normalizeGamePlayers(requestedMax))
  if (gameSlug === 'backend-two') maxPlayers = 2
  if (gameSlug === 'single-player') maxPlayers = 1
  return { gameSlug: gameSlug || 'test-game', gameId: gameId ?? null, maxPlayers }
}
