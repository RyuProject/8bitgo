import { useCallback, useEffect, useState } from 'react'
import { apiEnabled } from '@/services/api'
import { fetchRomUploadStats, type RomUploadMetricGroup, type RomUploadStats } from '@/services/store'
import { btnClass, Card } from './ui'

const SIZE_LABEL: Record<RomUploadMetricGroup['sizeBand'], string> = {
  lt8m: '<8 MiB',
  '8to24m': '8–24 MiB',
  '24to128m': '24–128 MiB',
  '128to512m': '128–512 MiB',
  gte512m: '≥512 MiB',
}

function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`
  return `${(value / 60_000).toFixed(1)} 分钟`
}

function region(value: RomUploadMetricGroup['region']): string {
  return value === 'CN' ? '大陆' : value === 'OTHER' ? '境外' : '未知'
}

function device(value: RomUploadMetricGroup['device']): string {
  return value === 'mobile' ? '手机' : value === 'tablet' ? '平板' : value === 'desktop' ? '桌面' : '未知设备'
}

function groupLabel(group: RomUploadMetricGroup): string {
  const route = group.mode === 'multipart' ? '分片' : '单发'
  return `${SIZE_LABEL[group.sizeBand]} · ${route} · ${region(group.region)} · ${device(group.device)} · ${group.network === 'unknown' ? '网络未知' : group.network}`
}

function useRomUploadStats(days: number, refresh: number) {
  const [stats, setStats] = useState<RomUploadStats | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!apiEnabled()) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void fetchRomUploadStats(days, controller.signal).then((value) => {
      setStats(value)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : '读取上传统计失败')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [days, refresh])

  return { stats, error, loading }
}

export function RomUploadMetricsPanel() {
  const [days, setDays] = useState(7)
  const [refresh, setRefresh] = useState(0)
  const { stats, error, loading } = useRomUploadStats(days, refresh)
  const refreshNow = useCallback(() => setRefresh((n) => n + 1), [])

  if (!apiEnabled()) return null
  const groups = stats?.groups ?? []
  const total = groups.reduce((sum, group) => sum + group.attempts, 0)
  const successful = groups.reduce((sum, group) => sum + group.successful, 0)
  const successRate = total ? Math.round(successful / total * 100) : null

  return (
    <Card
      title="ROM 上传性能基线"
      extra={
        <div className="flex items-center gap-2">
          <select
            className="h-7 rounded-md border border-line bg-surface-2 px-2 text-xs"
            aria-label="上传性能统计天数"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
          </select>
          <button type="button" className={btnClass.small} onClick={refreshNow} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-muted">
        只按大小档、传输方式、地区、设备和网络类型聚合；不保存 ROM 名称、对象路径、账号、IP 或精确文件大小。样本保留 30 天。成功率用于发现回退，准备 / 首片 / 传输 / 收尾耗时和实测速度用于定位瓶颈。
      </p>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>上传次数：<strong className="text-fg">{total}</strong></span>
        <span>成功率：<strong className="text-fg">{successRate === null ? '—' : `${successRate}%`}</strong></span>
        {stats && <span>统计窗口：<strong className="text-fg">{stats.days} 天</strong></span>}
      </div>
      {error && <p className="mb-3 rounded-lg bg-live/15 px-3 py-2 text-sm text-live">{error}</p>}
      {groups.length === 0 && !loading && !error && (
        <p className="rounded-lg bg-surface-2 px-3 py-4 text-sm text-muted">
          还没有样本。部署后管理员下一次上传 ROM 时开始记录；旧上传不会补造数据。
        </p>
      )}
      {groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="pb-2 pr-3 font-medium">条件 / 样本</th>
                <th className="pb-2 pr-3 font-medium">成功</th>
                <th className="pb-2 pr-3 font-medium">准备</th>
                <th className="pb-2 pr-3 font-medium">首片</th>
                <th className="pb-2 pr-3 font-medium">传输</th>
                <th className="pb-2 pr-3 font-medium">收尾</th>
                <th className="pb-2 pr-3 font-medium">实测上行</th>
                <th className="pb-2 pr-3 font-medium">Worker/R2 等待</th>
                <th className="pb-2 pr-3 font-medium" title="单发 ROM / BIOS：本机 SHA-256 完整生成耗时；分片上传：每片上行结束后被尚未完成的摘要实际挡住的平均等待。">摘要 / 等待</th>
                <th className="pb-2 font-medium">峰值并发 / 续传率</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {groups.map((group) => (
                <tr key={`${group.sizeBand}-${group.mode}-${group.region}-${group.device}-${group.network}`}>
                  <td className="py-2 pr-3 text-fg">
                    <span className="block">{groupLabel(group)}</span>
                    <span className="text-dim">{group.attempts} 次</span>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{group.successful}/{group.attempts} · {Math.round(group.successRate * 100)}%</td>
                  <td className="py-2 pr-3 tabular-nums">{duration(group.avgPrepareMs)}</td>
                  <td className="py-2 pr-3 tabular-nums">{duration(group.avgFirstPartMs)}</td>
                  <td className="py-2 pr-3 tabular-nums">{duration(group.avgTransferMs)}</td>
                  <td className="py-2 pr-3 tabular-nums">{duration(group.avgFinalizeMs)}</td>
                  <td className="py-2 pr-3 tabular-nums">{group.avgMeasuredMbps === null ? '—' : `${group.avgMeasuredMbps.toFixed(1)} Mbps`}</td>
                  <td className="py-2 pr-3 tabular-nums">{duration(group.avgServerWaitMs)}</td>
                  <td className="py-2 pr-3 tabular-nums">{duration(group.avgHashWaitMs)}</td>
                  <td className="py-2 tabular-nums">{group.avgPeakConcurrency === null ? '—' : `${group.avgPeakConcurrency.toFixed(1)} 路（样本均值）`} · 续传 {Math.round(group.resumeRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
