/**
 * 两种房间合并成一个列表：
 *   P2P   —— 游戏在房主的浏览器里跑，来自信令服务器（services/netplay.ts），零服务器成本，默认方案
 *   云端  —— 游戏在 cloud-game 服务器上跑，来自 /api/rooms 心跳，付费通道
 *
 * 侧边栏「联机玩」和 /rooms 页都用这里，页面不用关心房间是哪种。
 */
import { useMemo } from 'react'
import { games } from '@/data/games'
import { cloudRoomView, type RoomView } from '@/components/game/RoomCard'
import { netplayEnabled, slugForGameId, useNetplayRooms } from './netplay'
import { roomsEnabled, useRooms } from './rooms'

/** 信令服务器只知道 gameId（slug 的散列），这里反查回 slug */
const allSlugs = () => games.map((g) => g.slug)

export function useAllRooms(): RoomView[] {
  const p2p = useNetplayRooms()
  const cloud = useRooms()

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
        members: r.members,
        createdAt: r.createdAt,
        kind: 'p2p',
      })
    }

    for (const r of cloud) list.push(cloudRoomView(r))

    return list.sort((a, b) => b.createdAt - a.createdAt)
  }, [p2p, cloud])
}

/** 联机功能整体是否可用（两条通道有一条能用就算） */
export function anyRoomsEnabled(): boolean {
  return netplayEnabled() || roomsEnabled()
}
