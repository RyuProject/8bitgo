import { openAuthModal } from '@/services/authModal'
import { Button } from '@/components/ui/Button'
import { GameCover } from '@/components/game/GameCover'
import { useGamesBySlugs } from '@/services/gameCache'
import { cx } from '@/lib/format'
import { useCurrentUser } from '@/services/auth'
import { FEATURES } from '@/config/features'
import { useT, fmt } from '@/services/i18n'
import type { Translation } from '@/locales'

/** 横幅里漂浮展示的封面 */
const HERO_GAMES = ['the-king-of-fighters-97', 'super-mario-world', 'pokemon-emerald']

/**
 * 首页 banner 位：位于标题 + 类型快捷入口之下。
 * 开启 G 币时左侧主横幅 + 右侧「每日任务」；关闭时主横幅占满整行。
 */
export function HomeBanner() {
  const t = useT()
  if (!FEATURES.coins) {
    return (
      <section className="container-x" aria-label={t.home.bannerAria}>
        <Banner />
      </section>
    )
  }
  return (
    <section className="container-x" aria-label={t.home.bannerAria}>
      <div className="grid gap-4 xl:grid-cols-12">
        <Banner className="xl:col-span-8" />
        <DailyTasks className="xl:col-span-4" />
      </div>
    </section>
  )
}

function Banner({ className }: { className?: string }) {
  const t = useT()
  // 这三款是写死的 slug，跟首页数据无关，所以走 gameCache 按需取；
  // 它只返回已经拿到的那部分，取数期间封面区先空着，文案和按钮照常显示
  const heroGames = useGamesBySlugs(HERO_GAMES)

  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-card border border-line bg-gradient-to-br from-brand/25 via-surface to-cyan-500/10',
        className,
      )}
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
            <span className="whitespace-nowrap bg-gradient-to-r from-brand-hover via-sky-400 to-cyan-300 bg-clip-text text-transparent">
              {t.home.headline2}
            </span>
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
            {t.home.subcopy}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button to="/games">
              <span aria-hidden>▶</span> {t.home.ctaPlay}
            </Button>
            <Button to="/play-local" variant="secondary">
              <span aria-hidden>📂</span> {t.home.ctaUpload}
            </Button>
          </div>
        </div>

        {/* 漂浮的封面 */}
        <div className="relative hidden h-44 w-56 shrink-0 md:block" aria-hidden>
          {heroGames.map((g, i) => (
            <div
              key={g.slug}
              className="animate-float absolute w-24 overflow-hidden rounded-xl border border-black/10 shadow-xl shadow-black/25"
              style={{
                left: `${[0, 50, 25][i]}%`,
                top: `${[10, 0, 30][i]}%`,
                transform: `rotate(${[-8, 6, -3][i]}deg)`,
                animationDelay: `${i * 1.3}s`,
                zIndex: [1, 2, 3][i],
              }}
            >
              <GameCover game={g} iconSize="sm" showTitle={false} priority />
            </div>
          ))}
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
