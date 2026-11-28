import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '@/types'
import type { Facets, Paged } from '@/services/pageData'
import { api, apiEnabled } from '@/services/api'
import {
  fetchAdminGames,
  fetchAdminStats,
  fetchStartupStats,
  type AdminStats,
  type StartupGroup,
  type StartupStats,
} from '@/services/store'
import { platformMap, platforms } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { formatCount } from '@/lib/format'
import { trackPageLoad } from '@/services/progress'
import { BarList, btnClass, Card, inputClass, Stat } from './ui'
import { SiteHealthPanel } from './SiteHealthPanel'
import { useAdminData } from './AdminLayout'
import type { Ability } from '../../shared/roles.js'

/** 「最近上线」取几条 */
const RECENT_SIZE = 8
/** 「游玩次数 Top N」 */
const TOP_SIZE = 10

interface OverviewData {
  stats: AdminStats
  facets: Facets
  /** 全库游戏数，含已下架 */
  total: number
  /** 按 plays 倒序的前 TOP_SIZE 款（后端列表默认就是这个排序） */
  top: Game[]
  recent: Game[]
}

/**
 * 概览。
 *
 * v1 是把整个游戏库读进内存再用 JS 一路 reduce 出所有统计。v2 没有那份全量数据，
 * 统计一律问后端要现成的：
 *   - 平台 / 类型的款数     → /api/games/facets（只统计上架的）
 *   - 游戏总数、Top 10      → /api/games?all=1，一次请求既拿到 total 也拿到榜单
 *   - 最近上线              → 同一个接口按 sort=newest 取一页
 *   - 全库聚合（游戏、ROM、游玩、文章、用户） → /api/admin/stats
 *
 * 全库聚合必须在数据库里算。v1 是把整库拉进浏览器再 reduce，
 * 上千款游戏时光为了这几个数字就要下载整个目录。
 */
async function loadOverview(): Promise<OverviewData> {
  const [stats, facets, top, recent] = await Promise.all([
    fetchAdminStats(),
    api.get<Facets>('/api/games/facets'),
    // 后端列表默认按 plays 倒序，第一页就是排行榜；顺带把 total 也带回来了，
    // 不必再为「游戏总数」单独打一次 pageSize=1 的请求
    fetchAdminGames({ page: 1, pageSize: TOP_SIZE }),
    // fetchAdminGames 没有 sort 参数（后台列表用不到），所以「最近上线」直接走接口
    api.get<Paged<Game>>(`/api/games?all=1&sort=newest&pageSize=${RECENT_SIZE}`, true),
  ])
  return { stats, facets, total: top.total, top: top.items, recent: recent.items }
}

const startupTime = (ms: number | null) => ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
const startupDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })
}

function StartupBreakdown({ title, rows }: { title: string; rows: StartupGroup[] }) {
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[88rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">项目</th>
              <th className="pb-2 text-right font-medium">开始</th>
              <th className="pb-2 text-right font-medium">可玩</th>
              <th className="pb-2 text-right font-medium">成功率</th>
              <th className="pb-2 text-right font-medium" title="已到可玩状态 / 自动兜底启动链；悬停查看首帧与失败数">兜底可玩 / 链路</th>
              <th className="pb-2 text-right font-medium text-live">&gt;20s</th>
              <th className="pb-2 text-right font-medium">可玩总时长</th>
              <th className="pb-2 text-right font-medium" title="点击开始到 download_complete 的耗时；非 HTML5 代表 ROM / 启动资源到手，HTML5 代表 iframe 文档加载">开始→资源完成</th>
              <th className="pb-2 text-right font-medium" title="从缓存、文件或网络读取开始到 ROM 完整获取确认；包含缓存读取与 8BG 解包，不是纯网络耗时；流式光盘不按整盘下载统计">ROM 获取 / 准备</th>
              <th className="pb-2 text-right font-medium" title="EmulatorJS 核心预热开始到响应首块字节；引擎 IndexedDB 命中单独计数">核心首字节</th>
              <th className="pb-2 text-right font-medium" title="EmulatorJS 核心预热开始到整份核心进入 HTTP 缓存；引擎 IndexedDB 命中单独计数">核心预热</th>
              <th className="pb-2 text-right font-medium" title="模拟器实际请求核心数据文件到读完；可能命中浏览器 HTTP 缓存，不等于纯网络下载时间">核心实际读取</th>
              <th className="pb-2 text-right font-medium" title="模拟器实际核心请求开始到首块数据交给引擎；可能命中浏览器 HTTP 缓存">核心读取首字节</th>
              <th className="pb-2 text-right font-medium" title="本次启动命中 EmulatorJS IndexedDB 核心缓存的次数">核心库命中</th>
              <th className="pb-2 text-right font-medium" title="核心预热文件与模拟器实际请求文件相同 / 可配对的启动数；只统计新版本遥测">预热命中 / 对照</th>
              <th className="pb-2 text-right font-medium" title="download_complete 到 first_frame 的耗时">资源完成→首帧</th>
              <th className="pb-2 text-right font-medium" title="download_complete 到运行时 onReady 的耗时">资源完成→就绪</th>
              <th className="pb-2 text-right font-medium" title="first_frame 到 game_playable 的耗时">首帧→可玩</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.slice(0, 10).map((row) => (
              <tr key={row.id}>
                <td className="max-w-48 truncate py-2" title={row.label}>{row.label}</td>
                <td className="py-2 text-right tabular-nums text-muted">{row.starts}</td>
                <td className="py-2 text-right tabular-nums">{row.playable}</td>
                <td className="py-2 text-right tabular-nums">{row.playableRate.toFixed(1)}%</td>
                <td
                  className="py-2 text-right tabular-nums"
                  title={`${row.fallbackFirstFrames} 次到首帧；${row.fallbackFailures} 条兜底链路最终失败`}
                >
                  {row.fallbackSuccesses} / {row.fallbackAttempts}
                </td>
                <td className="py-2 text-right tabular-nums text-live">{row.slowStarts}</td>
                <td className="py-2 text-right tabular-nums text-muted">{startupTime(row.avgPlayableMs)}</td>
                <StartupPhaseCell ms={row.avgResourceMs} samples={row.resourceSamples} />
                <StartupPhaseCell ms={row.avgRomLoadMs} samples={row.romLoadSamples} />
                <StartupPhaseCell ms={row.avgCoreFirstByteMs} samples={row.coreFirstByteSamples} />
                <StartupPhaseCell ms={row.avgCoreWarmMs} samples={row.coreWarmSamples} />
                <StartupPhaseCell ms={row.avgCoreLoadMs} samples={row.coreLoadSamples} />
                <StartupPhaseCell ms={row.avgCoreLoadFirstByteMs} samples={row.coreLoadFirstByteSamples} />
                <td className="py-2 text-right tabular-nums" title="命中 EmulatorJS IndexedDB 核心缓存的启动次数">{row.coreCacheHits}</td>
                <td
                  className="py-2 text-right tabular-nums"
                  title={`核心预热与实际加载文件不一致 ${row.coreWarmMismatches} 次；已有身份信息的配对样本 ${row.coreWarmMatchSamples} 个`}
                >
                  {Math.max(0, row.coreWarmMatchSamples - row.coreWarmMismatches)} / {row.coreWarmMatchSamples}
                </td>
                <StartupPhaseCell ms={row.avgResourceToFirstFrameMs} samples={row.resourceToFirstFrameSamples} />
                <StartupPhaseCell ms={row.avgResourceToRuntimeReadyMs} samples={row.resourceToRuntimeReadySamples} />
                <StartupPhaseCell ms={row.avgFirstFrameToPlayableMs} samples={row.firstFrameToPlayableSamples} />
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={18} className="py-5 text-center text-sm text-muted">还没有启动数据</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function FallbackRouteBreakdown({ rows }: { rows: StartupStats['fallbackRoutes'] }) {
  return (
    <Card title="兜底路线效果">
      <p className="mb-3 text-xs text-muted">按同一次启动合并兜底阶段；路线包含切换原因，目标运行时按实际接棒的运行时统计。</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">路线 / 原因</th>
              <th className="pb-2 font-medium">目标运行时</th>
              <th className="pb-2 text-right font-medium">链路</th>
              <th className="pb-2 text-right font-medium">首帧</th>
              <th className="pb-2 text-right font-medium">可玩</th>
              <th className="pb-2 text-right font-medium">失败</th>
              <th className="pb-2 text-right font-medium">未确认</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={`${row.runtime}:${row.route}`}>
                <td className="max-w-[30rem] truncate py-2 font-mono text-xs" title={row.route}>{row.route}</td>
                <td className="py-2 text-muted">{row.runtime}</td>
                <td className="py-2 text-right tabular-nums">{row.attempts}</td>
                <td className="py-2 text-right tabular-nums">{row.firstFrames}</td>
                <td className="py-2 text-right tabular-nums text-online">{row.playable}</td>
                <td className="py-2 text-right tabular-nums text-live">{row.failures}</td>
                <td className="py-2 text-right tabular-nums text-muted">{row.unresolved}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="py-5 text-center text-sm text-muted">所选时间范围内没有自动兜底记录</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function StartupPhaseCell({ ms, samples }: { ms: number | null; samples: number }) {
  return (
    <td className="py-2 text-right tabular-nums" title={`${samples} 个有效阶段样本`}>
      <div>{startupTime(ms)}</div>
      <div className="text-[10px] text-muted">n={samples}</div>
    </td>
  )
}

function StartupFailures({
  rows,
  loading,
}: {
  rows: StartupStats['recentFailures']
  loading: boolean
}) {
  return (
    <Card
      title="最近启动故障"
      extra={(
        <span className="text-xs text-muted">
          最多显示 50 条 · 不含账号或 ROM 地址 ·{' '}
          <Link to="/admin/diagnostics" className="text-brand-hover hover:underline">按错误归类看现场 →</Link>
        </span>
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[58rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">时间</th>
              <th className="pb-2 font-medium">游戏</th>
              <th className="pb-2 font-medium">平台 / 模拟器</th>
              <th className="pb-2 font-medium">地区</th>
              <th className="pb-2 font-medium">结果</th>
              <th className="pb-2 font-medium">错误摘要</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap py-2 text-xs tabular-nums text-muted">
                  <time dateTime={row.createdAt}>{startupDate(row.createdAt)}</time>
                </td>
                <td className="max-w-52 py-2">
                  <Link to={`/games/${encodeURIComponent(row.slug)}`} className="block truncate text-brand-hover hover:underline" title={row.title}>
                    {row.title}
                  </Link>
                  <span className="block truncate text-[11px] text-dim">{row.slug}</span>
                </td>
                <td className="whitespace-nowrap py-2 text-xs">
                  {(platformMap[row.platform]?.shortName ?? row.platform) || '未知'}
                  <span className="ml-1 text-muted">/ {row.runtime || '未知'}</span>
                </td>
                <td className="py-2 text-xs text-muted">{row.country || 'XX'}</td>
                <td className="py-2">
                  <span className={row.event === 'timeout'
                    ? 'rounded bg-live/10 px-1.5 py-0.5 text-xs text-live'
                    : 'rounded bg-yellow-500/10 px-1.5 py-0.5 text-xs text-yellow-400'}>
                    {row.event === 'timeout' ? '启动超时' : '加载失败'}
                  </span>
                  <span className="mt-1 block text-[11px] text-muted">{startupTime(row.elapsedMs)}</span>
                </td>
                <td className="max-w-[24rem] whitespace-normal break-words py-2 text-xs text-muted" title={row.detail ?? undefined}>
                  {row.detail || (row.event === 'timeout' ? '等待游戏进入可玩状态超时，未收到更具体的错误信息。' : '客户端未提供错误摘要。')}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="py-5 text-center text-sm text-muted">
                  {loading ? '正在读取故障记录…' : '所选时间范围内没有启动失败记录'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function AdminOverview() {
  const { abilities, state: dataState } = useAdminData()
  const [data, setData] = useState<OverviewData | null>(null)
  const [startup, setStartup] = useState<StartupStats | null>(null)
  const [startupDays, setStartupDays] = useState(7)
  const [startupQuery, setStartupQuery] = useState('')
  const [startupSearch, setStartupSearch] = useState('')
  const [startupLoading, setStartupLoading] = useState(false)
  const [startupError, setStartupError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!apiEnabled()) return
    let cancelled = false
    setLoading(true)
    setError('')
    trackPageLoad(loadOverview())
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!apiEnabled()) return
    let cancelled = false
    setStartupLoading(true)
    setStartupError('')
    fetchStartupStats(startupDays, startupSearch)
      .then((result) => {
        if (!cancelled) setStartup(result)
      })
      .catch((e: unknown) => {
        if (!cancelled) setStartupError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => {
        if (!cancelled) setStartupLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [startupDays, startupSearch])

  const facets = data?.facets
  const total = data?.total ?? 0

  const byPlatform = (facets?.platforms ?? [])
    .map((p) => ({ label: platformMap[p.id]?.name ?? p.id, value: p.count }))
    .sort((a, b) => b.value - a.value)

  const byGenre = (facets?.genres ?? [])
    .map((g) => ({ id: g.id, label: genreMap[g.id]?.name ?? g.id, value: g.count }))
    .sort((a, b) => b.value - a.value)

  // 全库聚合直接用后端算好的，不再拿 facets 反推
  const stats = data?.stats
  const fallbackAttempts = startup?.summary.fallbackAttempts ?? 0
  const fallbackSuccesses = startup?.summary.fallbackSuccesses ?? 0
  const fallbackFailures = startup?.summary.fallbackFailures ?? 0
  const fallbackUnresolved = Math.max(0, fallbackAttempts - fallbackSuccesses - fallbackFailures)

  // 「已上架但没绑 ROM」的条目点进去是玩不了的，比进度百分比更需要先看到，
  // 所以有这种条目时优先显示它
  const missingRom = stats ? Math.max(0, stats.games.visible - stats.games.visibleWithRom) : 0
  const romSub = !stats
    ? ''
    : missingRom > 0
      ? `${missingRom} 款已上架但缺 ROM`
      : `占全部的 ${stats.games.total ? Math.round((stats.games.withRom / stats.games.total) * 100) : 0}%`

  const top = (data?.top ?? []).map((g) => ({
    label: g.titleZh ?? g.title,
    value: g.plays,
    hint: platformMap[g.platform]?.shortName,
  }))

  const allQuickActions: Array<{ ability: Ability; to: string; title: string; detail: string }> = [
    { ability: 'games:edit', to: '/admin/games', title: '游戏与上传', detail: '新增条目、上传 ROM、检查游戏资料' },
    { ability: 'posts:edit', to: '/admin/posts', title: '文章', detail: '编辑内容、发布文章、整理草稿' },
    { ability: 'users:manage', to: '/admin/users', title: '用户', detail: '查找用户、处理封禁与角色' },
    { ability: 'site:manage', to: '/admin/roms', title: 'ROM 存储', detail: '管理文件、BIOS 与后台转换' },
  ]
  const quickActions = allQuickActions.filter((action) => abilities.includes(action.ability))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">概览</h1>
        <p className="mt-1 text-sm text-muted">
          站点数据一览。数字直接来自数据库；平台与类型的款数只统计<strong className="text-fg">上架中</strong>的游戏。
        </p>
      </div>

      {!apiEnabled() && (
        <p className="rounded-lg bg-live/10 px-3 py-2 text-sm text-live">
          未配置后端（VITE_API_URL），概览没有数据可读。请先在前端 .env 里配置后端地址并重新构建。
        </p>
      )}
      {error && <p className="rounded-lg bg-live/10 px-3 py-2 text-sm text-live">取不到统计数据：{error}</p>}
      {loading && !data && <p className="text-sm text-muted">正在读取数据库…</p>}

      {abilities.includes('site:manage') && <SiteHealthPanel dataState={dataState} />}

      <Card title="常用管理入口" className="overflow-hidden">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {quickActions.map((action) => (
            <Link
              key={action.to}
              to={action.to}
              className="group rounded-xl border border-line bg-surface-2 px-4 py-3 transition hover:border-brand/50 hover:bg-brand-soft/50"
            >
              <span className="font-semibold group-hover:text-brand-hover">{action.title} <span aria-hidden>→</span></span>
              <span className="mt-1 block text-xs text-muted">{action.detail}</span>
            </Link>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat
          label="游戏总数"
          value={stats?.games.total ?? total}
          sub={stats?.games.hidden ? `其中 ${stats.games.hidden} 款已下架` : '全部上架中'}
        />
        <Stat label="平台" value={byPlatform.length} sub={`共 ${platforms.length} 个平台已配置`} />
        <Stat
          label="累计游玩"
          value={stats ? formatCount(stats.plays) : '—'}
          sub="全库之和，由玩家真实游玩累加"
        />
        <Stat
          label="已绑定 ROM"
          value={stats?.games.withRom ?? '—'}
          sub={romSub}
        />
        <Stat label="注册用户" value={stats?.users?.total ?? '—'} sub={`${stats?.users?.banned ?? 0} 位被封禁`} />
        <Stat
          label="文章"
          value={stats?.posts.published ?? '—'}
          sub={`${stats?.posts.draft ?? 0} 篇草稿`}
        />
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-semibold">启动漏斗 · 最近 {startupDays} 天</h2>
            <p className="mt-1 text-xs text-muted">成功率以“点击开始”为分母；阶段均值按同一次启动配对，括号内为样本数。流式光盘不虚报整盘 ROM 完成，跨域 HTML5 的就绪状态不可观测。</p>
          </div>
          <span className="text-xs text-muted">详情页 {startup?.summary.detailViews ?? 0} 次</span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
          <Stat label="点击开始" value={startup?.summary.starts ?? 0} sub="每次主动启动一条" />
          <Stat label="成功可玩" value={startup?.summary.playable ?? 0} sub={`${(startup?.summary.playableRate ?? 0).toFixed(1)}% 成功率`} />
          <Stat label="首帧" value={startup?.summary.firstFrames ?? 0} sub="运行时确认进入主循环" />
          <Stat label="慢启动" value={startup?.summary.slowStarts ?? 0} sub="可玩耗时超过 60 秒" />
          <Stat label="离开时未可玩" value={startup?.summary.interruptions ?? 0} sub="离开页面时本局尚未可玩" />
          <Stat label="无法观测" value={startup?.summary.readinessUnobservable ?? 0} sub="跨域 HTML5 无法确认就绪" />
          <Stat
            label="兜底启动链路"
            value={fallbackAttempts}
            sub={`${fallbackSuccesses} 次可玩 · ${startup?.summary.fallbackFirstFrames ?? 0} 次到首帧 · ${fallbackFailures} 次失败 · ${fallbackUnresolved} 次未确认`}
          />
          <Stat
            label="失败 / 超时"
            value={(startup?.summary.failures ?? 0) + (startup?.summary.timeouts ?? 0)}
            sub={`平均可玩 ${startupTime(startup?.summary.avgPlayableMs ?? null)}`}
          />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-9">
          <Stat
            label="点击开始 → 资源完成"
            value={startupTime(startup?.summary.avgResourceMs ?? null)}
            sub={`${startup?.summary.resourceSamples ?? 0} 个有效样本；HTML5 以 iframe 文档加载为界`}
          />
          <Stat
            label="ROM 获取 / 准备"
            value={startupTime(startup?.summary.avgRomLoadMs ?? null)}
            sub={`${startup?.summary.romLoadSamples ?? 0} 个完整获取 / 准备样本；含缓存查询与读取，不代表纯网络速度`}
          />
          <Stat
            label="核心首字节"
            value={startupTime(startup?.summary.avgCoreFirstByteMs ?? null)}
            sub={`${startup?.summary.coreFirstByteSamples ?? 0} 个预热首字节样本；与整份核心下载时间分开`}
          />
          <Stat
            label="EmulatorJS 核心预热"
            value={startupTime(startup?.summary.avgCoreWarmMs ?? null)}
            sub={`${startup?.summary.coreWarmSamples ?? 0} 个预热样本；引擎库命中 ${startup?.summary.coreCacheHits ?? 0} 次；错核 ${startup?.summary.coreWarmMismatches ?? 0} / ${startup?.summary.coreWarmMatchSamples ?? 0} 个可配对样本`}
          />
          <Stat
            label="核心实际读取"
            value={startupTime(startup?.summary.avgCoreLoadMs ?? null)}
            sub={`${startup?.summary.coreLoadSamples ?? 0} 个实际读取样本；包含浏览器 HTTP 缓存`}
          />
          <Stat
            label="核心读取首字节"
            value={startupTime(startup?.summary.avgCoreLoadFirstByteMs ?? null)}
            sub={`${startup?.summary.coreLoadFirstByteSamples ?? 0} 个实际请求首字节样本`}
          />
          <Stat
            label="资源完成 → 首帧"
            value={startupTime(startup?.summary.avgResourceToFirstFrameMs ?? null)}
            sub={`${startup?.summary.resourceToFirstFrameSamples ?? 0} 个有效样本；核心初始化与首帧`}
          />
          <Stat
            label="资源完成 → 运行时就绪"
            value={startupTime(startup?.summary.avgResourceToRuntimeReadyMs ?? null)}
            sub={`${startup?.summary.resourceToRuntimeReadySamples ?? 0} 个有效样本；到 onReady`}
          />
          <Stat
            label="首帧 → 可玩"
            value={startupTime(startup?.summary.avgFirstFrameToPlayableMs ?? null)}
            sub={`${startup?.summary.firstFrameToPlayableSamples ?? 0} 个有效样本；进入可操作状态`}
          />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <StartupBreakdown title="按游戏" rows={startup?.byGame ?? []} />
        <StartupBreakdown title="按运行时" rows={startup?.byRuntime ?? []} />
        <StartupBreakdown title="按地区" rows={startup?.byCountry ?? []} />
      </div>

      <FallbackRouteBreakdown rows={startup?.fallbackRoutes ?? []} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">启动故障明细</h2>
            <p className="mt-1 text-xs text-muted">按时间查看失败原因；游戏搜索只筛选下方明细，不影响上方汇总。</p>
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setStartupSearch(startupQuery.trim())
            }}
          >
            <label className="block">
              <span className="mb-1 block text-xs text-muted">时间范围</span>
              <select className={inputClass} value={startupDays} onChange={(event) => setStartupDays(Number(event.target.value))}>
                <option value={1}>最近 24 小时</option>
                <option value={7}>最近 7 天</option>
                <option value={30}>最近 30 天</option>
                <option value={90}>最近 90 天</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">搜索游戏</span>
              <input
                className={inputClass}
                value={startupQuery}
                onChange={(event) => setStartupQuery(event.target.value)}
                placeholder="名称或 slug"
                maxLength={80}
              />
            </label>
            <button type="submit" className={btnClass.secondary} disabled={startupLoading}>筛选</button>
          </form>
        </div>
        {startupError && <p className="rounded-lg bg-live/10 px-3 py-2 text-sm text-live">故障记录读取失败：{startupError}</p>}
        <StartupFailures rows={startup?.recentFailures ?? []} loading={startupLoading} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={`游玩次数 Top ${TOP_SIZE}（含已下架）`}
          extra={<Link to="/admin/games" className="text-xs text-brand-hover hover:underline">管理游戏 →</Link>}
        >
          <BarList items={top} format={formatCount} />
        </Card>
        <Card title="各平台游戏数">
          <BarList items={byPlatform} />
        </Card>
      </div>

      <div className="grid gap-4">
        <Card title="类型分布">
          <div className="flex flex-wrap gap-2">
            {byGenre.map((g) => (
              <span key={g.id} className="rounded-md border border-line px-2 py-1 text-xs">
                {g.label} <span className="text-muted">{g.value}</span>
              </span>
            ))}
          </div>
        </Card>
      </div>

      <Card title="最近上线">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">游戏</th>
              <th className="pb-2 font-medium">平台</th>
              <th className="pb-2 font-medium">上线日期</th>
              <th className="pb-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(data?.recent ?? []).map((g) => (
              <tr key={g.slug}>
                <td className="py-2">
                  <span className="mr-2" aria-hidden>
                    {g.icon}
                  </span>
                  {g.titleZh ?? g.title}
                </td>
                <td className="py-2 text-muted">{platformMap[g.platform]?.shortName ?? g.platform}</td>
                <td className="py-2 tabular-nums text-muted">{g.addedAt}</td>
                <td className="py-2">
                  {g.hidden ? (
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-dim">已下架</span>
                  ) : (
                    <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">上架中</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
