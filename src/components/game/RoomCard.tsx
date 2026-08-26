import { Link } from 'react-router-dom'
import { getGame } from '@/services/games'
import { platformMap } from '@/data/platforms'
import { useLang } from '@/services/lang'
import { useT, fmt } from '@/services/i18n'
import { gameTitle, platformLabel } from '@/services/i18nData'
import type { Room } from '@/services/rooms'
import { GameCover } from './GameCover'
import { Badge } from '@/components/ui/Badge'
import { cx } from '@/lib/format'

/** 房间卡片：封面 = 正在玩的游戏，下面是 host 与人数 */
export function RoomCard({ room, compact = false }: { room: Room; compact?: boolean }) {
  const t = useT()
  const lang = useLang()
  const game = getGame(room.gameSlug)
  const max = game?.players ?? 2
  const full = room.players >= max
  const to = `/games/${room.gameSlug}?room=${encodeURIComponent(room.roomId)}`

  if (compact) {
    return (
      <Link to={to} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-black/5" title={game ? gameTitle(game, lang) : room.gameSlug}>
        <span className="w-14 shrink-0 overflow-hidden rounded-md">
          {game ? <GameCover game={game} ratio="landscape" showTitle={false} showBadge={false} iconSize="sm" /> : <span className="block aspect-[4/3] bg-surface-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{game ? gameTitle(game, lang) : room.gameSlug}</span>
          <span className="block truncate text-[11px] text-muted">
            👑 {room.host?.nickname ?? '—'}
          </span>
        </span>
        <span className={cx('shrink-0 text-[11px] font-semibold', full ? 'text-dim' : 'text-online')}>
          {room.players}/{max}
        </span>
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
        <Badge tone={full ? 'dark' : 'online'} className="absolute bottom-2 right-2">
          👥 {room.players}/{max}
        </Badge>
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-1 text-[10px] font-semibold text-white backdrop-blur">
          <span className={cx('h-1.5 w-1.5 rounded-full', full ? 'bg-dim' : 'animate-pulse bg-online')} />
          {full ? t.rooms.full : t.rooms.open}
        </span>
      </div>
      <div className="space-y-1.5 p-3">
        <h3 className="truncate text-sm font-semibold leading-tight">{game ? gameTitle(game, lang) : room.gameSlug}</h3>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">
            👑 {fmt(t.rooms.hostLabel, { name: room.host?.nickname ?? '—' })}
          </span>
          {game && <span className="shrink-0">{platformLabel(t, game.platform, platformMap[game.platform]?.name ?? game.platform)}</span>}
        </div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: max }, (_, i) => {
            const m = room.members.find((x) => x.playerIndex === i)
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
              </span>
            )
          })}
        </div>
      </div>
    </Link>
  )
}
