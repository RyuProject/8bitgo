import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game, PlatformId } from '@/types'
import type { Paged } from '@/services/pageData'
import { platformMap, platforms } from '@/data/platforms'
import { FEATURES } from '@/config/features'
import { genreMap } from '@/data/genres'
import { cx, formatCount } from '@/lib/format'
import { api, apiEnabled } from '@/services/api'
import { useAdminData } from './AdminLayout'
import { deleteGame, fetchAdminGames, setGameHidden, upsertGame } from '@/services/store'
import { romKeysOf } from '@/services/roms'
import { deleteRomObjects, isDeletableKey } from './uploadGuards'
import { trackPageLoad } from '@/services/progress'
import { GameForm } from './GameForm'
import { btnClass, inputClass } from './ui'

type Status = 'all' | 'visible' | 'hidden'
type HomeFilter = 'all' | 'picked' | 'unpicked'
type Editing = { mode: 'add' } | { mode: 'edit'; game: Game } | null

/** 后台一页多少条。和前台列表页保持一致，够看又不至于一次拉太多关联数据。 */
const PAGE_SIZE = 24
/** 搜索防抖：边打字边发请求会把后端打成一串没人要的查询 */
const SEARCH_DEBOUNCE = 300

/**
 * 新增前确认 slug 有没有被占用。
 *
 * v1 手上有整库，GameForm 里一次 includes 就能判重。v2 列表是分页的，
 * 表单能拿到的 existingSlugs 只有当前这一页；而 upsertGame 走的是 PUT（整体覆盖），
 * 撞名不会报错，会**悄悄把已有的那条改掉**，所以这里单独问后端一次。
 * 请求本身失败（后端不通等）就当作没撞名 —— 让后面真正的保存去报错，
 * 而不是在这里拦下一个其实合法的新增。
 */
async function slugTaken(slug: string): Promise<boolean> {
  try {
    await api.get<Game>(`/api/games/${encodeURIComponent(slug)}`, true)
    return true
  } catch {
    return false
  }
}

export function AdminGames() {
  const db = useAdminData()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [status, setStatus] = useState<Status>('all')
  const [home, setHome] = useState<HomeFilter>('all')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Editing>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [paged, setPaged] = useState<Paged<Game> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 增删改之后 +1，用来重新拉当前页（列表不再有全局 store 会自己推送变化） */
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(t)
  }, [toast])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(t)
  }, [q])

  // 换关键词 / 换平台后还停在第 5 页，多半是一片空白，回第一页
  useEffect(() => {
    setPage(1)
  }, [debouncedQ, platform, status, home])

  useEffect(() => {
    if (!apiEnabled()) {
      setPaged(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    trackPageLoad(
      fetchAdminGames({
        q: debouncedQ || undefined,
        platform,
        status,
        home,
        // 只看首页位时按首页排序号排，才看得出实际的先后
        sort: home === 'picked' ? 'home' : undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    )
      .then((r) => {
        if (cancelled) return
        setPaged(r)
        // 服务端会把越界的页码夹回合法范围（删掉最后一页的最后一条就会发生）。
        // 不跟着改本地 page，下一次请求还会带着那个越界页码，翻页按钮就卡住了。
        if (r.page !== page) setPage(r.page)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setPaged(null)
        setError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQ, platform, status, home, page, tick])

  const reload = () => setTick((n) => n + 1)
  /** 出错后的重试：顶栏徽章那份探测也一起重跑，否则修好了徽章还红着 */
  const retry = () => {
    db.reload()
    reload()
  }

  const items = paged?.items ?? []
  const total = paged?.total ?? 0
  const totalPages = paged?.totalPages ?? 1

  // 关键词、平台、上下架状态全部由服务端筛选，所以 items 就是最终结果，
  // total 和翻页也都是全库口径 —— 不能在前端再过滤一道，那会让「共 N 款」对不上。
  const rows = items

  const save = async (game: Game) => {
    try {
      if (editing?.mode === 'add' && (await slugTaken(game.slug))) {
        setToast(`slug「${game.slug}」已存在，请换一个`)
        return
      }
      const saved = await upsertGame(game)
      // 保存后继续留在弹窗里，方便接着替换封面或调整其它字段；只有底部“取消”负责关闭。
      setEditing({ mode: 'edit', game: saved })
      setToast(editing?.mode === 'edit' ? `已保存「${game.titleZh ?? game.title}」` : `已新增「${game.titleZh ?? game.title}」`)
      reload()
    } catch (err) {
      setToast(err instanceof Error ? err.message : '保存失败')
    }
  }

  /**
   * 删游戏，连同它在 R2 上的 ROM 文件一起。
   *
   * 数据库那边有外键级联，game_roms 的行会自己清掉 —— 但**对象存储不会**，
   * 文件会变成没人引用的孤儿，一直占着空间，而且事后谁也说不清那些 key 属于谁。
   *
   * 顺序是先删库再删文件：反过来的话，一旦删库失败，游戏还在、ROM 已经没了，
   * 玩家点「开始游戏」直接 404。所以 key 要在删库**之前**就从 g 上取下来。
   *
   * 删文件失败不影响「游戏已删除」这个结果，只把失败的 key 报出来让人工收尾。
   */
  const remove = async (g: Game) => {
    const keys = romKeysOf(g).filter(isDeletableKey)
    const tail = keys.length
      ? `\n\n同时会从 R2 删除这款游戏的 ${keys.length} 个 ROM 文件：\n${keys.slice(0, 5).map((k) => `  ${k}`).join('\n')}${keys.length > 5 ? `\n  …还有 ${keys.length - 5} 个` : ''}`
      : ''
    if (!window.confirm(`确定删除「${g.titleZh ?? g.title}」？此操作会从数据库中移除该游戏，不可恢复。${tail}`)) return

    try {
      await deleteGame(g.slug)
    } catch (err) {
      setToast(err instanceof Error ? err.message : '删除失败')
      return
    }

    if (!keys.length) {
      setToast('已删除')
      reload()
      return
    }

    try {
      const { removed, failed } = await deleteRomObjects(keys)
      setToast(
        failed.length
          ? `游戏已删除，${removed.length} 个文件已清理，${failed.length} 个删除失败：${failed.join('、')}`
          : `已删除，并清理了 ${removed.length} 个 ROM 文件`,
      )
    } catch (err) {
      // 游戏已经删掉了，这里只是文件没清干净 —— 说清楚，别让人以为整个操作失败了
      setToast(`游戏已删除，但 R2 文件未清理：${err instanceof Error ? err.message : '删除失败'}`)
    }
    reload()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">游戏管理</h1>
          <p className="mt-1 text-sm text-muted">
            {!apiEnabled()
              ? '未配置后端（VITE_API_URL），后台读不到游戏，也保存不了修改。'
              : error
                ? `⚠️ 取不到游戏列表：${error}`
                : `共 ${total} 款（含已下架）。修改直接写入数据库，前台立即生效。`}
          </p>
        </div>
        <button type="button" className={btnClass.primary} onClick={() => setEditing({ mode: 'add' })} disabled={!apiEnabled()}>
          ＋ 新增游戏
        </button>
      </div>

      {/* 筛选 */}
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 译名 / 开发商 / 标签…"
          className={cx(inputClass, 'w-64')}
        />
        <select className={cx(inputClass, 'w-44')} value={platform} onChange={(e) => setPlatform(e.target.value as PlatformId | 'all')}>
          <option value="all">全部平台</option>
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.shortName} · {p.nameZh}
            </option>
          ))}
        </select>
        <select className={cx(inputClass, 'w-32')} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          <option value="all">全部状态</option>
          <option value="visible">上架中</option>
          <option value="hidden">已下架</option>
        </select>
        {/* 挑好首页位之后，对着这一档逐个传视频最省事 */}
        <select className={cx(inputClass, 'w-36')} value={home} onChange={(e) => setHome(e.target.value as HomeFilter)}>
          <option value="all">首页位：全部</option>
          <option value="picked">只看首页位</option>
          <option value="unpicked">未上首页</option>
        </select>
        <span className="self-center text-xs text-muted">
          {loading ? '读取中…' : `共 ${total} 款`}
        </span>
      </div>

      {/* 表格 */}
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">游戏</th>
              <th className="px-3 py-2 font-medium">平台</th>
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">年份</th>
              <th className="px-3 py-2 font-medium">游玩</th>
              {/* G 币功能没开的时候整列隐藏 —— 开关已经是 false，列还杵在那儿全是「—」 */}
              {FEATURES.coins && <th className="px-3 py-2 font-medium">G 币</th>}
              <th className="px-3 py-2 font-medium">首页</th>
              <th className="px-3 py-2 font-medium">ROM</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((g) => {
              const p = platformMap[g.platform]
              return (
                <tr key={g.slug} className={cx('transition hover:bg-black/[0.03]', g.hidden && 'opacity-60')}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-base" aria-hidden>
                        {g.icon}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{g.titleZh ?? g.title}</p>
                        <p className="truncate text-xs text-dim">
                          {g.title} · <Link to={`/games/${g.slug}`} target="_blank" className="hover:text-brand-hover">/{g.slug}</Link>
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted">{p?.shortName ?? g.platform}</td>
                  <td className="px-3 py-2 text-muted">{g.genres.map((id) => genreMap[id]?.name ?? id).join(' / ')}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{g.year}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{g.plays ? formatCount(g.plays) : '—'}</td>
                  {FEATURES.coins && (
                    <td className="px-3 py-2 tabular-nums text-muted">{g.coinReward || '—'}</td>
                  )}
                  {/*
                    首页位和视频放一格：挑好首页位之后要做的事就是给这几款补视频，
                    分成两列反而要来回对照
                  */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    {g.homeRank ? (
                      <span className="rounded bg-brand-soft px-1.5 py-0.5 text-xs font-semibold text-brand-hover" title={`首页第 ${g.homeRank} 位`}>
                        ⭐ {g.homeRank}
                      </span>
                    ) : (
                      <span className="text-xs text-dim">—</span>
                    )}
                    {g.video ? (
                      <span className="ml-1 text-xs" title={`已配视频：${g.video}`}>
                        🎬
                      </span>
                    ) : g.homeRank ? (
                      <span className="ml-1 text-xs text-dim" title="这一款在首页，但还没配视频">
                        ○
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {(() => {
                      // 编辑弹窗只填「按语言的 ROM」（roms），以前这里只看 g.rom，
                      // 结果配好了语言 ROM 的游戏在列表里一律显示未绑定
                      const keys = romKeysOf(g)
                      return keys.length ? (
                        <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online" title={keys.join('\n')}>
                          ☁️ 已绑定{keys.length > 1 ? ` ×${keys.length}` : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-dim">—</span>
                      )
                    })()}
                  </td>
                  <td className="px-3 py-2">
                    {g.hidden ? (
                      <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-dim">已下架</span>
                    ) : (
                      <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">上架中</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button type="button" className={cx(btnClass.small, 'text-brand-hover hover:bg-brand-soft')} onClick={() => setEditing({ mode: 'edit', game: g })}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}
                        onClick={async () => {
                          try {
                            await setGameHidden(g.slug, !g.hidden)
                            setToast(g.hidden ? '已上架' : '已下架')
                            reload()
                          } catch (err) {
                            setToast(err instanceof Error ? err.message : '操作失败')
                          }
                        }}
                      >
                        {g.hidden ? '上架' : '下架'}
                      </button>
                      <button type="button" className={cx(btnClass.small, 'text-live hover:bg-live/15')} onClick={() => remove(g)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={FEATURES.coins ? 10 : 9} className="px-3 py-10 text-center text-sm text-muted">
                  {loading ? (
                    '正在读取数据库…'
                  ) : error ? (
                    <>
                      连不上数据库，取不到游戏列表。
                      <br />
                      <span className="text-xs">{error}</span>
                      <br />
                      <button type="button" className="mt-2 font-semibold text-brand-hover underline" onClick={retry}>
                        重试
                      </button>
                    </>
                  ) : !apiEnabled() ? (
                    <>
                      未配置后端（VITE_API_URL）。
                      <br />
                      <span className="text-xs">在前端 .env 里配好后端地址并重新构建，后台才能读写游戏库。</span>
                    </>
                  ) : total === 0 && !debouncedQ && platform === 'all' ? (
                    <>
                      数据库里还没有游戏。
                      <br />
                      到「
                      <Link to="/admin/data" className="font-semibold text-brand-hover underline">
                        数据
                      </Link>
                      」页点「导入内置数据到数据库」，把项目自带的目录一次性写进库里。
                    </>
                  ) : items.length > 0 ? (
                    '当前页没有符合该状态的游戏（状态筛选只作用于当前页，可翻页继续找）'
                  ) : (
                    '没有符合条件的游戏'
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页：翻页在服务端做，这里只负责报页码 */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-xs text-muted">
            第 {page} / {totalPages} 页 · 共 {total} 款
          </span>
          <div className="flex gap-2">
            <button type="button" className={btnClass.secondary} disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              ← 上一页
            </button>
            <button
              type="button"
              className={btnClass.secondary}
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页 →
            </button>
          </div>
        </div>
      )}

      {/* 编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editing.mode === 'edit' ? '编辑游戏' : '新增游戏'}
            className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-5"
          >
            <h2 className="mb-4 text-lg font-bold">{editing.mode === 'edit' ? `编辑：${editing.game.titleZh ?? editing.game.title}` : '新增游戏'}</h2>
            <GameForm
              key={editing.mode === 'edit' ? editing.game.slug : 'new'}
              initial={editing.mode === 'edit' ? editing.game : undefined}
              // 表单里这份只够挡住「和当前页某条重名」，真正的判重在 save() 里问后端
              existingSlugs={items.map((g) => g.slug)}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-surface-3 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
