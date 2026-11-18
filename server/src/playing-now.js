/**
 * 游戏详情页「正在玩」那一格：某款游戏此刻有几个人在玩。
 *
 * ## 数据从哪来（以及它为什么只是下限）
 *
 * 站内没有「每个玩家开局都上报心跳」的通道 —— 播放器只在开播 / 联机时才连服务器。
 * 所以这里只数服务器**已经知道**的两类人，二者都是内存表，不碰数据库：
 *
 *   1. 直播间（live.js）：普通开局默认会自动开播，一个房间 = 主播本人在玩。
 *      只数在大厅可见的房间（listed）：主播切后台太久的房画面是冻着的，不算「正在玩」。
 *   2. P2P 联机房（netplay.js）：数占手柄位的玩家，观众不算。
 *
 * 选了「不公开」、直播席位已满、单机离线玩的人服务器看不见，所以这个数是**下限**，
 * 前端文案只写「正在玩」而不承诺精确在线人数。
 *
 * ## 两个容易漏的点
 *
 * - **主播点了「联机」之后，直播间和联机房是同一拨人**（直播间带 netplayRoomId）。
 *   这时主播已经算在联机房的 players 里，直播间那一个不能再加，否则一个人被数两次。
 * - **成人游戏的房间**：两张表默认都不返回成人房（见 liveRooms / netplayRooms 的 includeAdult）。
 *   这里沿用同一个默认值，由 HTTP 层核实年龄后才显式放开 —— 只是一个数字也不破例，
 *   免得以后有人照着这里抄一个「返回房间列表」的接口时把年龄门一起抄丢。
 */
import { netplayGameId } from '../../shared/netplay-game-id.js'

/**
 * @param {string} slug 游戏 slug（和开播 / 开房时上报的是同一个值）
 * @param {{ includeAdult?: boolean, live: (opts: object) => any[], netplay: (opts: object) => any[] }} deps
 *   live / netplay 由调用方注入（index.js 传 liveRooms / netplayRooms），测试可以换成假数据。
 */
export function countPlayingNow(slug, { includeAdult = false, live, netplay }) {
  const key = String(slug || '').trim()
  if (!key) return 0
  const netplayRooms = netplay({ gameId: netplayGameId(key), includeAdult }) || []
  const counted = new Set()
  let total = 0
  for (const room of netplayRooms) {
    counted.add(String(room.roomId))
    total += Math.max(0, Number(room.players) || 0)
  }
  for (const room of live({ gameSlug: key, includeAdult }) || []) {
    // 已经算进联机房的主播不重复计
    if (room.netplayRoomId && counted.has(String(room.netplayRoomId))) continue
    total += 1
  }
  return total
}
