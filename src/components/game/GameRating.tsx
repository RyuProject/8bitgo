/**
 * 详情页侧栏的评分卡：左边一个大平均分 + 星级，右边 1~5 星的分布柱，
 * 下面是「我的评分」那一行星星。
 *
 * 三个定下来的取舍：
 *
 * 1. **未登录也能打分**，权重 0.5（服务端定的，见 ratings-repo.js）。
 *    逼人注册才能打分，样本会小一个数量级而且全是重度用户 —— 那个平均分对新玩家没参考价值。
 * 2. **客户端取数**，不进 SSR。和评论同一个理由：SSR 出去的 HTML 在边缘要缓存几分钟，
 *    烘进去的分数会是几分钟前的，用户打完刷新看不到自己那一票。
 *    代价是评分不参与 SEO —— 想让 Google 抓到 aggregateRating，得先解决边缘缓存那一层。
 * 3. **乐观更新**：点下去星星立刻亮，请求回来再用服务端的汇总覆盖。
 *    打分是个「点一下就完事」的动作，等 200ms 才亮会让人以为没点上、再点一次。
 *    失败就整块回滚到请求前的状态，并把错误显示出来。
 */
import { useCallback, useEffect, useState } from 'react'
import type { RatingSummary } from '@/types'
import { useCurrentUser } from '@/services/auth'
import { fmt, useT } from '@/services/i18n'
import { getLang } from '@/services/lang'
import { clearRating, fetchRating, ratingsAvailable, submitRating } from '@/services/ratings'
import { Stars, StarPicker } from './StarRating'

export function GameRating({ gameSlug }: { gameSlug: string }) {
  const t = useT()
  const r = t.ratings
  const user = useCurrentUser()

  const [data, setData] = useState<RatingSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await fetchRating(gameSlug))
    } catch {
      // 汇总拉不到就整块不显示。评分不是主内容，为它在详情页上挂一条报错反而更碍事
      setData(null)
    }
  }, [gameSlug])

  useEffect(() => {
    setData(null)
    setError('')
    void load()
  }, [gameSlug, load])

  /**
   * 登录状态一变就重拉。
   *
   * 必须重拉而不是沿用：匿名投过票的人登录之后，服务端会把那张 0.5 的票换成 1.0 的，
   * 不重拉的话「我的评分」还挂在匿名那一票上，用户改分时看到的数字对不上。
   */
  useEffect(() => {
    if (data) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const pick = async (score: number) => {
    if (busy || !data) return
    const before = data
    setBusy(true)
    setError('')
    // 乐观更新：只动「我的那一票」，平均分等服务端算完再覆盖 ——
    // 在前端重算加权平均要复制一遍服务端的权重规则，两边迟早会不一致
    setData({ ...data, mine: score ? { score, weight: user ? 1 : 0.5, anonymous: !user } : null })
    try {
      setData(score ? await submitRating(gameSlug, score) : await clearRating(gameSlug))
    } catch (e) {
      setData(before)
      setError(e instanceof Error ? e.message : r.failed)
    } finally {
      setBusy(false)
    }
  }

  if (!ratingsAvailable()) return null
  if (!data) return null

  const lang = getLang()
  const mine = data.mine?.score ?? 0
  const rated = data.count > 0 && data.average !== null
  // 分布柱按最高那一档归一化，不是按总人数 —— 按总人数的话 5 档平均分布时
  // 每根都只有 20% 高，看不出形状
  const peak = Math.max(1, ...[1, 2, 3, 4, 5].map((n) => data.distribution[n] ?? 0))

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" aria-label={r.title}>
      <h2 className="text-sm font-bold">⭐ {r.title}</h2>

      {rated ? (
        <div className="mt-3 flex items-start gap-4">
          <div className="shrink-0 text-center">
            <p className="text-3xl font-black leading-none text-fg">{data.average!.toFixed(1)}</p>
            <div className="mt-1.5 flex justify-center">
              <Stars value={data.average!} size="sm" />
            </div>
            <p className="mt-1 text-[11px] text-dim">{fmt(r.count, { n: data.count.toLocaleString(lang) })}</p>
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            {[5, 4, 3, 2, 1].map((n) => {
              const c = data.distribution[n] ?? 0
              return (
                <div
                  key={n}
                  className="flex items-center gap-1.5"
                  title={fmt(r.distributionAria, { n, count: c })}
                >
                  <span className="w-3 shrink-0 text-right text-[11px] tabular-nums text-dim">{n}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-coin transition-[width] duration-300"
                      style={{ width: `${(c / peak) * 100}%` }}
                    />
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">
          {r.none} — {r.beFirst}
        </p>
      )}

      {/* ---- 我的评分 ---- */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{mine ? r.yours : r.rate}</span>
          <StarPicker value={mine} onPick={(n) => void pick(n)} disabled={busy} size="md" />
        </div>
        <p className="mt-1.5 text-[11px] text-dim">
          {busy ? r.saving : mine ? `${fmt(r.yourScore, { n: mine })} · ${r.clear}` : user ? '' : r.loginNote}
        </p>
      </div>

      {error && (
        <p className="mt-2 text-xs text-live" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
