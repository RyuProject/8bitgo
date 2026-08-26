import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { GameCover } from '@/components/game/GameCover'
import { getGamesBySlugs } from '@/services/games'
import { cx } from '@/lib/format'
import { useCurrentUser } from '@/services/auth'

const HERO_GAMES = ['the-king-of-fighters-97', 'super-mario-world', 'pokemon-emerald']

/** 仪表盘风格的紧凑横幅 + 每日任务小组件 */
export function DashboardHero() {
  return (
    <section className="container-x">
      <div className="grid gap-4 xl:grid-cols-12">
        <Banner className="xl:col-span-8" />
        <DailyTasks className="xl:col-span-4" />
      </div>
    </section>
  )
}

function Banner({ className }: { className?: string }) {
  const heroGames = getGamesBySlugs(HERO_GAMES)
  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-card border border-line bg-gradient-to-br from-brand/30 via-surface to-pink-500/15',
        className,
      )}
    >
      <div className="pixel-grid absolute inset-0 opacity-40 [mask-image:linear-gradient(to_right,black,transparent)]" aria-hidden />
      <div className="relative flex min-h-[220px] items-center justify-between gap-6 p-6 sm:p-8">
        <div className="max-w-lg">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-[11px] font-semibold text-brand-hover">
            <span aria-hidden>🕹️</span> 无需下载 · 打开浏览器直接玩
          </span>
          <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl lg:text-4xl">
            免费在线畅玩
            <br />
            <span className="whitespace-nowrap bg-gradient-to-r from-brand-hover via-pink-400 to-coin bg-clip-text text-transparent">
              经典模拟器游戏
            </span>
          </h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
            红白机、超任、GBA、PS1、N64、街机……上百款童年经典，支持即时存档、手柄与联机同乐。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button to="/games">
              <span aria-hidden>▶</span> 开始游玩
            </Button>
            <Button to="/play-local" variant="secondary">
              <span aria-hidden>📂</span> 上传本地 ROM
            </Button>
          </div>
        </div>

        {/* 右侧漂浮封面 */}
        <div className="relative hidden h-44 w-56 shrink-0 md:block" aria-hidden>
          {heroGames.map((g, i) => (
            <div
              key={g.slug}
              className="absolute w-24 overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/60 animate-float"
              style={{
                left: `${[0, 50, 25][i]}%`,
                top: `${[10, 0, 30][i]}%`,
                transform: `rotate(${[-8, 6, -3][i]}deg)`,
                animationDelay: `${i * 1.3}s`,
                zIndex: [1, 2, 3][i],
              }}
            >
              <GameCover game={g} iconSize="sm" showTitle={false} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const TASKS = [
  { icon: '🎮', title: '玩一局任意游戏', reward: 10, done: 0, total: 1 },
  { icon: '🏁', title: '通关一款经典游戏', reward: 50, done: 0, total: 1 },
  { icon: '👥', title: '与好友联机对战 2 局', reward: 30, done: 0, total: 2 },
  { icon: '🧭', title: '在一个新平台上玩一局', reward: 20, done: 0, total: 1 },
]

function DailyTasks({ className }: { className?: string }) {
  const user = useCurrentUser()
  const total = TASKS.reduce((s, t) => s + t.reward, 0)
  const earned = TASKS.filter((t) => t.done >= t.total).reduce((s, t) => s + t.reward, 0)
  const pct = Math.round((earned / total) * 100)

  return (
    <div className={cx('flex flex-col rounded-card border border-line bg-surface p-5', className)}>
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <span aria-hidden>📋</span> 每日任务
        </h2>
        <span className="text-xs text-muted">每日 00:00 刷新</span>
      </div>

      <ul className="mt-4 flex-1 space-y-2">
        {TASKS.map((t) => (
          <li key={t.title} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft" aria-hidden>
              {t.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.title}</span>
              <span className="block text-[11px] text-muted">
                进度 {t.done}/{t.total}
              </span>
            </span>
            <span className="shrink-0 rounded-md bg-coin-soft px-1.5 py-0.5 text-[11px] font-semibold text-coin">
              +{t.reward}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">今日已获得</span>
          <span className="font-semibold text-coin">
            🪙 {earned} / {total} G币
          </span>
        </div>
        {/* 进度条：填充用金币色，轨道用同色系更浅的一档 */}
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-coin/15" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="每日任务进度">
          <div className="h-full rounded-full bg-coin transition-[width]" style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
        {user ? (
          <p className="mt-3 text-[11px] text-muted">
            {user.avatar} {user.nickname}，当前余额 <span className="font-semibold text-coin">{user.coins} G 币</span>。任务结算功能开发中。
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-muted">
            <Link to="/login" className="font-semibold text-brand-hover hover:underline">
              登录
            </Link>{' '}
            后自动记录任务进度并结算 G 币。
          </p>
        )}
      </div>
    </div>
  )
}
