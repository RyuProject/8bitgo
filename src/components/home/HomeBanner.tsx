import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { openAuthModal } from '@/services/authModal'
import { PixelButton } from '@/components/ui/PixelButton'
import { GameCover } from '@/components/game/GameCover'
import { useGamesBySlugs } from '@/services/gameCache'
import { cx } from '@/lib/format'
import { useCurrentUser } from '@/services/auth'
import { FEATURES } from '@/config/features'
import { useT, fmt } from '@/services/i18n'
import { useLang } from '@/services/lang'
import { gameTitle } from '@/services/i18nData'
import type { Game } from '@/types'
import type { Translation } from '@/locales'

/**
 * 首页热门还没到货时先顶上的几款。取不到的（不存在 / 已下架）自动跳过，
 * 所以这串写多了也不会在页面上留空位。
 */
const HERO_FALLBACK = ['the-king-of-fighters-97', 'super-mario-world', 'pokemon-emerald']
/** 热门到货后就不用再为兜底那几款发请求了。模块级常量，免得每次渲染都换个新数组 */
const NO_SLUGS: string[] = []

/** 多久换一款 */
const ROTATE_MS = 5000
/** 卡堆最多同时摞几张 */
const STACK_MAX = 3
/** 轮换名单最多取几款。热门一栏有几十上百款，全放进来转一圈要好几分钟，等于没人看得到第二款 */
const POOL_MAX = 8

/**
 * 卡堆里第 n 层的位置、角度、缩放和透明度。
 * 写成常量表而不是按 index 算，是因为这几个角度是调出来的 ——
 * 公式生成的等差角度看着像贴纸，手挑的才像随手扔的一摞卡。
 *
 * x / y 是**百分比**（相对卡片自身宽高），不是像素：卡片尺寸按断点变（见下面的
 * CARD / STACK_BOX），写死像素的话大屏上那点偏移会被缩成一条边，卡堆就摊平了。
 * 这几个数是原来给 112px 卡调出来的偏移换算过来的（-18/112 ≈ -16%，以此类推）。
 */
const DEPTH = [
  { x: 0, y: 0, rotate: -4, scale: 1, opacity: 1 },
  { x: -16, y: 12.5, rotate: 7, scale: 0.93, opacity: 0.78 },
  { x: -30, y: 24, rotate: -12, scale: 0.86, opacity: 0.5 },
]

/**
 * 卡堆的占位框与卡片宽度。
 *
 * 框只负责在这一行里占位（卡片是绝对定位的，超出去也不会被框裁掉），
 * 所以框比卡片大一圈：卡片最多旋转 12°、还要往左下错开 30%，
 * 大约要 1.5 倍卡宽才不至于压到左边的文案。
 * 卡片用容器宽度的百分比，改框的尺寸就够了，不用两处一起调。
 */
// md / lg 上这一行还要塞下左边的标题和文案，所以先小一档，宽屏（xl）才放到最大
const STACK_BOX = 'h-56 w-64 lg:h-64 lg:w-72 xl:h-80 xl:w-96'
const CARD = 'w-[55%]'

/**
 * 系统「减弱动态效果」。
 *
 * SSR 时读不到媒体查询，先按「不减弱」渲染，挂载后再纠正 —— 反过来的话，
 * 大多数用户会先看到静态首屏再突然动起来，比晚一帧关掉动画更抖。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}

/**
 * 首页 banner 位：位于标题 + 类型快捷入口之下。
 * 开启 G 币时左侧主横幅 + 右侧「每日任务」；关闭时主横幅占满整行。
 */
export function HomeBanner({ games }: { games?: Game[] }) {
  const t = useT()
  if (!FEATURES.coins) {
    return (
      <section className="container-x" aria-label={t.home.bannerAria}>
        <Banner games={games} />
      </section>
    )
  }
  return (
    <section className="container-x" aria-label={t.home.bannerAria}>
      <div className="grid gap-4 xl:grid-cols-12">
        <Banner games={games} className="xl:col-span-8" />
        <DailyTasks className="xl:col-span-4" />
      </div>
    </section>
  )
}

function Banner({ className, games }: { className?: string; games?: Game[] }) {
  const t = useT()
  const lang = useLang()
  const reduced = usePrefersReducedMotion()

  /**
   * 轮换名单。
   *
   * 热门那一栏就是「库里已经有的游戏」，所以优先用它 —— 上了新游戏、后台调了精选位，
   * 横幅跟着变，不用改代码。但 HomeBanner 是贴着页面顶渲染的，比首页那次取数早，
   * 所以数据到货前先用写死的 slug 顶着（走 gameCache 按需取），首屏不会空着一块。
   * 热门一到就把参数换成空数组，兜底那几款不再花请求。
   */
  const fallback = useGamesBySlugs(games?.length ? NO_SLUGS : HERO_FALLBACK)
  const pool = useMemo(() => (games?.length ? games : fallback).slice(0, POOL_MAX), [games, fallback])

  /** 轮换序号，只增不减。取模拿当前那款，减去层数就是卡堆里压着的那几款 */
  const [seq, setSeq] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    // 只有一款可转的时候别起定时器：动画会原地重放，看着像闪
    if (reduced || paused || pool.length < 2) return
    const timer = window.setInterval(() => {
      // 后台标签页不推进。不挡的话切回来会一次性补上十几轮，卡堆直接跳到不知道哪一款
      if (document.hidden) return
      setSeq((v) => v + 1)
    }, ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [reduced, paused, pool.length])

  const current = pool.length ? pool[seq % pool.length] : null
  // 名单还没到的时候保留原来那句品牌语，别让标题空着或者闪一下
  const headline = current ? gameTitle(current, lang) : t.home.headline2

  /**
   * 卡堆：第 0 层是当前这款，往下依次是前几轮的。
   * key 用 seq 而不是 slug —— 只有 key 变了 React 才会重新挂载，抛卡动画才会重放；
   * 名单只有一两款时同一个 slug 会连着出现，用 slug 当 key 就永远不动了。
   */
  const stack = useMemo(() => {
    if (!pool.length) return []
    const out: { game: Game; key: number; depth: number }[] = []
    for (let depth = 0; depth < Math.min(STACK_MAX, pool.length); depth++) {
      const n = seq - depth
      if (n < 0) break
      out.push({ game: pool[n % pool.length], key: n, depth })
    }
    return out
  }, [pool, seq])

  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-card border border-line bg-gradient-to-br from-brand/25 via-surface to-cyan-500/10',
        className,
      )}
      // 指针移上来或者键盘焦点进来就停下。自动轮换的内容必须能停，
      // 否则读到一半标题就换了 —— 想点那张封面时它也正好被抛走
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="pixel-grid absolute inset-0 opacity-40 [mask-image:linear-gradient(to_right,black,transparent)]" aria-hidden />

      <div className="relative flex min-h-[220px] items-center justify-between gap-6 p-6 sm:p-8">
        <div className="max-w-lg">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-[11px] font-semibold text-brand-hover">
            <span aria-hidden>🕹️</span> {t.home.pill}
          </span>
          <h2 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl lg:text-4xl">
            {t.home.headline1}
            <br />
            {/* 至少占满一行。名字长短差得多（《魂斗罗》和 The King of Fighters '97 不是一个
                量级），偶尔会折成两行 —— 那一行的高度由右边那摞封面（STACK_BOX + 上下内边距）
                兜着，撑不破这一行，所以这里只保底一行，不预留两行去换一块空当出来 */}
            <span className="block min-h-[1.15em]">
              <span
                key={seq}
                className="hero-title animate-hero-title inline-block bg-gradient-to-r from-brand-hover via-sky-400 to-cyan-300 bg-clip-text text-transparent"
              >
                {headline}
              </span>
            </span>
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
            {t.home.subcopy}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <PixelButton to="/games" tone="green">
              <span aria-hidden>▶</span>
              <span className="text-[#fcfae5]">{t.home.ctaPlay}</span>
            </PixelButton>
            <PixelButton to="/play-local">
              <img src="/ui/run-my-rom.svg" alt="" className="h-5 w-5 object-contain [image-rendering:pixelated]" aria-hidden />
              <span>{t.home.ctaUpload}</span>
            </PixelButton>
          </div>
        </div>

        {/* 抛上来的封面堆。每张都是通往那款游戏的链接，不是装饰，所以不能 aria-hidden */}
        <div className={cx('relative hidden shrink-0 md:block', STACK_BOX)}>
          {/* 倒着渲染：DOM 里后出现的压在上面，和 z-index 说的是同一件事，
              这样即使 z-index 失效（比如某个祖先建了新的层叠上下文）叠放顺序也还是对的 */}
          {[...stack].reverse().map(({ game, key, depth }) => {
            const d = DEPTH[Math.min(depth, DEPTH.length - 1)]
            return (
              <div
                key={key}
                className={cx('hero-card absolute left-1/2 top-1/2 transition-[transform,opacity] duration-500 ease-out', CARD)}
                style={{
                  // 居中 + 该层的偏移一起写在这儿；抛入动画放在里层，两者互不覆盖
                  transform: `translate(-50%, -50%) translate(${d.x}%, ${d.y}%) rotate(${d.rotate}deg) scale(${d.scale})`,
                  opacity: d.opacity,
                  zIndex: 30 - depth * 10,
                }}
              >
                <div className={depth === 0 ? 'hero-toss animate-hero-toss' : undefined}>
                  <Link
                    to={`/games/${game.slug}`}
                    aria-label={fmt(t.home.heroPlay, { name: gameTitle(game, lang) })}
                    className="block overflow-hidden rounded-xl border border-black/10 shadow-xl shadow-black/25 outline-offset-4 transition-transform hover:scale-[1.04] focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    {/* 只给第一张 priority：它是首屏 LCP 的候选，后面每 5 秒新抛的那些
                        再标高优先级就等于没分优先级了 */}
                    <GameCover game={game} ratio="square" iconSize="md" showTitle={false} priority={key === 0} />
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface Task {
  icon: string
  title: string
  reward: number
  done: number
  total: number
}

/** 演示用任务列表；任务结算功能尚未接入 */
function tasksFor(t: Translation): Task[] {
  return [
    { icon: '🎮', title: t.tasks.t1, reward: 10, done: 0, total: 1 },
    { icon: '🏁', title: t.tasks.t2, reward: 50, done: 0, total: 1 },
    { icon: '👥', title: t.tasks.t3, reward: 30, done: 0, total: 2 },
    { icon: '🧭', title: t.tasks.t4, reward: 20, done: 0, total: 1 },
  ]
}

function DailyTasks({ className }: { className?: string }) {
  const t = useT()
  const user = useCurrentUser()
  const tasks = tasksFor(t)
  const total = tasks.reduce((s, task) => s + task.reward, 0)
  const earned = tasks.filter((task) => task.done >= task.total).reduce((s, task) => s + task.reward, 0)
  const pct = Math.round((earned / total) * 100)

  return (
    <div className={cx('flex flex-col rounded-card border border-line bg-surface p-5', className)}>
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <span aria-hidden>📋</span> {t.tasks.title}
        </h2>
        <span className="text-xs text-muted">{t.tasks.refresh}</span>
      </div>

      <ul className="mt-4 flex-1 space-y-2">
        {tasks.map((task) => (
          <li key={task.title} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft" aria-hidden>
              {task.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{task.title}</span>
              <span className="block text-[11px] text-muted">
                {fmt(t.tasks.progress, { done: task.done, total: task.total })}
              </span>
            </span>
            <span className="shrink-0 whitespace-nowrap rounded-md bg-coin-soft px-1.5 py-0.5 text-[11px] font-semibold text-coin">
              +{task.reward}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">{t.tasks.earnedToday}</span>
          <span className="font-semibold text-coin">
            {fmt(t.tasks.earnedAmount, { earned, total })}
          </span>
        </div>
        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-coin/15"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t.tasks.progressAria}
        >
          <div className="h-full rounded-full bg-coin transition-[width]" style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
        {user ? (
          <p className="mt-3 text-[11px] text-muted">
            {fmt(t.tasks.loggedIn, { avatar: user.avatar, nickname: user.nickname, coins: user.coins })}
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-muted">
            <button type="button" onClick={openAuthModal} className="font-semibold text-brand-hover hover:underline">
              {t.common.login}
            </button>{' '}
            {t.tasks.guestSuffix}
          </p>
        )}
      </div>
    </div>
  )
}
