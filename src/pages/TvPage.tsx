import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Game, PlatformId, SortKey } from '@/types'
import type { Lang } from '@/config/languages'
import { platforms, platformMap } from '@/data/platforms'
import { isPlatformEnabled } from '@/config/platforms'
import { genreLabel, gameTitle } from '@/services/i18nData'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { useSeo } from '@/services/seo'
import { romUrlForKey } from '@/services/roms'
import { cx, formatCount } from '@/lib/format'
import { gradientFor } from '@/lib/gradients'
import {
  fetchTv,
  computeRotation,
  rotationProgress,
  formatCountdown,
  type TvSignal,
} from '@/services/tv'
import { usePageData, fetchPageData, type GamesData } from '@/services/pageData'
import { useInfinite } from '@/services/infinite'
import { Button, chipClasses } from '@/components/ui/Button'
import { GameCard } from '@/components/game/GameCard'
import { InfiniteFooter } from '@/components/ui/InfiniteFooter'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const SORTS: Array<{ key: SortKey; labelKey: 'sortPopular' | 'sortNewest' | 'sortName' }> = [
  { key: 'popular', labelKey: 'sortPopular' },
  { key: 'newest', labelKey: 'sortNewest' },
  { key: 'name', labelKey: 'sortName' },
]
const SORT_KEYS: SortKey[] = ['popular', 'newest', 'name']

export function TvPage() {
  const t = useT()
  const lang = useLang()
  const [params, setParams] = useSearchParams()

  // ?offair = 强制演示「信号丢失 → 退回游戏库」
  const forceOffline = params.get('offair') !== null
  const platformParam = (params.get('platform') as PlatformId | null) ?? undefined

  // ---- 直播信号 ----
  const [signal, setSignal] = useState<TvSignal | null>(null)
  const [signalState, setSignalState] = useState<'loading' | 'ready' | 'offline'>('loading')
  // 时钟只在客户端推进，避免和服务端首屏水合错位
  const [now, setNow] = useState(0)

  const loadSignal = useCallback(async () => {
    setSignalState('loading')
    const sig = await fetchTv(platformParam)
    setSignal(sig)
    setSignalState(sig.live && sig.pool.length ? 'ready' : 'offline')
  }, [platformParam])

  useEffect(() => {
    void loadSignal()
  }, [loadSignal])

  useEffect(() => {
    if (signalState !== 'ready') return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [signalState])

  const rotation =
    signal && signalState === 'ready' ? computeRotation(signal.pool, now, signal.segmentMs) : null

  // ---- 视图：直播 / 游戏库。信号丢失（或 ?offair 演示）时自动落到游戏库 ----
  const [view, setView] = useState<'live' | 'catalog'>(forceOffline ? 'catalog' : 'live')
  useEffect(() => {
    if (signalState === 'offline' && !forceOffline) setView('catalog')
  }, [signalState, forceOffline])

  const liveAvailable = !!rotation && !forceOffline

  useSeo({ title: t.tv.title, description: t.tv.tagline })

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
    if (key !== 'page') next.delete('page')
    setParams(next)
  }

  return (
    <div className="container-x py-8 sm:py-10">
      {/* 频道头 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-3xl" aria-hidden>📺</span>
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t.tv.title}</h1>
          </div>
          <p className="mt-1 text-sm text-muted">{t.tv.tagline}</p>
        </div>

        {/* 直播 / 游戏库 切换 */}
        <div className="inline-flex rounded-2xl border-2 border-line-strong bg-surface p-1">
          <button
            type="button"
            onClick={() => setView('live')}
            disabled={!liveAvailable && !forceOffline && signalState !== 'ready'}
            className={cx(
              'rounded-xl px-4 py-1.5 text-sm font-bold transition',
              view === 'live' ? 'bg-brand text-white' : 'text-muted hover:text-fg',
            )}
          >
            📺 {t.tv.live}
          </button>
          <button
            type="button"
            onClick={() => setView('catalog')}
            className={cx(
              'rounded-xl px-4 py-1.5 text-sm font-bold transition',
              view === 'catalog' ? 'bg-brand text-white' : 'text-muted hover:text-fg',
            )}
          >
            🎮 {t.tv.catalogTitle}
          </button>
        </div>
      </div>

      {/* 平台频道选择：直播时切节目池，游戏库时切筛选 */}
      <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <PlatformChip
          active={!platformParam}
          onClick={() => setParam('platform', '')}
          icon="📡"
          label={t.tv.allChannels}
        />
        {platforms
          .filter((p) => isPlatformEnabled(p.id))
          .map((p) => (
            <PlatformChip
              key={p.id}
              active={platformParam === p.id}
              onClick={() => setParam('platform', platformParam === p.id ? '' : p.id)}
              icon={p.icon}
              label={p.shortName}
            />
          ))}
      </div>

      {/* 视图内容 */}
      {view === 'live' ? (
        <LiveView
          t={t}
          lang={lang}
          signal={signal}
          signalState={signalState}
          rotation={rotation}
          now={now}
          onRetry={loadSignal}
          onBrowse={() => setView('catalog')}
          forceOffline={forceOffline}
        />
      ) : (
        <CatalogBrowser
          t={t}
          platform={platformParam}
          params={params}
          setParam={setParam}
          setParams={setParams}
        />
      )}
    </div>
  )
}

/* ============================ 直播视图 ============================ */

function LiveView({
  t,
  lang,
  signal,
  signalState,
  rotation,
  now,
  onRetry,
  onBrowse,
  forceOffline,
}: {
  t: ReturnType<typeof useT>
  lang: Lang
  signal: TvSignal | null
  signalState: 'loading' | 'ready' | 'offline'
  rotation: ReturnType<typeof computeRotation>
  now: number
  onRetry: () => void
  onBrowse: () => void
  forceOffline: boolean
}) {
  if (signalState === 'loading') {
    return <div className="tv-screen mt-6 aspect-video animate-pulse rounded-2xl bg-surface-2" aria-hidden />
  }

  // 信号丢失（或 ?offair 演示）：退回游戏库的提示 + 入口
  if (forceOffline || !rotation || signalState === 'offline') {
    return (
      <div className="mt-6 rounded-2xl border border-dashed border-line py-16 text-center">
        <p className="text-5xl" aria-hidden>📡</p>
        <p className="mt-3 text-pixel text-sm text-live">
          {forceOffline ? t.tv.offAirTitle : fmt(t.tv.invalidSignal, { status: signal?.reason ?? '503' })}
        </p>
        <h2 className="mt-2 text-xl font-extrabold">{t.tv.offAirTitle}</h2>
        <p className="mt-1 text-sm text-muted">{t.tv.offAirBody}</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={onRetry} variant="secondary" size="sm">{t.tv.offAirRetry}</Button>
          <Button onClick={onBrowse} size="sm">{t.tv.catalogTitle}</Button>
        </div>
      </div>
    )
  }

  const game = rotation.current
  const progress = rotationProgress(rotation, now)
  const ticker = `📺 8BitGo TV · ${gameTitle(game, lang)} · ${t.tv.tagline} · ${rotation.schedule
    .map((s) => gameTitle(s.game, lang))
    .join(' · ')} · `

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1.7fr_1fr]">
      {/* 左：电视屏幕 */}
      <div>
        <div className="tv-screen tv-scanlines tv-vignette tv-flicker relative aspect-video overflow-hidden rounded-2xl bg-black shadow-xl">
          <ScreenBackground game={game} iconClassName="text-7xl sm:text-8xl" />

          {/* 左上频道台标 */}
          <div className="absolute left-3 top-3 rounded-lg bg-black/55 px-2.5 py-1.5 backdrop-blur">
            <span className="text-pixel text-sm font-bold text-coin">📺 8BitGo TV</span>
          </div>

          {/* 右上 LIVE + 人数 */}
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-lg bg-live px-2.5 py-1.5 text-xs font-bold text-white shadow">
              <span className="h-2 w-2 rounded-full bg-white animate-blink" />
              {t.tv.live}
            </span>
          </div>
          {signal && (
            <div className="absolute right-3 top-14 rounded-lg bg-black/55 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
              👁 {fmt(t.tv.viewers, { n: signal.viewers })}
            </div>
          )}

          {/* 中间播放按钮 */}
          <Link
            to={`/games/${game.slug}`}
            className="group absolute inset-0 flex items-center justify-center"
            aria-label={fmt(t.tv.watchNow, {})}
          >
            <span className="grid h-16 w-16 place-items-center rounded-full bg-brand text-white shadow-lg shadow-brand/40 opacity-0 transition group-hover:scale-110 group-hover:opacity-100">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </Link>

          {/* 底部 Now Playing + 进度 */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-4">
            <p className="text-pixel text-[11px] text-coin">{t.tv.nowPlaying}</p>
            <p className="truncate text-lg font-extrabold text-white drop-shadow">{gameTitle(game, lang)}</p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/20">
              <div className="tv-progress h-full rounded-full bg-coin" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        </div>

        {/* 滚动字幕 */}
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface py-2">
          <div className="tv-marquee whitespace-nowrap text-sm text-muted">
            <span className="px-4">{ticker}</span>
            <span className="px-4" aria-hidden>{ticker}</span>
          </div>
        </div>
      </div>

      {/* 右：正在播出 + 节目单 */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-pixel text-xs text-coin">{t.tv.nowPlaying}</p>
          <div className="mt-2 flex items-start gap-3">
            <Link to={`/games/${game.slug}`} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl">
              <ScreenBackground game={game} iconClassName="text-3xl" />
            </Link>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-extrabold leading-tight">{gameTitle(game, lang)}</h3>
              <p className="mt-0.5 text-xs text-muted">
                {platformMap[game.platform]?.icon} {platformMap[game.platform]?.shortName}
                {game.genres[0] && ` · ${genreLabel(t, game.genres[0])}`}
                {game.year ? ` · ${game.year}` : ''}
              </p>
              <p className="mt-1 text-xs text-muted">🔥 {formatCount(game.plays)}</p>
            </div>
          </div>
          <Button to={`/games/${game.slug}`} className="mt-3 w-full">
            ▶ {t.tv.watchNow}
          </Button>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-pixel text-xs text-muted">{t.tv.upNext}</p>
          <ul className="mt-2 space-y-2">
            {rotation.schedule.map((item, i) => (
              <li key={`${item.game.slug}-${i}`}>
                <Link
                  to={`/games/${item.game.slug}`}
                  className="flex items-center gap-3 rounded-xl p-1.5 transition hover:bg-surface-2"
                >
                  <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                    <ScreenBackground game={item.game} iconClassName="text-2xl" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{gameTitle(item.game, lang)}</span>
                    <span className="block truncate text-xs text-muted">
                      {platformMap[item.game.platform]?.shortName}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-bold text-coin">{formatCountdown(item.startsAt - now)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

/** 屏幕背景：有封面用封面图（带缓慢推近），没有用程序化渐变 + emoji */
function ScreenBackground({ game, iconClassName }: { game: Game; iconClassName?: string }) {
  const coverSrc = game.cover ? romUrlForKey(game.cover) : ''
  if (coverSrc) {
    return <img src={coverSrc} alt="" className="tv-kenburns absolute inset-0 h-full w-full object-cover" />
  }
  return (
    <div
      className={cx('absolute inset-0 flex items-center justify-center drop-shadow', iconClassName)}
      style={{ background: gradientFor(game.slug) }}
      aria-hidden
    >
      {game.icon}
    </div>
  )
}

/* ============================ 游戏库（信号丢失时的备用节目） ============================ */

function CatalogBrowser({
  t,
  platform,
  params,
  setParam,
  setParams,
}: {
  t: ReturnType<typeof useT>
  platform: PlatformId | undefined
  params: URLSearchParams
  setParam: (key: string, value: string | null) => void
  setParams: (next: URLSearchParams) => void
}) {
  const q = params.get('q') ?? ''
  const letter = params.get('letter')
  const sortParam = (params.get('sort') as SortKey | null) ?? null
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : 'popular'
  const [qInput, setQInput] = useState(q)

  const query = {
    platform: platform ?? undefined,
    q,
    letter: letter ?? undefined,
    sort,
    page: 1,
  }

  const state = usePageData<GamesData>('/games', query, 'games')
  const list = state.data?.list

  const resetKey = JSON.stringify(query)
  const fetchMore = useCallback(
    async (nextPage: number) => {
      const d = await fetchPageData('/games', { ...query, page: nextPage })
      if (d.route !== 'games') throw new Error('unexpected route payload')
      return d.list
    },
    // query 每帧都是新对象，用指纹当依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey],
  )
  const inf = useInfinite({ first: list, ready: state.status === 'ready', fetchPage: fetchMore, resetKey })

  return (
    <div className="mt-6">
      <p className="text-sm text-muted">{t.tv.catalogSubtitle}</p>

      {/* 搜索 + 排序 */}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <form
          className="flex flex-1 items-center gap-2 rounded-2xl border-2 border-line-strong bg-surface px-3"
          onSubmit={(e) => {
            e.preventDefault()
            setParam('q', qInput.trim())
          }}
        >
          <span aria-hidden>🔍</span>
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder={t.tv.searchPlaceholder}
            className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-dim"
          />
        </form>
        <label className="flex items-center gap-2 text-sm text-muted">
          {t.games.sortLabel}
          <select
            value={sort}
            onChange={(e) => setParam('sort', e.target.value)}
            className="h-9 rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-brand focus:outline-none"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {t.games[s.labelKey]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* A-Z 首字母索引 */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setParam('letter', '')}
          className={chipClasses(!letter)}
        >
          {t.tv.allChannels}
        </button>
        {ALPHABET.map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => setParam('letter', letter === ch ? '' : ch)}
            className={chipClasses(letter === ch, 'h-8 w-8 justify-center px-0')}
          >
            {ch}
          </button>
        ))}
      </div>

      {/* 统计 */}
      <p className="mt-5 text-sm text-muted">
        {list ? fmt(t.tv.playableGames, { n: list.total }) : null}
      </p>

      {/* 结果 */}
      {state.status === 'error' ? (
        <div className="mt-6 rounded-2xl border border-dashed border-line py-16 text-center" role="alert">
          <p className="text-4xl" aria-hidden>📡</p>
          <p className="mt-3 font-semibold">{state.error}</p>
        </div>
      ) : !list ? (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-card bg-surface-2" />
          ))}
        </div>
      ) : inf.items.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {inf.items.map((g) => (
            <GameCard key={g.slug} game={g} coverRatio="square" />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed border-line py-16 text-center">
          <p className="text-4xl" aria-hidden>👾</p>
          <p className="mt-3 font-semibold">{t.games.emptyTitle}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => setParams(new URLSearchParams())}>
            {t.games.clearFilters}
          </Button>
        </div>
      )}

      <InfiniteFooter list={inf} pageSize={list?.pageSize ?? 24} />
    </div>
  )
}

/* ============================ 小组件 ============================ */

function PlatformChip({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={chipClasses(active)}>
      <span aria-hidden>{icon}</span> {label}
    </button>
  )
}
