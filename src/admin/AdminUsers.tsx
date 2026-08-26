import { useMemo, useState } from 'react'
import type { PublicUser } from '@/types'
import { adminAdjustCoins, adminDeleteUser, adminSetStatus, useAllUsers, useCurrentUser } from '@/services/auth'
import { cx } from '@/lib/format'
import { btnClass, inputClass } from './ui'

export function AdminUsers() {
  const users = useAllUsers()
  const me = useCurrentUser()
  const [q, setQ] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return users
      .filter((u) => !needle || u.nickname.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [users, q])

  const flash = (t: string) => {
    setToast(t)
    window.setTimeout(() => setToast(null), 2000)
  }

  const adjust = async (u: PublicUser) => {
    const raw = window.prompt(`给「${u.nickname}」调整 G 币（正数增加，负数扣除）：`, '100')
    if (raw === null) return
    const delta = Math.round(Number(raw))
    if (!Number.isFinite(delta) || delta === 0) return
    try {
      await adminAdjustCoins(u.id, delta)
      flash(`${u.nickname}：${delta > 0 ? '+' : ''}${delta} G 币`)
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败')
    }
  }

  const toggleBan = async (u: PublicUser) => {
    const banning = u.status === 'active'
    if (banning && !window.confirm(`确定封禁「${u.nickname}」？封禁后该用户将无法登录。`)) return
    try {
      await adminSetStatus(u.id, banning ? 'banned' : 'active')
      flash(banning ? '已封禁' : '已解封')
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败')
    }
  }

  const remove = async (u: PublicUser) => {
    if (!window.confirm(`确定删除用户「${u.nickname}」（${u.email}）？此操作不可恢复。`)) return
    try {
      await adminDeleteUser(u.id)
      flash('已删除')
    } catch (err) {
      flash(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">用户管理</h1>
          <p className="mt-1 text-sm text-muted">
            共 {users.length} 位用户，{users.filter((u) => u.status === 'banned').length} 位被封禁。用户数据保存在浏览器本地，只能看到本浏览器注册的账号。
          </p>
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索昵称 / 邮箱…" className={cx(inputClass, 'w-64')} />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">注册日期</th>
              <th className="px-3 py-2 font-medium">G 币</th>
              <th className="px-3 py-2 font-medium">收藏</th>
              <th className="px-3 py-2 font-medium">最近浏览</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((u) => (
              <tr key={u.id} className={cx('transition hover:bg-black/[0.03]', u.status === 'banned' && 'opacity-60')}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-soft text-base" aria-hidden>
                      {u.avatar}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {u.nickname}
                        {me?.id === u.id && <span className="ml-1.5 rounded bg-brand-soft px-1 text-[10px] text-brand-hover">当前登录</span>}
                      </p>
                      <p className="truncate text-xs text-dim">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 tabular-nums text-muted">{u.createdAt}</td>
                <td className="px-3 py-2 tabular-nums text-coin">🪙 {u.coins.toLocaleString('zh-CN')}</td>
                <td className="px-3 py-2 tabular-nums text-muted">{u.favorites.length}</td>
                <td className="px-3 py-2 tabular-nums text-muted">{u.recent.length}</td>
                <td className="px-3 py-2">
                  {u.status === 'banned' ? (
                    <span className="rounded bg-live/15 px-1.5 py-0.5 text-xs text-red-300">已封禁</span>
                  ) : (
                    <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">正常</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <button type="button" className={cx(btnClass.small, 'text-coin hover:bg-coin-soft')} onClick={() => adjust(u)}>
                      G 币
                    </button>
                    <button type="button" className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')} onClick={() => toggleBan(u)}>
                      {u.status === 'banned' ? '解封' : '封禁'}
                    </button>
                    <button type="button" className={cx(btnClass.small, 'text-red-300 hover:bg-live/15')} onClick={() => remove(u)}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted">
                  {users.length === 0 ? '还没有用户。在前台注册一个账号后会出现在这里。' : '没有符合条件的用户'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-surface-3 px-4 py-2 text-sm shadow-xl">{toast}</div>}
    </div>
  )
}
