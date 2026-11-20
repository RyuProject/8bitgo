/**
 * 详情页「正在玩」计数（src/playing-now.js）。
 *
 * 守三件事：
 *   1. 主播点了联机后，直播间与联机房是同一拨人 —— 主播只能算一次；
 *   2. 观众不算玩家（联机房的 players 本来就只数占手柄位的）；
 *   3. includeAdult 默认 false，必须原样传给两张表（年龄门由 HTTP 层决定，这里不能自己放开）。
 *
 * 用法：cd server && npm run test:playing-now
 */
import { countPlayingNow } from '../src/playing-now.js'
import { netplayGameId } from '../../shared/netplay-game-id.js'

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) failed++
}

const liveRooms = [
  { roomId: 'L1', gameSlug: 'contra', netplayRoomId: null, adult: false },
  { roomId: 'L2', gameSlug: 'contra', netplayRoomId: 'N1', adult: false },
  { roomId: 'L3', gameSlug: 'metal-slug', netplayRoomId: null, adult: false },
  { roomId: 'L4', gameSlug: 'adult-game', netplayRoomId: null, adult: true },
]
const netRooms = [
  { roomId: 'N1', gameId: netplayGameId('contra'), players: 2, spectators: 5, adult: false },
  { roomId: 'N2', gameId: netplayGameId('contra'), players: 1, spectators: 0, adult: false },
  { roomId: 'N3', gameId: netplayGameId('adult-game'), players: 2, spectators: 0, adult: true },
]
const calls = []
const live = (opts) => {
  calls.push(['live', opts])
  return liveRooms.filter((r) => r.gameSlug === opts.gameSlug && (opts.includeAdult || !r.adult))
}
const netplay = (opts) => {
  calls.push(['netplay', opts])
  return netRooms.filter((r) => String(r.gameId) === String(opts.gameId) && (opts.includeAdult || !r.adult))
}

ok(countPlayingNow('contra', { live, netplay }) === 4, '联机房 2+1 人 + 一个没联机的直播间；联机中的主播不重复计（应为 4）')
ok(countPlayingNow('metal-slug', { live, netplay }) === 1, '只有直播间的游戏按 1 人/间计')
ok(countPlayingNow('nothing-here', { live, netplay }) === 0, '没人玩回 0')
ok(countPlayingNow('', { live, netplay }) === 0, '空 slug 回 0，不去扫表')

calls.length = 0
ok(countPlayingNow('adult-game', { live, netplay }) === 0, '成人游戏默认不计入（沿用两张表的安全默认值）')
ok(calls.every(([, o]) => o.includeAdult === false), 'includeAdult 默认 false 原样传给两张表')
ok(countPlayingNow('adult-game', { includeAdult: true, live, netplay }) === 3, 'HTTP 层核实年龄后才计入成人房')

console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 正在玩计数：全部通过')
process.exitCode = failed ? 1 : 0
