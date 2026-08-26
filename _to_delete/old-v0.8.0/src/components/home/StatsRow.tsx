import { Link } from 'react-router-dom'
import { cx, formatCount } from '@/lib/format'
import { getDashboardMetrics, getStats } from '@/services/games'

/**
 * 首页顶部的 KPI 行。
 * 每个卡片 = 标签 + 数值 + 变化（带方向图标与对比周期，不只靠颜色）+ 可选迷你趋势线。
 */
export function StatsRow() {
  const stats = getStats()
  const m = getDashboardMetrics()

  return (
    <section className="container-x" aria-label="站点概览">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          icon="🟢"
          label="在线玩家"
          value={m.onlinePlayers}
          delta={{ pct: m.onlineDeltaPct, period: '较昨日同时' }}
          trend={m.onlineTrend}
        />
        <StatTile
          icon="🎮"
          label="今日游玩次数"
          value={m.playsToday}
          delta={{ pct: m.playsDeltaPct, period: '较昨日' }}
          trend={m.playsTrend}
        />
        <StatTile
          icon="📚"
          label="游戏总数"
          value={stats.games}
          note={`近两周新增 ${stats.addedRecently} 款 · ${stats.platforms} 个平台`}
          to="/games?sort=newest"
        />
        <StatTile
          icon="📺"
          label="正在直播"
          value={stats.liveStreams}
          note={`${formatCount(stats.liveViewers)} 人正在观看`}
          to="/#live"
          live
        />
      </div>
    </section>
  )
}

interface StatTileProps {
  icon: string
  label: string
  value: number
  delta?: { pct: number; period: string }
  note?: string
  trend?: number[]
  to?: string
  live?: boolean
}

function StatTile({ icon, label, value, delta, note, trend, to, live }: StatTileProps) {
  const body = (
    <div className="flex h-full flex-col justify-between gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <span aria-hidden>{icon}</span>
            {label}
            {live && <span className="h-1.5 w-1.5 rounded-full bg-live animate-blink" aria-hidden />}
          </p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight sm:text-3xl">{value.toLocaleString('zh-CN')}</p>
        </div>
        {trend && <Sparkline data={trend} className="mt-1 h-9 w-24 shrink-0 sm:w-28" />}
      </div>
      {delta ? (
        <p
          className={cx(
            'flex items-center gap-1 text-xs',
            delta.pct >= 0 ? 'text-online' : 'text-live',
          )}
        >
          <span aria-hidden>{delta.pct >= 0 ? '▲' : '▼'}</span>
          <span className="font-semibold">
            {delta.pct >= 0 ? '+' : ''}
            {delta.pct.toFixed(1)}%
          </span>
          <span className="text-muted">{delta.period}</span>
        </p>
      ) : (
        <p className="text-xs text-muted">{note}</p>
      )}
    </div>
  )

  const className = 'block rounded-card border border-line bg-surface p-4 transition hover:border-brand/50'
  return to ? (
    <Link to={to} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** 12 点迷你趋势线：整体用弱化色，最后一段用品牌色强调当前周期 */
function Sparkline({ data, className }: { data: number[]; className?: string }) {
  const w = 100
  const h = 32
  const pad = 2
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = pad + (1 - (v - min) / span) * (h - pad * 2)
    return [x, y] as const
  })
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <path d={path} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      {prev && (
        <path
          d={`M${prev[0].toFixed(1)} ${prev[1].toFixed(1)} L${last[0].toFixed(1)} ${last[1].toFixed(1)}`}
          fill="none"
          stroke="#a78bfa"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      )}
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="#a78bfa" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
