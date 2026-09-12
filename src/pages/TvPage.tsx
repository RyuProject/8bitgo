import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Game, PlatformId } from '@/types'
import type { Lang } from '@/config/languages'
import { platforms, platformMap } from '@/data/platforms'
import { isPlatformEnabled } from '@/config/platforms'
import { gameDescription, gameTitle } from '@/services/i18nData'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { useSeo } from '@/services/seo'
import { tvOrigin } from '@/services/tvHost'
import { romUrlForKey } from '@/services/roms'
import { cx } from '@/lib/format'
import { gradientFor } from '@/lib/gradients'
import { fetchTv, computeRotation, type TvSignal } from '@/services/tv'
import { fetchPageData } from '@/services/pageData'
import { FocusScope, useFocusable, useFocusedId } from '@/components/tv/FocusScope'
import { TvPlay } from '@/components/tv/TvPlay'
import { enterFullscreen } from '@/lib/fullscreen'

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
  const [params, setParams] = useSearchParams()

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

  /*
    ---- 开玩：`?play=<slug>` 把这一屏整个换成满窗口的播放器 ----

    ⚠️ 2026-09-12 改的是**落点**，不是把全屏拿掉。上一版是「跳详情页 + enterFullscreen()」，
    毛病在详情页这个落点上：
      · 整页全屏之后播放器还是待在自己那个按比例的框里，下面照样跟着评论、键位表、
        相关推荐 —— 屏幕变大了，播放器并没有「占满」。
      · 车机和不少电视浏览器根本没有 Fullscreen API（fullscreenEnabled === false），
        失败被吞掉之后，那些设备上就只是一个普通详情页，什么都没占满。

    现在是两层叠着：
      地基 —— `?play=` 切到 TvPlay，播放器用 fill + h-dvh 吃满**浏览器窗口**，不要任何权限；
      锦上添花 —— 列表项的 onClick 顺手要一次整页全屏，把浏览器自己的地址栏也去掉，
                  要不到就算了（见下面 ListRow 那段注释和 lib/fullscreen.ts）。

    用查询串而不是另开一条路由：返回键天然能用（历史里有这一条）、退回来列表还是热的、
    也不多一个能被收录的地址 —— 这一屏是个动作，不是一篇内容。
  */
  const playSlug = params.get('play') ?? ''
  /** 退回列表时把焦点还给刚才按下去的那一款，而不是甩回最上面 */
  const lastPlayed = useRef('')
  if (playSlug) lastPlayed.current = playSlug
  const exitPlay = useCallback(() => {
    const next = new URLSearchParams(params)
    next.delete('play')
    // replace：不然从列表按「返回」又会掉回播放器里，出不去
    setParams(next, { replace: true })
  }, [params, setParams])

  // ---- 平台筛选 + 当前列表 ----
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const list = !rows ? [] : platform === 'all' ? rows.flatMap((r) => r.items) : (rows.find((r) => r.id === platform)?.items ?? [])

  /*
    整屏不滚。

    电视和车机上「往下滚还有内容」是一条走不通的路：遥控器没有滚轮，
    车机屏幕在行驶中根本不该要求人去翻页。所以这一页是**一屏**：
    h-dvh + overflow-hidden，真正会滚的只有左边那列表自己（焦点移动时由
    FocusScope 的 ensureVisible 带着走）。

    四周的 padding 是 overscan 安全边距：老电视会把画面边缘裁掉一圈，
    贴边的字在客厅里是看不到的。
  */
  if (playSlug) return <TvPlay slug={playSlug} onExit={exitPlay} />

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg px-8 py-6 sm:px-12 sm:py-8">
      <FocusScope
        initialId={lastPlayed.current ? `game:${lastPlayed.current}` : 'plat:all'}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* ── 顶栏：站名 + 正在播 + 平台筛选 ── */}
        <header className="shrink-0">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-pixel text-xl font-extrabold tracking-widest text-fg sm:text-2xl">{t.tv.title}</h1>
            {rotation && !forceOffline && signalState === 'ready' ? (
              <NowPlayingChip game={rotation.current} lang={lang} t={t} />
            ) : signalState === 'offline' || forceOffline ? (
              <span className="text-xs text-dim">{t.tv.offAirTitle}</span>
            ) : null}
          </div>

          {/* 平台筛选：横排一行，方向键走得到 */}
          <nav className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <FilterChip id="plat:all" label={t.tv.allChannels} active={platform === 'all'} onPick={() => setPlatform('all')} />
            {(rows ?? []).map((r) => (
              <FilterChip
                key={r.id}
                id={`plat:${r.id}`}
                label={r.name}
                active={platform === r.id}
                onPick={() => setPlatform(r.id)}
              />
            ))}
          </nav>
          <p className="mt-2 text-[11px] tracking-widest text-dim">
            {fmt(t.tv.playableGames, { n: list.length })} · 方向键选择 · 回车开始
          </p>
        </header>

        {/* ── 主体：左列表 + 右大图。两边都不撑高页面，超出的部分列表自己滚 ── */}
        <div className="mt-5 grid min-h-0 flex-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ul className="min-h-0 overflow-y-auto pr-2">
            {!rows
              ? Array.from({ length: 8 }).map((_, i) => (
                  <li key={i} className="my-2 h-8 animate-pulse rounded bg-surface-2" />
                ))
              : list.map((g) => <ListRow key={g.slug} game={g} lang={lang} />)}
            {rows && !list.length && <li className="py-8 text-muted">{error ?? t.tv.offAirBody}</li>}
          </ul>

          {/* 右边这块**不可聚焦**：它是左边焦点的放大镜，不是一个可以走进去的地方 */}
          <Preview games={list} lang={lang} t={t} />
        </div>
      </FocusScope>
    </div>
  )
}

/* ============================ 顶部「正在播」 ============================ */

/**
 * ⚠️ 凡是挂了 `data-focus-id` 的元素，FocusScope 都会把它算成焦点候选
 * （见那个文件里 `querySelectorAll('[data-focus-id]')`）。所以**挂了 id 就必须
 * 用 useFocusable 画出焦点态** —— 否则方向键走到它身上时屏幕上什么都不亮，
 * 用户看到的是「焦点凭空消失了」，再按一下又从别处冒出来。
 * 这一条比它看起来重要：电视上没有鼠标指针兜底，焦点是唯一的位置感来源。
 */
function NowPlayingChip({ game, lang, t }: { game: Game; lang: Lang; t: ReturnType<typeof useT> }) {
  const { focused, setFocus } = useFocusable('nowplaying')
  return (
    <Link
      to={`?play=${encodeURIComponent(game.slug)}`}
      onClick={() => enterFullscreen()}
      data-focus-id="nowplaying"
      onMouseEnter={setFocus}
      className={cx(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition',
        focused ? 'border-coin text-fg outline outline-2 outline-offset-2 outline-coin' : 'border-line text-muted',
      )}
    >
      <span className="h-2 w-2 rounded-full bg-live animate-blink" aria-hidden />
      {t.tv.nowPlaying} · <span className="font-bold text-fg">{gameTitle(game, lang)}</span>
    </Link>
  )
}

/* ============================ 顶部筛选 ============================ */

function FilterChip({ id, label, active, onPick }: { id: string; label: string; active: boolean; onPick: () => void }) {
  const { focused, setFocus } = useFocusable(id)
  return (
    <button
      type="button"
      data-focus-id={id}
      onMouseEnter={setFocus}
      onClick={onPick}
      aria-pressed={active}
      className={cx(
        'text-sm tracking-widest transition',
        active ? 'font-bold text-fg' : 'text-dim hover:text-muted',
        // 焦点框要粗、要高对比：客厅里离屏幕三米，细边框是看不见的
        focused && 'rounded px-1 text-fg outline outline-2 outline-offset-4 outline-coin',
      )}
    >
      {label}
    </button>
  )
}

/* ============================ 左：游戏列表 ============================ */

function ListRow({ game, lang }: { game: Game; lang: Lang }) {
  const id = `game:${game.slug}`
  const { focused, setFocus } = useFocusable(id)
  return (
    <li>
      {/*
        回车（或点击）= 直接开玩。

        两件事叠着做，**分工别搞反**：
          · `to` 指向本页的 `?play=` —— 这是地基：播放器吃满浏览器窗口（TvPlay 的 fill + h-dvh），
            不需要任何权限，车机和老电视浏览器上一样成立。
          · `onClick` 顺手要一次整页全屏 —— 这是锦上添花：窗口占满了，浏览器自己的
            地址栏/标签栏还在，全屏能把那一圈也去掉。**要不到就算了**（enterFullscreen 内部全吞），
            界面不会因此少任何东西。

        ⚠️ 全屏必须挂在 onClick 上：它要 transient activation，而 FocusScope 的回车是
        `el.click()` 派发的，同步落在同一个 keydown 手势里。挪进 useEffect 就静默失败。
        ⚠️ 跳转必须是 <Link>（同文档路由）：整页重载会把刚进的全屏丢掉。别换成 <a>。
        这两条的出处是 lib/fullscreen.ts 的文件头。
      */}
      <Link
        to={`?play=${encodeURIComponent(game.slug)}`}
        onClick={() => enterFullscreen()}
        data-focus-id={id}
        onMouseEnter={setFocus}
        className={cx(
          'flex items-center gap-3 rounded-lg px-2 py-2 text-lg transition sm:text-xl',
          focused ? 'bg-surface-2 font-bold text-fg outline outline-2 outline-coin' : 'text-muted',
        )}
      >
        <span aria-hidden className={cx('h-1.5 w-1.5 shrink-0 rounded-full', focused ? 'bg-coin' : 'bg-line')} />
        <span className="truncate">{gameTitle(game, lang)}</span>
      </Link>
    </li>
  )
}

/* ============================ 右：跟着焦点的大图 ============================ */

function Preview({ games, lang, t }: { games: Game[]; lang: Lang; t: ReturnType<typeof useT> }) {
  const focusedId = useFocusedId()
  /*
    焦点在筛选行上（还没进列表）时，预览就显示列表第一款 —— 留一块空白
    更糟：这块占了半个屏幕，空着的时候整页看起来像没加载出来。
  */
  const slug = focusedId?.startsWith('game:') ? focusedId.slice('game:'.length) : ''
  const game = games.find((g) => g.slug === slug) ?? games[0]
  if (!game) return <div aria-hidden />

  const plat = platformMap[game.platform]
  return (
    <div className="hidden min-h-0 flex-col justify-center lg:flex">
      <div className="relative mx-auto aspect-[4/3] w-full max-w-xl overflow-hidden rounded-2xl border border-line">
        <ScreenBackground game={game} iconClassName="text-8xl" />
        <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-[11px] font-bold tracking-widest text-white backdrop-blur">
          {plat?.shortName}
        </div>
      </div>
      <div className="mx-auto mt-4 w-full max-w-xl">
        <p className="truncate text-2xl font-extrabold text-fg">{gameTitle(game, lang)}</p>
        <p className="mt-1 text-sm text-muted">
          {plat?.icon} {plat?.name}
          {game.year ? ` · ${game.year}` : ''}
        </p>
        <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-dim">{gameDescription(game, lang)}</p>
        <span className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-white">
          ▶ {t.tv.watchNow}
        </span>
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
