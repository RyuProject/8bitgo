import { useT, fmt } from '@/services/i18n'
import type { NetplayRoom } from '@/services/netplay'
import type { LiveChatMessage } from '@/services/live'
import type { ChatSendResult } from './chatSend'
import { LiveChatBar, LiveChatHistory, type ChatBarToggle } from './LiveChat'

/** 联机玩家的右栏。只复用弹幕控件，不改变直播观众的 LiveWatchPanel。 */
export function MatchChatPanel({ room, messages, onSend, live, match }: {
  room?: NetplayRoom
  messages: LiveChatMessage[]
  onSend: ((text: string) => Promise<ChatSendResult>) | null
  live?: ChatBarToggle | null
  match?: ChatBarToggle | null
}) {
  const t = useT()
  const tt = t.player.tools

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-line bg-surface p-4">
        <p className="font-semibold text-fg">{tt.watchMatch} · {room ? fmt(t.player.roomBadge, { players: String(room.players), max: String(room.max) }) : '—'}</p>
        <ul className="mt-3 space-y-1.5">
          {room?.members.filter((m) => m.role !== 'spectator').map((m, i) => (
            <li key={`${m.nickname}-${i}`} className="flex items-center gap-2 text-sm text-fg">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span className="truncate">{m.nickname}{m.host ? ` · ${tt.watchHost}` : ''}</span>
            </li>
          ))}
        </ul>
        {room && (room.spectators ?? 0) > 0 && (
          <p className="mt-3 text-xs text-muted">{tt.watchViewers} · {room.spectators}</p>
        )}
      </div>
      <LiveChatBar onSend={onSend} live={live} match={match} />
      <LiveChatHistory messages={messages} className="max-h-[28rem] min-h-[12rem]" />
    </div>
  )
}
