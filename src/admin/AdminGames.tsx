import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game, PlatformId } from '@/types'
import type { Paged } from '@/services/pageData'
import { platformMap, platforms } from '@/data/platforms'
import { FEATURES } from '@/config/features'
import { genreMap } from '@/data/genres'
import { cx, formatCount } from '@/lib/format'
import { apiEnabled } from '@/services/api'
import { useAdminData } from './AdminLayout'
import { deleteGame, fetchAdminGames, setGameHidden, upsertGame } from '@/services/store'
import { romKeysOf } from '@/services/roms'
import { trackPageLoad } from '@/services/progress'
import { GameForm } from './GameForm'
import { btnClass, inputClass } from './ui'

type Status = 'all' | 'visible' | 'hidden'
type HomeFilter = 'all' | 'picked' | 'unpicked'
/**
 * 排序。这几档服务端早就实现了（games-repo.js 的 orderBy），后台以前只是没给入口。
 * 'home' 不放进下拉里让人主动选 —— 它是「只看首页位」那一档的附带效果，见下面 effectiveSort。
 */
type Sort = 'newest' | 'popular' | 'name' | 'rating'
type Editing = { mode: 'add' } | { mode: 'edit'; game: Game } | null

/** 后台一页多少条。和前台列表页保持一致，够看又不至于一次拉太多关联数据。 */
const PAGE_SIZE = 24
/** 搜索防抖：边打字边发请求会把后端打成一串没人要的查询 */
const SEARCH_DEBOUNCE = 300

export function AdminGames() {
  const db = useAdminData()
  const personalLibrary = db.role === 'volunteer'
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [status, setStatus] = useState<Status>('all')
  const [home, setHome] = useState<HomeFilter>('all')
  /**
   * 后台默认按**最新上架**，不跟前台的「最热」。
   *
   * 前台默认按 plays 是对的（访客要看别人都在玩什么），但后台不是逛的地方 ——
   * 打开它通常是为了处理刚加的那几款。而且 orderBy 里那句注释已经说了
   * 「新站大量游戏 plays 都是 0」，按它排在后台等于没排序，还得自己翻页去找。
   */
  const [sort, setSort] = useState<Sort>('newest')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Editing>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 同一时刻只做一个行操作，避免双击产生两次相反的上下架或重复删除。 */
  const [rowAction, setRowAction] = useState<{ slug: string; kind: 'visibility' | 'delete' } | null>(null)
  // React 状态要到下一轮渲染才生效；ref 封住同一事件循环里的快速双击。
  const savingRef = useRef(false)
  const rowActionRef = useRef(false)

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
  /**
   * 实际生效的排序。有两种情况会盖掉下拉里选的那个，都会把下拉**禁用**并显示成
   * 实际生效的那一档 —— 悄悄覆盖会让人以为排序坏了。
   *
   * 1. **只看首页位** → 按首页序号。那一档存在的意义就是核对先后，按别的排等于把它废掉。
   *    （这条是原来就有的行为，没动。）
   * 2. **有搜索关键词** → 按匹配度。这条是必须的：`listGames` 里
   *    `explicitSort = q.sort && q.sort !== 'popular'`，只要带了显式排序，
   *    相关性排序就被丢掉。而后台的默认排序刚从「不传」改成了 newest ——
   *    不特殊处理的话，一搜 "mario" 出来的是最新入库的那几款而不是最匹配的，
   *    等于把搜索框弄坏了。
   */
  const searching = Boolean(debouncedQ)
  const effectiveSort: Sort | 'home' | 'relevance' =
    home === 'picked' ? 'home' : searching ? 'relevance' : sort

  useEffect(() => {
    setPage(1)
  }, [debouncedQ, platform, status, home, sort])

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
        // 'relevance' 不是服务端的档位，它就是「什么都不传」—— 服务端带关键词时默认按匹配度
        sort: effectiveSort === 'relevance' ? undefined : effectiveSort,
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
  }, [debouncedQ, platform, status, home, sort, page, tick])

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
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      // 新增走 INSERT-only，唯一索引在服务端原子判重；不能再用有竞态的“先查再覆盖”。
      await upsertGame(game, { createOnly: editing?.mode === 'add' })
      // 只有保存成功才关闭；请求失败时 catch 会保留表单，避免已经填写的内容丢失。
      setEditing(null)
      setToast(editing?.mode === 'edit' ? `已保存「${game.titleZh ?? game.title}」` : `已新增「${game.titleZh ?? game.title}」`)
      reload()
    } catch (err) {
      setToast(err instanceof Error ? err.message : '保存失败')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  /**
   * 这里只删数据库记录，绝不顺手删 R2。
   *
   * 对象 key 不是游戏的所有权证明：同一份 ROM 可能被另一款游戏、另一语言槽或回退地址共用。
   * 浏览器先删数据库再删对象时已经失去查询引用关系的机会，而且查询后到删除前仍有竞态。
   * 保留对象最多产生可审计的孤儿；误删共享对象会让别的游戏立刻 404，代价完全不对称。
   */
  const remove = async (g: Game) => {
    const scope = personalLibrary
      ? '只会从你的独立游戏库移除，不影响主游戏库、其他志愿者或 ROM 文件。'
      : '此操作会从主数据库中移除该游戏；R2 文件会保留，避免误删被其他游戏共用的资源。'
    if (!window.confirm(`确定删除「${g.titleZh ?? g.title}」？${scope}`)) return
    if (rowActionRef.current) return
    rowActionRef.current = true
    setRowAction({ slug: g.slug, kind: 'delete' })

    try {
      await deleteGame(g.slug)
      setToast(personalLibrary ? '已从你的游戏库移除' : '已删除游戏；R2 文件已安全保留，可在 ROM 存储中另行核对清理')
      reload()
    } catch (err) {
      setToast(err instanceof Error ? err.message : '删除失败')
    } finally {
      rowActionRef.current = false
      setRowAction(null)
    }
  }

  const toggleHidden = async (g: Game) => {
    if (rowActionRef.current) return
    rowActionRef.current = true
    setRowAction({ slug: g.slug, kind: 'visibility' })
    try {
      await setGameHidden(g.slug, !g.hidden)
      setToast(personalLibrary ? (g.hidden ? '已在你的库中显示' : '已在你的库中隐藏') : (g.hidden ? '已上架' : '已下架'))
      reload()
    } catch (err) {
      setToast(err instanceof Error ? err.message : '操作失败')
    } finally {
      rowActionRef.current = false
      setRowAction(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{personalLibrary ? '我的游戏库' : '游戏管理'}</h1>
          <p className="mt-1 text-sm text-muted">
            {!apiEnabled()
              ? '未配置后端（VITE_API_URL），后台读不到游戏，也保存不了修改。'
              : error
                ? `⚠️ 取不到游戏列表：${error}`
                : personalLibrary
                  ? `共 ${total} 款。这里是你的独立资料库，编辑和删除不会影响主游戏库或其他志愿者，内容也不会自动出现在前台。`
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
          <option value="visible">{personalLibrary ? '库内显示' : '上架中'}</option>
          <option value="hidden">{personalLibrary ? '库内隐藏' : '已下架'}</option>
        </select>
        {/* 挑好首页位之后，对着这一档逐个传视频最省事 */}
        {!personalLibrary && (
          <select className={cx(inputClass, 'w-36')} value={home} onChange={(e) => setHome(e.target.value as HomeFilter)}>
            <option value="all">首页位：全部</option>
            <option value="picked">只看首页位</option>
            <option value="unpicked">未上首页</option>
          </select>
        )}
        <select
          className={cx(inputClass, 'w-40')}
          value={effectiveSort}
          disabled={effectiveSort !== sort}
          /* 禁用的 select 不触发 hover，说明只能挂在 title 上 */
          title={
            home === 'picked'
              ? '「只看首页位」时固定按首页序号排'
              : searching
                ? '有搜索关键词时按匹配度排；清空搜索框即可改回来'
                : undefined
          }
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="newest">排序：最新上架</option>
          <option value="popular">排序：最多游玩</option>
          <option value="rating">排序：评分</option>
          <option value="name">排序：名称</option>
          {/* 下面两个只在被盖掉时出现，好让上面的 value 对得上，不是给人选的 */}
          {home === 'picked' && <option value="home">排序：首页序号</option>}
          {searching && home !== 'picked' && <option value="relevance">排序：匹配度</option>}
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
              {!personalLibrary && <th className="px-3 py-2 font-medium">首页</th>}
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
                          {g.title} ·{' '}
                          {personalLibrary ? (
                            <span>/{g.slug}</span>
                          ) : (
                            <Link to={`/games/${g.slug}`} target="_blank" className="hover:text-brand-hover">/{g.slug}</Link>
                          )}
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
                  {!personalLibrary && <td className="px-3 py-2 whitespace-nowrap">
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
                  </td>}
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
                      <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-dim">{personalLibrary ? '库内隐藏' : '已下架'}</span>
                    ) : (
                      <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">{personalLibrary ? '库内显示' : '上架中'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button type="button" disabled={Boolean(rowAction)} className={cx(btnClass.small, 'text-brand-hover hover:bg-brand-soft')} onClick={() => setEditing({ mode: 'edit', game: g })}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}
                        disabled={Boolean(rowAction)}
                        onClick={() => void toggleHidden(g)}
                      >
                        {rowAction?.slug === g.slug && rowAction.kind === 'visibility'
                          ? '处理中…'
                          : personalLibrary ? (g.hidden ? '显示' : '隐藏') : (g.hidden ? '上架' : '下架')}
                      </button>
                      <button type="button" disabled={Boolean(rowAction)} className={cx(btnClass.small, 'text-live hover:bg-live/15')} onClick={() => void remove(g)}>
                        {rowAction?.slug === g.slug && rowAction.kind === 'delete' ? '删除中…' : '删除'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={(FEATURES.coins ? 10 : 9) - (personalLibrary ? 1 : 0)} className="px-3 py-10 text-center text-sm text-muted">
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
                  ) : personalLibrary && total === 0 && !debouncedQ && platform === 'all' ? (
                    '你的独立游戏库还没有游戏，点右上角「新增游戏」开始整理。'
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
              personalLibrary={personalLibrary}
              submitting={saving}
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
