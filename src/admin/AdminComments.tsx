import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { GameComment } from '@/types'
import {
  countryFlag,
  countryName,
  fetchAdminComments,
  purgeComment,
  setCommentHidden,
  type CommentStatusFilter,
} from '@/services/comments'
import { apiEnabled } from '@/services/api'
import { cx } from '@/lib/format'
import { btnClass, inputClass } from './ui'

const PAGE_SIZE = 30

const TABS: Array<{ id: CommentStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'visible', label: '正常' },
  { id: 'hidden', label: '已隐藏' },
  { id: 'deleted', label: '已删除' },
]

/**
 * 后台评论管理。
 *
 * 「隐藏」和「已删除」是两件不同的事，所以筛选器把它们分开：
 *   隐藏  = 管理员判断内容不合适，前台不再显示，点「恢复」就回来
 *   删除  = 作者自己删的（软删除），后台仍看得到原文 —— 处理举报纠纷时要能查
 * 「彻底删除」才是从数据库里抹掉，不可恢复，所以要二次确认。
 *
 * 列表带原文和邮箱（前台那条接口一律不给邮箱），并且能一键跳到前台原帖。
 */
export function AdminComments() {
  const [items, setItems] = useState<GameComment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<CommentStatusFilter>('all')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2000)
  }

  const load = useCallback(async () => {
    if (!apiEnabled()) {
      setState('ready')
      return
    }
    setState('loading')
    try {
      const r = await fetchAdminComments({ status, q: search, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setState('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
      setState('error')
    }
  }, [status, search, page])

  useEffect(() => {
    void load()
  }, [load])

  // 换筛选条件时回到第一页：停在第 5 页会看到一个空列表，很容易误判成「没有数据」
  useEffect(() => {
    setPage(1)
  }, [status, search])

  const toggleHidden = async (item: GameComment) => {
    setBusyId(item.id)
    try {
      await setCommentHidden(item.id, !item.hidden)
      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, hidden: !item.hidden } : x)))
      flash(item.hidden ? '已恢复显示' : '已隐藏')
    } catch (e) {
      flash(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (item: GameComment) => {
    if (!window.confirm(`彻底删除这条评论？此操作不可恢复。\n\n${item.author.nickname}：${item.content.slice(0, 80)}`)) return
    setBusyId(item.id)
    try {
      await purgeComment(item.id)
      setItems((prev) => prev.filter((x) => x.id !== item.id))
      setTotal((n) => Math.max(0, n - 1))
      flash('已彻底删除')
    } catch (e) {
      flash(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">评论管理</h1>
          <p className="mt-1 text-sm text-muted">
            共 {total} 条。
            {apiEnabled()
              ? '「隐藏」前台立即不再显示、随时可恢复；「已删除」是用户自己删的，原文仍保留在这里。'
              : '未配置 VITE_API_URL，评论数据全部来自后端，这里读不到任何内容。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatus(tab.id)}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs transition',
                  status === tab.id ? 'bg-brand-soft font-semibold text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setSearch(q)
            }}
          >
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜正文 / 昵称 / 邮箱 / 游戏名…"
              className={cx(inputClass, 'w-64')}
            />
          </form>
        </div>
      </div>

      {state === 'error' && (
        <div className="rounded-2xl border border-live/40 bg-live/5 px-4 py-3 text-sm text-live" role="alert">
          {error}
          <button type="button" onClick={() => void load()} className="ml-3 underline">
            重试
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">地区</th>
              <th className="px-3 py-2 font-medium">游戏</th>
              <th className="px-3 py-2 font-medium">内容</th>
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((item) => (
              <tr key={item.id} className={cx('align-top transition hover:bg-black/[0.03]', (item.hidden || item.deleted) && 'opacity-60')}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-soft text-base" aria-hidden>
                      {item.author.avatar}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.author.nickname}</p>
                      <p className="truncate text-xs text-dim">{item.author.email}</p>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">
                  <span aria-hidden>{countryFlag(item.country)}</span> {countryName(item.country)}
                </td>
                <td className="px-3 py-2">
                  {item.gameSlug ? (
                    <Link to={`/games/${item.gameSlug}`} target="_blank" className="text-brand-hover hover:underline">
                      {item.gameTitle || item.gameSlug}
                    </Link>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </td>
                <td className="max-w-[26rem] px-3 py-2">
                  {item.quote && (
                    <p className="mb-1 truncate rounded border-l-2 border-brand/40 bg-surface-2 px-2 py-1 text-[11px] text-dim">
                      回复 {item.quote.nickname}：{item.quote.deleted ? '（原评论已删除）' : item.quote.content}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{item.content}</p>
                  {item.editedAt && <span className="text-[11px] text-dim">（已编辑）</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-xs text-muted">
                  {item.createdAt.replace('T', ' ').slice(0, 16)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {item.deleted ? (
                    <span className="rounded bg-black/10 px-1.5 py-0.5 text-xs text-muted">用户已删</span>
                  ) : item.hidden ? (
                    <span className="rounded bg-live/15 px-1.5 py-0.5 text-xs text-live">已隐藏</span>
                  ) : (
                    <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">正常</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    {/* 用户自己删掉的评论不提供「隐藏 / 恢复」：它已经不在前台了，
                        再给一个「恢复」按钮会让人以为能把它放回去 */}
                    {!item.deleted && (
                      <button
                        type="button"
                        className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}
                        onClick={() => void toggleHidden(item)}
                        disabled={busyId === item.id}
                      >
                        {item.hidden ? '恢复' : '隐藏'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={cx(btnClass.small, 'text-live hover:bg-live/15')}
                      onClick={() => void purge(item)}
                      disabled={busyId === item.id}
                      title="从数据库彻底删除，不可恢复"
                    >
                      彻底删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {state !== 'loading' && items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted">
                  {search || status !== 'all' ? '没有符合条件的评论' : '还没有评论。玩家在游戏详情页发表后会出现在这里。'}
                </td>
              </tr>
            )}
            {state === 'loading' && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted">
                  正在读取…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <button
            type="button"
            className={btnClass.secondary}
            disabled={page <= 1}
            onClick={() => setPage((n) => Math.max(1, n - 1))}
          >
            上一页
          </button>
          <span className="text-muted">
            {page} / {pages}
          </span>
          <button
            type="button"
            className={btnClass.secondary}
            disabled={page >= pages}
            onClick={() => setPage((n) => Math.min(pages, n + 1))}
          >
            下一页
          </button>
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
