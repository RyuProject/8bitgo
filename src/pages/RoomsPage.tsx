import { useSearchParams } from 'react-router-dom'
import { usePageData, type GamesData } from '@/services/pageData'
import { useSeo } from '@/services/seo'
import { useT, fmt } from '@/services/i18n'
import { anyRoomsEnabled, useAllRooms } from '@/services/allRooms'
import { p2pPlayable, cloudPlayable } from '@/emulator'
import { GameCard } from '@/components/game/GameCard'
import { RoomCard } from '@/components/game/RoomCard'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { GameGridSkeleton } from '@/components/ui/PageSkeleton'

/**
 * 联机玩：正在进行中的房间列表。
 * 每个正在联机的玩家自动拥有一个房间（见 EmulatorPlayer），这里按创建时间倒序展示，
 * 点进去就是该游戏的详情页（带 ?room=），选好手柄位即可加入。
 */
export function RoomsPage() {
  const t = useT()
  // ?live=1 —— 只保留真的能观看的 P2P / 直播房间，并按「几个人在看」排。
  // 云端房没有观众席；把它混进来会让「观看」按钮实际变成加入对局。
  const [searchParams] = useSearchParams()
  const live = searchParams.get('live') === '1'
  useSeo({
    title: live ? t.rooms.liveH1 : t.rooms.title,
    description: live ? t.rooms.liveSeo : t.rooms.seo,
    noindex: true,
  })
  const all = useAllRooms()
  const rooms = live
    ? all.filter((room) => room.kind !== 'cloud').sort((a, b) => (b.spectators ?? 0) - (a.spectators ?? 0))
    : all
  const enabled = anyRoomsEnabled()
  // 联机页推荐能远程联机的游戏；直播页则推荐热门游戏——单人游戏开始游玩也会自动开播。
  // 两种意图不能共用 multiplayer=1，否则空直播大厅会错误暗示「只有联机游戏能播」。
  const suggestState = usePageData<GamesData>('/games', live ? { sort: 'popular' } : { multiplayer: 1, sort: 'popular' }, 'games')
  const suggestions = (suggestState.data?.list.items ?? [])
    .filter((g) => live || p2pPlayable(g.platform) || cloudPlayable(g.platform))
    .slice(0, 12)

  return (
    <div className="container-x py-8 sm:py-10">
      <div className="max-w-2xl">
        <span className="text-pixel text-[11px] text-brand-hover">{live ? 'LIVE' : 'MULTIPLAYER'}</span>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{live ? t.rooms.liveH1 : t.rooms.h1}</h1>
        <p className="mt-3 leading-relaxed text-muted">{live ? t.rooms.liveIntro : t.rooms.intro}</p>
      </div>

      <section className="mt-8">
        <SectionHeader
          title={t.rooms.liveTitle}
          subtitle={enabled ? fmt(t.rooms.liveCount, { n: String(rooms.length) }) : undefined}
          icon={live ? '📡' : '👥'}
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
                <RoomCard room={room} watchOnly={live} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {(suggestState.status === 'loading' || suggestions.length > 0) && (
        <section className="mt-10">
          <SectionHeader
            title={live ? t.rooms.liveStartTitle : t.rooms.startTitle}
            subtitle={live ? t.rooms.liveStartSubtitle : t.rooms.startSubtitle}
            icon={live ? '📡' : '🎮'}
            moreTo={live ? '/games' : '/games?multiplayer=1'}
          />
          {suggestState.status === 'loading' && !suggestState.data ? (
            <GameGridSkeleton
              count={6}
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
            />
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {suggestions.map((g) => (
                <GameCard key={g.slug} game={g} showCoin={false} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
