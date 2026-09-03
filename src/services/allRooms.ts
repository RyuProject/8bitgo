/**
 * 三种房间合并成一个列表：
 *   P2P   —— 游戏在房主的浏览器里跑，来自信令服务器（services/netplay.ts），零服务器成本，默认方案
 *   云端  —— 游戏在 cloud-game 服务器上跑，来自 /api/rooms 心跳，付费通道
 *   直播  —— 一人玩多人看，来自 /api/live/rooms（services/live.ts + emulator/broadcast.ts）
 *
 * 侧边栏「联机玩」和 /rooms 页都用这里，页面不用关心房间是哪种。
 *
 * ⚠️ 直播那一路以前是漏的：LiveControls 开播之后房间确实登记进了 /live 命名空间，
 * 但这里只合了 P2P 和云端两路，fetchLiveRooms() 全仓库没有调用方 ——
 * 于是「正在直播」显示得好好的，直播大厅永远是空的。
 */
import { useMemo } from 'react'
import { games } from '@/data/games'
import { cloudRoomView, liveRoomView, type RoomView } from '@/components/game/RoomCard'
import { normalizePresence } from './presence'
import { netplayEnabled, slugForGameId, useNetplayRooms } from './netplay'
import { roomsEnabled, useRooms } from './rooms'
import { liveEnabled, useLiveRooms } from './live'

/** 信令服务器只知道 gameId（slug 的散列），这里反查回 slug */
const allSlugs = () => games.map((g) => g.slug)

export function useAllRooms(): RoomView[] {
  const p2p = useNetplayRooms()
  const cloud = useRooms()
  const live = useLiveRooms()

  return useMemo(() => {
    const list: RoomView[] = []

    for (const r of p2p) {
      const slug = slugForGameId(r.gameId, allSlugs())
      if (!slug) continue // 认不出来的游戏（别的站点用了同一个信令服务器）就不展示
      list.push({
        roomId: r.roomId,
        gameSlug: slug,
        players: r.players,
        max: r.max,
        spectators: r.spectators ?? 0,
        host: r.host,
        members: r.members.map((m) => ({ ...m, presence: normalizePresence(m.presence) })),
        // 房主的设备 / 地区 / 网络，服务端从 socket 握手里看出来的（见 services/presence.ts）
        presence: normalizePresence(r.presence),
        createdAt: r.createdAt,
        kind: 'p2p',
      })
    }

    for (const r of cloud) list.push(cloudRoomView(r))

    // 直播房间的 gameSlug 是主播自己报的，不必反查散列表；游戏库里没有这个 slug
    // 也照样展示（卡片会退回用主播报的游戏名，见 RoomCard 的 label）。
    // 但 slug 是空的就得跳过 —— 卡片链接会变成 /games/?live=xxx，点进去是 404
    for (const r of live) if (r.gameSlug) list.push(liveRoomView(r))

    return list.sort((a, b) => b.createdAt - a.createdAt)
  }, [p2p, cloud, live])
}

/** 房间列表整体是否可用（三条通道有一条能用就算） */
export function anyRoomsEnabled(): boolean {
  return netplayEnabled() || roomsEnabled() || liveEnabled()
}
