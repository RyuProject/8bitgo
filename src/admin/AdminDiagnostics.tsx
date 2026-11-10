import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api, apiEnabled } from '@/services/api'
import { cx } from '@/lib/format'
import { Card, btnClass, inputClass } from './ui'
import {
  EVENT_LABEL,
  fmtBytes,
  fmtMs,
  formatEnvironment,
  formatGroupForAi,
  type DiagnosticEvent,
  type DiagnosticGroup,
  type DiagnosticGroupsResponse,
  type DiagnosticSample,
} from './diagnosticsReport'

/**
 * 后台：错误诊断。
 *
 * 真实玩家开局**失败 / 超时 / 慢启动**时，前端随启动漏斗多发一份诊断包（环境、阶段时间线、
 * 引擎日志、慢 / 失败的网络请求，见 src/services/startupDiagnostics.ts）。这一页把它们按
 * 「错误特征」归组（抹掉数字和变量后的错误原文 + 运行时），影响人数最多的排前面。
 *
 * 「复制给 AI」把一组的概况和最近几份完整现场拼成 Markdown，直接贴给 AI 排查。
 * 诊断包保留 30 天，不含 IP、完整 User-Agent、账号或 ROM 地址。
 */

const AI_SAMPLE_COUNT = 5
const EVENT_FILTERS: Array<{ id: '' | DiagnosticEvent; label: string }> = [
  { id: '', label: '全部' },
  { id: 'failed', label: '加载失败' },
  { id: 'timeout', label: '启动超时' },
  { id: 'slow_start', label: '慢启动' },
]

const eventTone = (event: DiagnosticEvent) => event === 'failed'
  ? 'bg-yellow-500/10 text-yellow-400'
  : event === 'timeout' ? 'bg-live/10 text-live' : 'bg-brand/10 text-brand-hover'

const shortDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    /* 非安全上下文或权限被拒：退回老办法 */
  }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

const fetchSamples = (signature: string, limit: number) =>
  api.get<{ items: DiagnosticSample[] }>(`/api/admin/startup-diagnostics/samples?signature=${signature}&limit=${limit}`, true)
    .then((r) => r.items)

function Chips({ items }: { items: Array<{ name: string; count: number }> }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((i) => (
        <span key={i.name} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
          {i.name} <span className="tabular-nums text-dim">×{i.count}</span>
        </span>
      ))}
    </span>
  )
}

function SampleView({ sample }: { sample: DiagnosticSample }) {
  const d = sample.diagnostics
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/games/${encodeURIComponent(sample.slug)}`} className="font-medium text-brand-hover hover:underline">{sample.title}</Link>
        <span className={cx('rounded px-1.5 py-0.5', eventTone(sample.event))}>{EVENT_LABEL[sample.event]}</span>
        <span className="tabular-nums text-muted">{fmtMs(sample.elapsedMs)}</span>
        <span className="text-dim">{shortDate(sample.createdAt)} · #{sample.id}</span>
      </div>
      <p className="text-muted">{formatEnvironment(sample)}</p>
      {d?.reason && <p className="break-words text-fg">原因：{d.reason}</p>}
      {d && (
        <>
          <p className="text-dim">部署 {d.build || '未知'} · 本次访问第 {d.attempt.index} 次开局 · 平台 {sample.platform} / {sample.runtime}</p>
          {d.timeline.length > 0 && (
            <p className="flex flex-wrap gap-x-3 text-muted">
              {d.timeline.map((row, i) => <span key={i}><span className="tabular-nums text-dim">{fmtMs(row.t)}</span> {row.e}</span>)}
            </p>
          )}
          {d.logs.length > 0 && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg/60 p-2 font-mono text-[11px] leading-relaxed">
              {d.logs.map((row) => `${fmtMs(row.t).padStart(7)} [${row.s}/${row.l}] ${row.m}`).join('\n')}
            </pre>
          )}
          {d.resources.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] font-mono text-[11px]">
                <thead className="text-left text-dim">
                  <tr><th className="pr-2 font-normal">开始</th><th className="pr-2 font-normal">耗时</th><th className="pr-2 font-normal">状态</th><th className="pr-2 font-normal">传输 / 内容</th><th className="font-normal">请求</th></tr>
                </thead>
                <tbody>
                  {d.resources.map((r, i) => (
                    <tr key={i} className={r.st >= 400 ? 'text-live' : r.d >= 10_000 ? 'text-yellow-400' : 'text-muted'}>
                      <td className="pr-2 tabular-nums">{fmtMs(r.at)}</td>
                      <td className="pr-2 tabular-nums">{fmtMs(r.d)}</td>
                      <td className="pr-2">{r.st || '-'} {r.p}</td>
                      <td className="pr-2 tabular-nums">{fmtBytes(r.tx)} / {fmtBytes(r.sz)}</td>
                      <td className="break-all">{r.i} {r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function GroupCard({ group }: { group: DiagnosticGroup }) {
  const [open, setOpen] = useState(false)
  const [samples, setSamples] = useState<DiagnosticSample[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')

  const loadSamples = async (limit: number) => {
    setLoading(true)
    setError('')
    try {
      const items = await fetchSamples(group.signature, limit)
      setSamples(items)
      return items
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
      return null
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    setOpen((v) => !v)
    if (!samples) void loadSamples(10)
  }

  const copyForAi = async () => {
    const items = samples && samples.length >= Math.min(AI_SAMPLE_COUNT, group.count) ? samples : await loadSamples(10)
    if (!items) return
    await copyText(formatGroupForAi(group, items.slice(0, AI_SAMPLE_COUNT)))
    setCopied('已复制')
    window.setTimeout(() => setCopied(''), 2000)
  }

  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cx('rounded px-1.5 py-0.5', eventTone(group.event))}>{EVENT_LABEL[group.event]}</span>
            <span className="text-muted">{group.runtime || 'unknown'}</span>
            <span className="tabular-nums text-fg">{group.count} 次 · {group.visits} 次访问</span>
            <span className="text-dim">最近 {shortDate(group.lastSeen)}</span>
          </div>
          <p className="break-words text-sm text-fg">{group.text.split(' · ').slice(2).join(' · ') || group.text}</p>
          <div className="space-y-1 text-xs">
            <p className="flex flex-wrap items-center gap-1">
              <span className="text-dim">游戏</span>
              {group.games.map((g) => (
                <Link key={g.slug} to={`/games/${encodeURIComponent(g.slug)}`} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-brand-hover hover:underline">
                  {g.title} <span className="text-dim">×{g.count}</span>
                </Link>
              ))}
            </p>
            <p className="flex flex-wrap items-center gap-1"><span className="text-dim">浏览器</span><Chips items={group.browsers} /></p>
            <p className="flex flex-wrap items-center gap-1"><span className="text-dim">系统</span><Chips items={group.os} /><span className="ml-2 text-dim">地区</span><Chips items={group.countries} /></p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className={btnClass.secondary} onClick={toggle} aria-expanded={open}>
            {open ? '收起' : '查看现场'}
          </button>
          <button type="button" className={btnClass.secondary} onClick={() => void copyForAi()} disabled={loading}>
            {copied || '复制给 AI'}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-live">{error}</p>}
      {open && (
        <div className="mt-3 space-y-2">
          {loading && !samples && <p className="text-xs text-muted">正在读取…</p>}
          {samples?.map((sample) => <SampleView key={sample.id} sample={sample} />)}
          {samples && !samples.length && <p className="text-xs text-muted">这一组的诊断包已过期。</p>}
        </div>
      )}
    </li>
  )
}

export function AdminDiagnostics() {
  const [days, setDays] = useState(7)
  const [event, setEvent] = useState<'' | DiagnosticEvent>('')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<DiagnosticGroupsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!apiEnabled()) return
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ days: String(days) })
    if (event) params.set('event', event)
    if (search) params.set('q', search)
    api.get<DiagnosticGroupsResponse>(`/api/admin/startup-diagnostics?${params}`, true)
      .then((r) => { if (!cancelled) setData(r) })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError || e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, event, search])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">错误诊断</h1>
        <p className="mt-1 text-sm text-muted">
          真实玩家开局失败、超时或超过 20 秒时上报的现场，按错误特征归组，影响人数多的排前面。
          「复制给 AI」会带上这一组的概况和最近 {AI_SAMPLE_COUNT} 份完整现场。保留 30 天，不含 IP、完整 User-Agent、账号或 ROM 地址。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <select className={cx(inputClass, 'w-28')} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="时间范围">
            <option value={1}>最近 1 天</option>
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
          </select>
          <div className="flex gap-1" role="group" aria-label="类型">
            {EVENT_FILTERS.map((f) => (
              <button
                key={f.id || 'all'}
                type="button"
                onClick={() => setEvent(f.id)}
                className={cx(btnClass.small, event === f.id ? 'bg-brand/15 text-brand-hover' : 'text-muted hover:text-fg')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <form
            className="ml-auto flex min-w-60 flex-1 gap-2 sm:flex-none"
            onSubmit={(e) => {
              e.preventDefault()
              setSearch(query.trim())
            }}
          >
            <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜游戏、错误原文、浏览器、运行时" />
            <button type="submit" className={btnClass.secondary}>搜索</button>
          </form>
        </div>
        {data && (
          <p className="mt-3 text-xs text-muted">
            共 {data.total} 份诊断包，归成 {data.groups.length} 组{data.groups.length >= 200 ? '（只显示前 200 组）' : ''}。
          </p>
        )}
      </Card>

      {error && <p className="rounded-lg bg-live/10 px-3 py-2 text-sm text-live">{error}</p>}
      {loading && !data && <p className="text-sm text-muted">正在读取…</p>}
      <ul className="space-y-3">
        {data?.groups.map((group) => <GroupCard key={group.signature} group={group} />)}
      </ul>
      {data && !data.groups.length && !loading && (
        <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted">所选范围内没有诊断包。</p>
      )}
    </div>
  )
}
