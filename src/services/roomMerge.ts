/**
 * 直播卡 + 联机卡合成一张。
 *
 * 主播点了「联机」之后，同一局会同时出现在两个列表里：直播**不停**（观众正看着的
 * 那一路画面一帧都不该掉），联机房又确实开出来了。大厅上摆两张卡是在骗人 ——
 * 点进哪一张都是同一个人的同一局。
 *
 * 配对关系由服务端给（直播间的 netplayRoomId，主播自己报的，见 server/src/live.js）：
 * 别人的浏览器没法靠昵称 + 游戏名去猜，一个人开两台机器就串了。
 *
 * 单独拆出来是为了**能测**：allRooms.ts 是个 React hook，而这里是纯函数。
 * 合并错了的症状是「房间在大厅里凭空消失」，那种 bug 靠肉眼盯不出来。
 */
import type { RoomView } from '@/components/game/RoomCard'

export interface LiveEntry {
  /** 配对的联机房号；没有就是一场纯直播 */
  netplayRoomId?: string | null
  /** 这个直播间里有几个人在看 */
  viewers?: number
  /** 合不掉时按原样摆出去的那张直播卡 */
  view: RoomView
}

export function mergeLiveIntoP2p(p2p: RoomView[], live: LiveEntry[]): RoomView[] {
  /**
   * 判据是「那个联机房**真的在列表里**」而不是「报了房号」。
   *
   * 两份数据是分别取的（/api/netplay/rooms 走 SSE、/api/live/rooms 是轮询），
   * 联机那边慢一拍是常事 —— 只看房号的话，这一局会在大厅里凭空消失几秒。
   */
  const ids = new Set(p2p.map((r) => r.roomId))
  const paired = (l: LiveEntry) => Boolean(l.netplayRoomId && ids.has(l.netplayRoomId))

  // 合进去的直播观众也算「在看这一局的人」，并进联机房自己的观战席人数
  const extra = new Map<string, number>()
  for (const l of live) {
    if (!paired(l)) continue
    const id = l.netplayRoomId as string
    extra.set(id, (extra.get(id) ?? 0) + (l.viewers ?? 0))
  }

  const out = p2p.map((r) => {
    const add = extra.get(r.roomId)
    return add === undefined ? r : { ...r, spectators: (r.spectators ?? 0) + add }
  })
  for (const l of live) if (!paired(l)) out.push(l.view)
  return out
}
