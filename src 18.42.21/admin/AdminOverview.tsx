import { Link } from 'react-router-dom'
import { useAllGames } from '@/services/store'
import { platformMap, platforms } from '@/data/platforms'
import { genres } from '@/data/genres'
import { liveStreams } from '@/data/streams'
import { formatCount } from '@/lib/format'
import { useAllUsers } from '@/services/auth'
import { useAllPosts } from '@/services/posts'
import { BarList, Card, Stat } from './ui'

export function AdminOverview() {
  const all = useAllGames()
  const users = useAllUsers()
  const posts = useAllPosts()
  const visible = all.filter((g) => !g.hidden)
  const hidden = all.length - visible.length
  const plays = visible.reduce((s, g) => s + g.plays, 0)

  const top = visible
    .slice()
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 10)
    .map((g) => ({ label: g.titleZh ?? g.title, value: g.plays, hint: platformMap[g.platform]?.shortName }))

  const byPlatform = platforms
    .map((p) => ({ label: p.name, value: visible.filter((g) => g.platform === p.id).length }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)

  const byGenre = genres
    .map((g) => ({ id: g.id, label: g.name, value: visible.filter((x) => x.genres.includes(g.id)).length }))
    .sort((a, b) => b.value - a.value)

  const recent = all
    .slice()
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
    .slice(0, 8)


  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">概览</h1>
        <p className="mt-1 text-sm text-muted">站点数据一览。数字来自当前游戏库数据（前台可见部分）。</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="游戏总数" value={visible.length} sub={hidden ? `另有 ${hidden} 款已下架` : '全部上架中'} />
        <Stat label="平台" value={byPlatform.length} sub={`共 ${platforms.length} 个平台已配置`} />
        <Stat label="累计游玩" value={formatCount(plays)} sub="所有可见游戏之和" />
        <Stat label="注册用户" value={users.length} sub={`${users.filter((u) => u.status === 'banned').length} 位被封禁 · 本浏览器`} />
        <Stat label="文章" value={posts.filter((p) => p.published).length} sub={`${posts.filter((p) => !p.published).length} 篇草稿`} />
        <Stat label="已绑定云端 ROM" value={visible.filter((g) => g.rom).length} sub="详情页可直接开始游戏" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="游玩次数 Top 10" extra={<Link to="/admin/games" className="text-xs text-brand-hover hover:underline">管理游戏 →</Link>}>
          <BarList items={top} format={formatCount} />
        </Card>
        <Card title="各平台游戏数">
          <BarList items={byPlatform} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="类型分布">
          <div className="flex flex-wrap gap-2">
            {byGenre.map((g) => (
              <span key={g.id} className="rounded-md border border-line px-2 py-1 text-xs">
                {g.label} <span className="text-muted">{g.value}</span>
              </span>
            ))}
          </div>
        </Card>
        <Card title="直播数据源">
          <p className="text-sm text-muted">
            当前有 <span className="font-semibold text-fg">{liveStreams.length}</span> 条模拟直播记录（`src/data/streams.ts`），
            总观看 {formatCount(liveStreams.reduce((s, x) => s + x.viewers, 0))}。直播功能前台已标记为 coming soon。
          </p>
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
            {recent.map((g) => (
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
