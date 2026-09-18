/**
 * 「联机 / 直播 / 云端房间开没开」这几个判断，以及信令地址。
 *
 * ## 为什么单独一个文件（2026-09-18）
 *
 * 和 `emulator/paths.ts` 当初分开是**同一个坑的第二轮**，只是这次发生在服务层：
 *
 *   services/roms.ts（游戏库到处在用）
 *     → @/emulator 的 isPlayable → registry → runtimeMeta
 *       → `liveEnabled()`（一个布尔）→ services/live.ts（464 行）→ services/netplay.ts（585 行）
 *
 * 所以连**首页的封面卡片**都得先把整条联机链路下载、解析、执行一遍。
 * `runtimeMeta.ts` / `paths.ts` 想要的只是「配了没有」这一个布尔值，
 * 把它放在这里（纯配置读取、零运行时状态）就能把那两个大模块摘出去。
 * 实测首屏静态闭包因此少了 20 KB 上下（gzip 8 KB）。
 *
 * ⚠️ **这里只放「不需要连上就能回答」的配置判断。** 房间列表、连接、心跳、重连
 * 这些有状态的东西留在各自的服务里 —— 搬进来就等于把整条链路又拖回主包，
 * 那正是这个文件存在的理由。
 *
 * ⚠️ 信令地址**只有这一份**（原来定义在 netplay.ts）。两份定义迟早漂移成
 * 「这里说开了、那里连不上」。
 */
import { apiEnabled } from './api'

/** 信令服务器地址，形如 https://host/netplay。空 = 整块联机功能隐藏 */
export const NETPLAY_URL: string = (import.meta.env.VITE_NETPLAY_URL || '').replace(/\/+$/, '')

/** P2P 联机是否可用：只看信令配了没有 */
export function netplayEnabled(): boolean {
  return Boolean(NETPLAY_URL)
}

/**
 * 云端房间（游戏跑在服务器上）是否可用。
 *
 * 和 liveEnabled 现在是同一个条件（都要求后端），但**不要合并成一个函数**：
 * 这两个功能将来各配一台 / 关一台是完全可能的（云端按 CPU 计费，
 * 直播的带宽账又是另一笔），语义不同就该各留一个名字。
 */
export function roomsEnabled(): boolean {
  return apiEnabled()
}

/** 直播（一人玩、多人看）是否可用：直播的房间列表也在我们自己的后端上 */
export function liveEnabled(): boolean {
  return apiEnabled()
}

/** 房间列表整体是否可用（三条通道有一条能用就算） */
export function anyRoomsEnabled(): boolean {
  return netplayEnabled() || roomsEnabled() || liveEnabled()
}
