import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game, PlatformId } from '@/types'
import { platformMap, platforms } from '@/data/platforms'
import { genreMap } from '@/data/genres'
import { cx, formatCount } from '@/lib/format'
import { apiEnabled } from '@/services/api'
import { useAdminData } from './AdminLayout'
import { deleteGame, setGameHidden, upsertGame, useAllGames } from '@/services/store'
import { GameForm } from './GameForm'
import { btnClass, inputClass } from './ui'

type Status = 'all' | 'visible' | 'hidden'
type Editing = { mode: 'add' } | { mode: 'edit'; game: Game } | null

export function AdminGames() {
  const all = useAllGames()
  const db = useAdminData()
  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [status, setStatus] = useState<Status>('all')
  const [editing, setEditing] = useState<Editing>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(t)
  }, [toast])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((g) => {
      if (platform !== 'all' && g.platform !== platform) return false
      if (status === 'visible' && g.hidden) return false
      if (status === 'hidden' && !g.hidden) return false
      if (!needle) return true
      return [g.title, g.titleZh ?? '', g.slug, g.developer].some((s) => s.toLowerCase().includes(needle))
    })
  }, [all, q, platform, status])

  const save = async (game: Game) => {
    try {
      await upsertGame(game)
      setEditing(null)
      setToast(editing?.mode === 'edit' ? `已保存「${game.titleZh ?? game.title}」` : `已新增「${game.titleZh ?? game.title}」`)
    } catch (err) {
      setToast(err instanceof Error ? err.message : '保存失败')
    }
  }

  const remove = async (g: Game) => {
    if (!window.confirm(`确定删除「${g.titleZh ?? g.title}」？此操作会从游戏库移除（可在「数据」页重置恢复内置数据）。`)) return
    try {
      await deleteGame(g.slug)
      setToast('已删除')
    } catch (err) {
      setToast(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">游戏管理</h1>
          <p className="mt-1 text-sm text-muted">
            共 {all.length} 款，{all.filter((g) => g.hidden).length} 款已下架。
            {!apiEnabled()
              ? '未配置后端，修改只保存在这台浏览器里。'
              : db.state === 'error'
                ? '⚠️ 连不上数据库，下面是空的，现在也改不了。'
                : '修改直接写入数据库，前台立即生效。'}
          </p>
        </div>
        <button type="button" className={btnClass.primary} onClick={() => setEditing({ mode: 'add' })}>
          ＋ 新增游戏
        </button>
      </div>

      {/* 筛选 */}
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / slug / 开发商…"
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
        <span className="self-center text-xs text-muted">{list.length} 条结果</span>
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
              <th className="px-3 py-2 font-medium">评分</th>
              <th className="px-3 py-2 font-medium">游玩</th>
              <th className="px-3 py-2 font-medium">G 币</th>
              <th className="px-3 py-2 font-medium">ROM</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((g) => {
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
                  <td className="px-3 py-2 tabular-nums">{g.rating.toFixed(1)}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{formatCount(g.plays)}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{g.coinReward || '—'}</td>
                  <td className="px-3 py-2">
                    {g.rom ? (
                      <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online" title={g.rom}>
                        ☁️ 已绑定
                      </span>
                    ) : (
                      <span className="text-xs text-dim">—</span>
                    )}
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
            {list.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-sm text-muted">
                  {all.length === 0 && db.state === 'error' ? (
                    <>
                      连不上数据库，取不到游戏列表。
                      <br />
                      <span className="text-xs">{db.error}</span>
                      <br />
                      <button type="button" className="mt-2 font-semibold text-brand-hover underline" onClick={db.reload}>
                        重试
                      </button>
                    </>
                  ) : all.length === 0 && db.state === 'loading' ? (
                    '正在读取数据库…'
                  ) : all.length === 0 && apiEnabled() ? (
                    <>
                      数据库里还没有游戏。
                      <br />
                      到「
                      <Link to="/admin/data" className="font-semibold text-brand-hover underline">
                        数据
                      </Link>
                      」页点「导入内置数据到数据库」，把项目自带的目录一次性写进库里。
                    </>
                  ) : (
                    '没有符合条件的游戏'
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editing.mode === 'edit' ? '编辑游戏' : '新增游戏'}
            className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-bold">{editing.mode === 'edit' ? `编辑：${editing.game.titleZh ?? editing.game.title}` : '新增游戏'}</h2>
            <GameForm
              key={editing.mode === 'edit' ? editing.game.slug : 'new'}
              initial={editing.mode === 'edit' ? editing.game : undefined}
              existingSlugs={all.map((g) => g.slug)}
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
