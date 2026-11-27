import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { btnClass, Card } from './ui'
import type { DataState } from './AdminLayout'
import { hasHealthError, useAdminHealth } from './adminHealth'

function timeLabel(value: string | null | undefined) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

const levelStyle = {
  error: 'border-live/40 bg-live/10 text-live',
  warn: 'border-[color:var(--color-coin)]/40 bg-[color:var(--color-coin-soft)] text-fg',
  info: 'border-line bg-surface-2 text-muted',
}

/** 只给站点管理员看的运营汇总；重任务仍由服务端队列执行，离开此页不会中断。 */
export function SiteHealthPanel({ dataState }: { dataState: DataState }) {
  const { snapshot, error, refreshing, refresh } = useAdminHealth()

  const jobs = snapshot && !hasHealthError(snapshot.jobs) ? snapshot.jobs.queues : []
  const jobsReady = Boolean(snapshot && !hasHealthError(snapshot.jobs))
  const content = snapshot && !hasHealthError(snapshot.content) ? snapshot.content : null
  const active = jobs.reduce((count, queue) => count + queue.active, 0)
  const queued = jobs.reduce((count, queue) => count + queue.queued, 0)
  const stalled = jobs.reduce((count, queue) => count + queue.stalled, 0)
  const warningCount = snapshot?.alerts.filter((alert) => alert.level !== 'info').length ?? 0
  const jobsPartial = Boolean(snapshot && !hasHealthError(snapshot.jobs) && snapshot.jobs.partialError)
  const unavailableSections = snapshot
    ? [snapshot.startup, snapshot.diagnostics, snapshot.jobs, snapshot.content].filter((section) => hasHealthError(section)).length + Number(jobsPartial) + Number(!snapshot.schema)
    : 0
  const unavailableLabels = snapshot ? [
    hasHealthError(snapshot.startup) ? '启动统计' : '',
    hasHealthError(snapshot.diagnostics) ? '错误诊断' : '',
    hasHealthError(snapshot.jobs) ? '转换任务' : '',
    jobsPartial ? '部分转换任务' : '',
    hasHealthError(snapshot.content) ? '内容统计' : '',
    !snapshot.schema ? '数据库结构检查' : '',
  ].filter(Boolean) : []

  return (
    <Card
      title="站点健康与待处理"
      extra={(
        <div className="flex items-center gap-2">
          <span className={cx(
            'rounded-full px-2 py-1 text-[11px] font-medium',
            warningCount || stalled ? 'bg-live/10 text-live' : unavailableSections ? 'bg-[color:var(--color-coin-soft)] text-fg' : 'bg-brand-soft text-brand-hover',
          )}>
            {snapshot ? unavailableSections ? '部分数据不可用' : warningCount ? `${warningCount} 项需关注` : '运行正常' : '正在汇总'}
          </span>
          <button type="button" className={btnClass.small} onClick={refresh} disabled={refreshing}>
            {refreshing ? '更新中…' : '刷新'}
          </button>
        </div>
      )}
      className="overflow-hidden"
    >
      <div className="space-y-4" aria-live="polite" aria-busy={refreshing}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <HealthMetric label="后台数据连接" value={dataState === 'db' ? '已连接' : dataState === 'loading' ? '连接中' : dataState === 'local' ? '未配置' : '不可用'} tone={dataState === 'db' ? 'good' : 'warn'} />
          <HealthMetric label="后台转换中" value={jobsReady ? active.toLocaleString('zh-CN') : '—'} detail={!jobsReady ? '状态暂不可用' : queued ? `${queued} 个排队` : '任务在后台继续'} />
          <HealthMetric label="转换卡住" value={jobsReady ? stalled.toLocaleString('zh-CN') : '—'} tone={stalled ? 'bad' : jobsReady ? 'good' : 'neutral'} detail={!jobsReady ? '状态暂不可用' : stalled ? '超过 30 分钟无进度' : '没有停滞任务'} />
          <HealthMetric label="待处理内容" value={content ? (content.pendingComments + content.visibleWithoutRom + content.draftPosts).toLocaleString('zh-CN') : '—'} detail={content ? `${content.pendingComments} 条评论 · ${content.visibleWithoutRom} 款缺 ROM · ${content.draftPosts} 篇草稿` : '等待统计'} />
        </div>

        {unavailableLabels.length > 0 && (
          <p className="rounded-lg border border-[color:var(--color-coin)]/30 bg-[color:var(--color-coin-soft)] px-3 py-2 text-xs text-muted">
            暂时没有完整数据：{unavailableLabels.join('、')}。可以刷新后重试。
          </p>
        )}

        {!snapshot && !error && <p className="text-sm text-muted">正在读取任务队列、待审核内容和近 24 小时启动情况…</p>}
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-live/30 bg-live/5 px-3 py-2 text-sm text-live">
            <span>运行状态暂时无法读取：{error}</span>
            <button type="button" className={btnClass.small} onClick={refresh} disabled={refreshing}>重试</button>
          </div>
        )}

        {snapshot && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>
                最近 24 小时：{' '}
                {hasHealthError(snapshot.startup) ? '启动统计暂不可用' : `${snapshot.startup.starts.toLocaleString('zh-CN')} 次开始 · ${snapshot.startup.playable.toLocaleString('zh-CN')} 次成功 · ${snapshot.startup.failures.toLocaleString('zh-CN')} 次失败 · ${snapshot.startup.slow.toLocaleString('zh-CN')} 次慢启动 · ${snapshot.startup.interrupted.toLocaleString('zh-CN')} 次未可玩离开`}
              </span>
              <span>更新于 {timeLabel(snapshot.generatedAt)}</span>
            </div>

            {jobsReady && jobs.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="各类后台任务状态">
                {jobs.map((queue) => (
                  <span key={queue.kind} className="rounded-md border border-line px-2 py-1 text-[11px] text-muted">
                    {queue.kind}：处理中 {queue.active} · 排队 {queue.queued} · 近 24 小时失败 {queue.failed24h}
                  </span>
                ))}
              </div>
            )}

            {snapshot.alerts.length > 0 ? (
              <ul className="space-y-2" aria-label="需要处理的事项">
                {snapshot.alerts.slice(0, 6).map((alert) => (
                  <li key={alert.key} className={cx('rounded-lg border px-3 py-2 text-sm', levelStyle[alert.level])}>
                    {alert.link ? <Link to={alert.link} className="block hover:underline">{alert.text} <span aria-hidden>→</span></Link> : alert.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-brand/20 bg-brand-soft/50 px-3 py-2 text-sm text-muted">暂时没有需要处理的站点告警。</p>
            )}

            {snapshot.jobs && !hasHealthError(snapshot.jobs) && snapshot.jobs.recentFailures.length > 0 && (
              <div className="border-t border-line pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-muted">最近失败的转换任务</h3>
                  <Link to="/admin/roms" className="text-xs text-brand-hover hover:underline">查看存储 →</Link>
                </div>
                <ul className="space-y-1.5">
                  {snapshot.jobs.recentFailures.slice(0, 3).map((job) => (
                    <li key={`${job.kind}:${job.id}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                      <span className="min-w-0 truncate text-fg">{job.slug || '未知游戏'} · {job.kind}{job.lang ? ` · ${job.lang}` : ''}</span>
                      <span className="min-w-0 flex-1 truncate text-dim" title={job.error}>{job.error || '没有错误说明'}</span>
                      <time className="shrink-0 text-dim">{timeLabel(job.updatedAt)}</time>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function HealthMetric({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail?: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const valueStyle = tone === 'good' ? 'text-brand-hover' : tone === 'bad' ? 'text-live' : tone === 'warn' ? 'text-[color:var(--color-coin)]' : 'text-fg'
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2.5">
      <p className="truncate text-[11px] text-muted">{label}</p>
      <p className={cx('mt-1 truncate text-lg font-semibold tabular-nums', valueStyle)}>{value}</p>
      {detail && <p className="mt-0.5 truncate text-[10px] text-dim" title={detail}>{detail}</p>}
    </div>
  )
}
