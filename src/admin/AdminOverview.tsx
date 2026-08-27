import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game, Post } from '@/types'
import type { Facets, Paged } from '@/services/pageData'
import { api, apiEnabled } from '@/services/api'
import { fetchAdminGames, fetchAdminStats, type AdminStats } from '@/services/store'
import { fetchAllPosts } from '@/services/posts'
import { platformMap, platforms } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { formatCount } from '@/lib/format'
import { useAllUsers } from '@/services/auth'
import { trackPageLoad } from '@/services/progress'
import { BarList, Card, Stat } from './ui'

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
  posts: Post[]
}

/**
 * 概览。
 *
 * v1 是把整个游戏库读进内存再用 JS 一路 reduce 出所有统计。v2 没有那份全量数据，
 * 统计一律问后端要现成的：
 *   - 平台 / 类型的款数     → /api/games/facets（只统计上架的）
 *   - 游戏总数、Top 10      → /api/games?all=1，一次请求既拿到 total 也拿到榜单
 *   - 最近上线              → 同一个接口按 sort=newest 取一页
 *   - 文章                  → /api/posts?all=1
 *
 *   - 全库聚合（总数/上下架/已绑 ROM/累计游玩） → /api/admin/stats
 *
 * 全库聚合必须在数据库里算。v1 是把整库拉进浏览器再 reduce，
 * 上千款游戏时光为了这几个数字就要下载整个目录。
 */
async function loadOverview(): Promise<OverviewData> {
  const [stats, facets, top, recent, posts] = await Promise.all([
    fetchAdminStats(),
    api.get<Facets>('/api/games/facets'),
    // 后端列表默认按 plays 倒序，第一页就是排行榜；顺带把 total 也带回来了，
    // 不必再为「游戏总数」单独打一次 pageSize=1 的请求
    fetchAdminGames({ page: 1, pageSize: TOP_SIZE }),
    // fetchAdminGames 没有 sort 参数（后台列表用不到），所以「最近上线」直接走接口
    api.get<Paged<Game>>(`/api/games?all=1&sort=newest&pageSize=${RECENT_SIZE}`, true),
    fetchAllPosts(),
  ])
  return { stats, facets, total: top.total, top: top.items, recent: recent.items, posts }
}

export function AdminOverview() {
  const users = useAllUsers()
  const [data, setData] = useState<OverviewData | null>(null)
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

  const facets = data?.facets
  const posts = data?.posts ?? []
  const total = data?.total ?? 0

  const byPlatform = (facets?.platforms ?? [])
    .map((p) => ({ label: platformMap[p.id]?.name ?? p.id, value: p.count }))
    .sort((a, b) => b.value - a.value)

  const byGenre = (facets?.genres ?? [])
    .map((g) => ({ id: g.id, label: genreMap[g.id]?.name ?? g.id, value: g.count }))
    .sort((a, b) => b.value - a.value)

  // 全库聚合直接用后端算好的，不再拿 facets 反推
  const stats = data?.stats

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
        <Stat label="注册用户" value={users.length} sub={`${users.filter((u) => u.status === 'banned').length} 位被封禁`} />
        <Stat
          label="文章"
          value={stats?.posts.published ?? posts.filter((p) => p.published).length}
          sub={`${stats?.posts.draft ?? posts.filter((p) => !p.published).length} 篇草稿`}
        />
      </div>

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
