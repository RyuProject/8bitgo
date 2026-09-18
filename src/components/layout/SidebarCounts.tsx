import { anyRoomsEnabled, useAllRooms } from '@/services/allRooms'
import { useGamesTotal } from '@/services/gamesTotal'

/**
 * 侧边栏两个计数徽标的实现。
 *
 * ## 为什么单独一个文件（2026-09-18）
 *
 * 这两个数字看着人畜无害，代价却不小：房间数要把**整条联机链路**拉进来
 * （allRooms → netplay / rooms / live / roomMerge / RoomCard），游戏总数在
 * 「本地存储模式」下要读 `src/data/games.ts` 那份内置种子目录（47 KB）。
 * 它们以前由 Sidebar 静态 import，于是**每个页面**（包括根本不联机的首页、博客、
 * 法务页）都得先把这些下载、解析、执行一遍，而输出来不过是导航栏右边一个数字。
 *
 * 现在改由 Sidebar 里的 DeferredCount 在空闲时动态 import 本文件 ——
 * 数据晚几百毫秒到，首屏少几十 KB。加新徽标时注意：**别在 Sidebar 里静态 import
 * 这里的任何东西**，否则整条链又回到主包，`npm run test:bundle-split` 拦不住这个。
 *
 * 计数徽标的静默样式：数字为 0 或纯静态计数时用，不抢「有人在线」那点绿色
 */
const COUNT_BADGE = 'inline-flex items-center rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted'

/**
 * 「一起玩」右侧的房间数 —— 联机房间 + 直播房间（useAllRooms 已经把三路合过）。
 *
 * 以前 0 个房间时整块不渲染，结果这一栏平时看不出「现在有没有人在玩」，
 * 只有热闹的时候才冒出个数字。现在 0 也照样显示，只是收成灰色不带呼吸点。
 * 三条通道全都没开（无后端 / 无信令）时才真的不渲染 —— 那种情况下 0 是假的。
 */
export function RoomCount() {
  const rooms = useAllRooms()
  if (!anyRoomsEnabled()) return null
  if (rooms.length === 0) return <span className={COUNT_BADGE}>0</span>
  return (
    <span className="inline-flex items-center gap-1 rounded bg-online/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-online">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-online" />
      {rooms.length}
    </span>
  )
}

/** 「全部游戏」右侧的游戏库总数 */
export function GamesCount() {
  const total = useGamesTotal()
  if (total === undefined) return null
  return <span className={COUNT_BADGE}>{total.toLocaleString()}</span>
}
