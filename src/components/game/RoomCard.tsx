import { Link } from 'react-router-dom'
import { useGameBySlug } from '@/services/gameCache'
import { platformMap } from '@/data/platforms'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { gameTitle, platformLabel } from '@/services/i18nData'
import type { Room } from '@/services/rooms'
import type { LiveRoomInfo } from '@/services/live'
import { normalizePresence, type Presence } from '@/services/presence'

/** 统一的房间视图：P2P（房主浏览器跑）、云端（服务器跑）、直播（只看不玩）三种来源合并后长这样 */
export interface RoomView {
  roomId: string
  gameSlug: string
  players: number
  max: number
  /** 只看不玩的人数。P2P 房间天然就是一路直播，这里就是「几个人在看」 */
  spectators?: number
  host: { nickname: string } | null
  members: Array<{ nickname: string; playerIndex?: number; host: boolean; presence?: Presence }>
  /**
   * 房主的设备 / 地区 / 网络（见 services/presence.ts）。
   * 三种房间都由服务端推断，房主自己报不了假。
   */
  presence?: Presence
  createdAt: number
  /**
   * p2p   = 房主的浏览器在跑，别人可以上场当玩家，也可以只看
   * cloud = 服务器在跑（付费通道）
   * live  = 单向直播（services/live.ts + emulator/broadcast.ts），只有观众，没有手柄位
   */
  kind: 'p2p' | 'cloud' | 'live'
  /** 直播房间的游戏名。直播可以开在任何游戏上，包括本站游戏库里没有的（比如本地 ROM） */
  gameName?: string
}

/** 云端房间（/api/rooms）转成统一视图 */
export function cloudRoomView(r: Room): RoomView {
  return {
    roomId: r.roomId,
    gameSlug: r.gameSlug,
    players: r.players,
    max: 4,
    spectators: 0,
    host: r.host,
    members: r.members.map((m) => ({ ...m, presence: normalizePresence(m.presence) })),
    presence: normalizePresence(r.presence),
    createdAt: r.createdAt,
    kind: 'cloud',
  }
}
/**
 * 直播房间（/api/live/rooms）转成统一视图。
 *
 * 直播是「一人玩、多人看」：房主永远是唯一的玩家，所以 players / max 都是 1，
 * 人数看的是 spectators。不摆手柄位 —— 观众没有位置可占。
 */
export function liveRoomView(r: LiveRoomInfo): RoomView {
  // 直播只有主播一个人，「房主的名片」和「唯一成员的名片」是同一张
  const presence = normalizePresence(r.presence)
  return {
    roomId: r.roomId,
    gameSlug: r.gameSlug,
    gameName: r.gameName || r.title,
    players: 1,
    max: 1,
    spectators: r.viewers,
    host: r.hostName ? { nickname: r.hostName } : null,
    members: r.hostName ? [{ nickname: r.hostName, playerIndex: 0, host: true, presence }] : [],
    presence,
    createdAt: r.startedAt,
    kind: 'live',
  }
}

import { GameCover } from './GameCover'
import { Badge } from '@/components/ui/Badge'
import { PresenceTags } from './PresenceTags'
import { cx } from '@/lib/format'

/** 房间卡片：封面 = 正在玩的游戏，下面是 host 与人数 */
export function RoomCard({ room, compact = false }: { room: RoomView; compact?: boolean }) {
  const t = useT()
  const lang = useLang()
  const game = useGameBySlug(room.gameSlug)
  // 直播房间只有房主一个玩家，不能按「这个游戏支持几人」把上限撑大
  const live = room.kind === 'live'
  const max = live ? 1 : Math.max(room.max || 0, game?.players ?? 2)
  // 直播没有手柄位，也就没有「满了」这回事：观众上限由服务端的 MAX_VIEWERS 兜着
  const full = !live && room.players >= max
  const viewers = room.spectators ?? 0
  // 手柄位满了也能进 —— 以观众身份看房主的画面（云端房间不支持）
  const watchable = room.kind === 'p2p' || live
  // P2P 房间走 ?p2p=，直播走 ?live=，云端房间走 ?room=
  const param = room.kind === 'p2p' ? 'p2p' : live ? 'live' : 'room'
  const to =
    `/games/${room.gameSlug}?${param}=${encodeURIComponent(room.roomId)}` +
    (full && watchable ? '&watch=1' : '')
  // 游戏库里认不出来的 slug（本地 ROM 开的播）就用主播报上来的游戏名，别露出 slug
  const label = game ? gameTitle(game, lang) : room.gameName || room.gameSlug

  if (compact) {
    return (
      <Link to={to} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-black/5" title={label}>
        <span className="w-14 shrink-0 overflow-hidden rounded-md">
          {game ? <GameCover game={game} ratio="landscape" showTitle={false} showBadge={false} iconSize="sm" /> : <span className="block aspect-[4/3] bg-surface-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{label}</span>
          <span className="flex items-center gap-1 text-[11px] text-muted">
            {/* 侧边栏这一行本来就窄：名字让位，三个格子里只画知道的（skipUnknown） */}
            <span className="truncate">👑 {room.host?.nickname ?? '—'}</span>
            <PresenceTags presence={room.presence} skipUnknown />
          </span>
        </span>
        {live ? (
          // 直播说「几个人在看」，说「1/1」没有任何信息
          <span className="shrink-0 text-[11px] font-semibold text-live">📡 {viewers}</span>
        ) : (
          <span className={cx('shrink-0 text-[11px] font-semibold', full ? 'text-dim' : 'text-online')}>
            {room.players}/{max}
            {viewers > 0 && <span className="ml-1 font-normal text-muted">👀 {viewers}</span>}
          </span>
        )}
      </Link>
    )
  }

  return (
    <Link
      to={to}
      className="group card-hover block overflow-hidden rounded-card border border-line bg-surface hover:border-brand/60"
    >
      <div className="relative">
        {game ? (
          <GameCover game={game} ratio="landscape" showTitle={false} />
        ) : (
          <div className="grid aspect-[4/3] place-items-center bg-surface-3 text-4xl">🎮</div>
        )}
        {/* 直播不摆手柄位人数，那一格换成在看人数（0 也显示 —— 刚开播就是 0） */}
        {!live && (
          <Badge tone={full ? 'dark' : 'online'} className="absolute bottom-2 right-2">
            👥 {room.players}/{max}
          </Badge>
        )}
        {(live || viewers > 0) && (
          <Badge tone={live ? 'live' : 'dark'} className={cx('absolute bottom-2', live ? 'right-2' : 'left-2')}>
            👀 {fmt(t.rooms.viewers, { n: String(viewers) })}
          </Badge>
        )}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-1 text-[10px] font-semibold text-white backdrop-blur">
          <span
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              live ? 'animate-pulse bg-live' : full && !watchable ? 'bg-dim' : 'animate-pulse bg-online',
            )}
          />
          {live ? 'LIVE' : !full ? t.rooms.open : watchable ? `👀 ${t.rooms.watch}` : t.rooms.full}
        </span>
      </div>
      <div className="space-y-1.5 p-3">
        <h3 className="truncate text-sm font-semibold leading-tight">{label}</h3>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          {/* 房主的名字可以被截断，后面那三个格子不行 —— 它们是这一行的重点 */}
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">👑 {fmt(t.rooms.hostLabel, { name: room.host?.nickname ?? '—' })}</span>
            <PresenceTags presence={room.presence} />
          </span>
          {game && <span className="shrink-0">{platformLabel(t, game.platform, platformMap[game.platform]?.name ?? game.platform)}</span>}
        </div>
        {/* 直播没有手柄位可占，摆一排「1P · 空」只会让人以为能上场 */}
        <div className={cx('flex flex-wrap gap-1', live && 'hidden')}>
          {Array.from({ length: max }, (_, i) => {
            // 云端房间知道每个人占哪个手柄位；P2P 只知道顺序
            const m = room.members.find((x) => x.playerIndex === i) ?? (room.kind === 'p2p' ? room.members[i] : undefined)
            return (
              <span
                key={i}
                className={cx(
                  'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  m ? 'bg-brand-soft text-brand-hover' : 'border border-dashed border-line-strong text-dim',
                )}
                title={m?.nickname}
              >
                {i + 1}P {m ? `· ${m.nickname}` : `· ${t.rooms.slotFree}`}
                {/* 空位没有名片；已知的那几格才画，四个位子挂一排 ❓ 只会糊住这一行 */}
                {m && <PresenceTags presence={m.presence} skipUnknown className="ml-1 align-[-1px]" />}
              </span>
            )
          })}
        </div>
      </div>
    </Link>
  )
}
