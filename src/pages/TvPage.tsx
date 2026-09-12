import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Game, PlatformId } from '@/types'
import type { Lang } from '@/config/languages'
import { platforms, platformMap } from '@/data/platforms'
import { isPlatformEnabled } from '@/config/platforms'
import { gameTitle } from '@/services/i18nData'
import { useT } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { useSeo } from '@/services/seo'
import { tvOrigin } from '@/services/tvHost'
import { romUrlForKey } from '@/services/roms'
import { cx } from '@/lib/format'
import { gradientFor } from '@/lib/gradients'
import { fetchTv, computeRotation, type TvSignal } from '@/services/tv'
import { fetchPageData } from '@/services/pageData'
import { FocusScope, useFocusable } from '@/components/tv/FocusScope'

/**
 * 8BitGo TV —— 十个脚下的 10-foot UI（客厅电视 / 投影）。
 *
 * 与桌面版最大的不同：没有软键盘这回事。所以这里**没有搜索框、没有 A-Z 字母索引、
 * 没有排序下拉**——那些在遥控器上都是折磨。取而代之的是：
 *
 *   - 顶部一条「正在播」：当前频道在放的那一款（驱动逻辑复用 /api/tv 的轮播信号）。
 *   - 下面按平台分行的「大磁贴墙」：每一行是一个平台，磁贴够大、够远，客厅沙发上看得清。
 *   - 整页交给焦点引擎（FocusScope）：方向键在屏幕上挑下一个（不是按 DOM 顺序），
 *     焦点自动滚入可视区并留 overscan 安全边距，粗焦点框，回车即播放。
 *
 * ?offair 仍可强制演示「信号丢失」——顶部变成离线提示，但下面的大磁贴墙照常能逛。
 */
export function TvPage() {
  const t = useT()
  const lang = useLang()
  const [params] = useSearchParams()

  // ?offair = 强制演示「信号丢失」
  const forceOffline = params.get('offair') !== null

  // ---- 直播信号：只用来驱动顶部「正在播」这一条 ----
  const [signal, setSignal] = useState<TvSignal | null>(null)
  const [signalState, setSignalState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [now, setNow] = useState(0)

  useEffect(() => {
    let active = true
    ;(async () => {
      setSignalState('loading')
      try {
        const sig = await fetchTv(undefined)
        if (!active) return
        setSignal(sig)
        setSignalState(sig.live && sig.pool.length ? 'ready' : 'offline')
      } catch {
        if (active) setSignalState('offline')
      }
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (signalState !== 'ready') return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [signalState])

  const rotation = signal && signalState === 'ready' ? computeRotation(signal.pool, now, signal.segmentMs) : null

  /*
    这一页的正牌地址在 TV 子域上（tv.8bitgo.com），不是主域的 /tv ——
    主域那条已经 301 过来了（见 shared/tv-host.js）。所以 canonical、og:url 和
    8 条 hreflang 都要指子域，三者必须一起换：只换 canonical 的话，hreflang 会把
    各语言版本都指回主域，canonical 说「我在子域」、hreflang 说「我的版本都在主域」，
    自己和自己打架。

    canonicalPath 写死 '/'：子域上这一页就挂在根上，而在本地开发（没跳转）时
    访问 /tv 渲染的也是它，两种情况都该归到同一个正牌地址。
    tvOrigin() 在没配 VITE_SITE_URL 时返回空串，那时退回默认行为（主域）。
  */
  useSeo({
    title: t.tv.title,
    description: t.tv.tagline,
    canonicalPath: '/',
    canonicalOrigin: tvOrigin(),
  })

  // ---- 大磁贴墙：每个平台拉一页热门，按平台分行 ----
  const { rows, error } = usePlatformWall(12)

  return (
    <div className="container-x py-8 sm:py-10">
      <header className="flex items-center gap-3">
        <span className="text-3xl" aria-hidden>📺</span>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t.tv.title}</h1>
      </header>
      <p className="mt-1 text-sm text-muted">{t.tv.tagline}</p>
      <p className="mt-2 text-xs text-dim">用方向键浏览 · 回车播放（电视遥控器同样适用）</p>

      <FocusScope initialId="nowplaying" className="mt-6">
        {/* 顶部「正在播」一条 */}
        {!rotation || forceOffline || signalState === 'offline' ? (
          <div className="flex h-48 items-center justify-center rounded-2xl border-2 border-dashed border-line text-center sm:h-60">
            <div>
              <p className="text-5xl" aria-hidden>📡</p>
              <p className="mt-2 font-extrabold text-live">{t.tv.offAirTitle}</p>
              <p className="text-sm text-muted">{t.tv.offAirBody}</p>
            </div>
          </div>
        ) : (
          <NowPlaying game={rotation.current} lang={lang} t={t} />
        )}

        {/* 按平台分行的大磁贴墙 */}
        <div className="mt-8 space-y-8">
          {!rows ? (
            error ? (
              <p className="rounded-2xl border border-dashed border-line py-16 text-center text-muted">{error}</p>
            ) : (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-48 animate-pulse rounded-2xl bg-surface-2" />
              ))
            )
          ) : (
            rows.map((row) => <PlatformRow key={row.id} row={row} lang={lang} />)
          )}
        </div>
      </FocusScope>
    </div>
  )
}

/* ============================ 顶部「正在播」 ============================ */

function NowPlaying({ game, lang, t }: { game: Game; lang: Lang; t: ReturnType<typeof useT> }) {
  const { focused, setFocus } = useFocusable('nowplaying')
  return (
    <Link
      to={`/games/${game.slug}`}
      data-focus-id="nowplaying"
      onMouseEnter={setFocus}
      aria-label={t.tv.watchNow}
      className={cx(
        'group relative block h-56 overflow-hidden rounded-2xl border-2 transition sm:h-72',
        focused ? 'z-10 border-coin ring-4 ring-coin' : 'border-transparent',
      )}
    >
      <ScreenBackground game={game} iconClassName="text-8xl sm:text-9xl" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-lg bg-black/55 px-2.5 py-1.5 backdrop-blur">
        <span className="h-2 w-2 rounded-full bg-live animate-blink" />
        <span className="text-pixel text-sm font-bold text-coin">正在播 · {t.tv.live}</span>
      </div>
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="truncate text-2xl font-extrabold text-white drop-shadow sm:text-3xl">{gameTitle(game, lang)}</p>
        <p className="mt-1 text-sm text-white/80">
          {platformMap[game.platform]?.icon} {platformMap[game.platform]?.shortName}
          {game.year ? ` · ${game.year}` : ''}
        </p>
        <span className="mt-3 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-bold text-white">
          ▶ {t.tv.watchNow}
        </span>
      </div>
    </Link>
  )
}

/* ============================ 平台行 + 大磁贴 ============================ */

function PlatformRow({ row, lang }: { row: PlatformRow; lang: Lang }) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 px-1 text-lg font-extrabold">
        <span aria-hidden>{row.icon}</span>
        {row.name}
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {row.items.map((g) => (
          <WallTile key={g.slug} id={`${row.id}:${g.slug}`} game={g} lang={lang} />
        ))}
        <div className="w-2 shrink-0" aria-hidden />
      </div>
    </section>
  )
}

function WallTile({ id, game, lang }: { id: string; game: Game; lang: Lang }) {
  const { focused, setFocus } = useFocusable(id)
  return (
    <Link
      to={`/games/${game.slug}`}
      data-focus-id={id}
      onMouseEnter={setFocus}
      aria-label={gameTitle(game, lang)}
      className={cx(
        'group relative block w-[150px] shrink-0 overflow-hidden rounded-xl border-2 transition sm:w-[180px]',
        focused ? 'z-10 scale-[1.06] border-coin ring-4 ring-coin' : 'border-transparent',
      )}
    >
      <div className="aspect-[3/4] w-full">
        <ScreenBackground game={game} iconClassName="text-5xl sm:text-6xl" />
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2">
        <p className="truncate text-sm font-bold text-white">{gameTitle(game, lang)}</p>
        <p className="truncate text-[11px] text-white/70">{platformMap[game.platform]?.shortName}</p>
      </div>
    </Link>
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

/* ============================ 数据：按平台分行 ============================ */

interface PlatformRow {
  id: PlatformId
  name: string
  icon: string
  items: Game[]
}

/**
 * 每个启用的平台各拉一页热门，拼成「一行一个平台」的墙。
 * 一次并行请求就够（平台数不大），单个平台失败不影响其他行。
 */
function usePlatformWall(per: number) {
  const [rows, setRows] = useState<PlatformRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const enabled = platforms.filter((p) => isPlatformEnabled(p.id))
    Promise.all(
      enabled.map(async (p) => {
        try {
          const d = await fetchPageData('/games', { platform: p.id, sort: 'popular', page: 1, pageSize: per })
          const items = d.route === 'games' ? d.list.items.slice(0, per) : []
          return { id: p.id, name: p.name, icon: p.icon, items }
        } catch {
          return { id: p.id, name: p.name, icon: p.icon, items: [] as Game[] }
        }
      }),
    )
      .then((res) => {
        if (!cancelled) setRows(res.filter((r) => r.items.length > 0))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [per])

  return { rows, error }
}
