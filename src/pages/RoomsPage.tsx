import { useSearchParams } from 'react-router-dom'
import { getMultiplayerGames } from '@/services/games'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { anyRoomsEnabled, useAllRooms } from '@/services/allRooms'
import { p2pPlayable, cloudPlayable } from '@/emulator'
import { GameCard } from '@/components/game/GameCard'
import { RoomCard } from '@/components/game/RoomCard'
import { SectionHeader } from '@/components/ui/SectionHeader'

/**
 * 联机玩：正在进行中的房间列表。
 * 每个正在联机的玩家自动拥有一个房间（见 EmulatorPlayer），这里按创建时间倒序展示，
 * 点进去就是该游戏的详情页（带 ?room=），选好手柄位即可加入。
 */
export function RoomsPage() {
  const t = useT()
  // ?live=1 —— 同一批房间，换个看法：按「几个人在看」排，文案讲的是看而不是玩
  const [searchParams] = useSearchParams()
  const live = searchParams.get('live') === '1'
  useSeo({
    title: live ? t.rooms.liveH1 : t.rooms.title,
    description: live ? t.rooms.liveSeo : t.rooms.seo,
    noindex: true,
  })
  const all = useAllRooms()
  const rooms = live ? [...all].sort((a, b) => (b.spectators ?? 0) - (a.spectators ?? 0)) : all
  const enabled = anyRoomsEnabled()
  const suggestions = getMultiplayerGames(12).filter((g) => p2pPlayable(g.platform) || cloudPlayable(g.platform))

  return (
    <div className="container-x py-8 sm:py-10">
      <div className="max-w-2xl">
        <span className="text-pixel text-[11px] text-brand-hover">{live ? 'LIVE' : 'MULTIPLAYER'}</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{live ? t.rooms.liveH1 : t.rooms.h1}</h1>
        <p className="mt-3 leading-relaxed text-muted">{live ? t.rooms.liveIntro : t.rooms.intro}</p>
      </div>

      <section className="mt-8">
        <SectionHeader
          title={live ? t.rooms.liveH1 : t.rooms.liveTitle}
          subtitle={enabled ? fmt(t.rooms.liveCount, { n: String(rooms.length) }) : undefined}
          icon="👥"
          actions={
            enabled ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <span className="h-2 w-2 animate-pulse rounded-full bg-online" />
                {t.rooms.autoRefresh}
              </span>
            ) : undefined
          }
        />

        {!enabled ? (
          <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted">
            <p className="font-semibold text-fg">{t.rooms.disabledTitle}</p>
            <p className="mt-1 leading-relaxed">{t.rooms.disabledBody}</p>
          </div>
        ) : rooms.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong bg-surface p-8 text-center">
            <p className="text-3xl" aria-hidden>
              🕹️
            </p>
            <p className="mt-2 font-semibold">{live ? t.rooms.liveEmptyTitle : t.rooms.emptyTitle}</p>
            <p className="mt-1 text-sm text-muted">{live ? t.rooms.liveEmptyBody : t.rooms.emptyBody}</p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {rooms.map((room) => (
              <li key={room.roomId}>
                <RoomCard room={room} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {suggestions.length > 0 && (
        <section className="mt-10">
          <SectionHeader title={t.rooms.startTitle} subtitle={t.rooms.startSubtitle} icon="🎮" moreTo="/games?multiplayer=1" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {suggestions.map((g) => (
              <GameCard key={g.slug} game={g} showCoin={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
