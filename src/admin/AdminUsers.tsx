import { useMemo, useState } from 'react'
import type { PublicUser } from '@/types'
import { adminClearBirthDate, adminDeleteUser, adminSetRole, adminSetStatus, useAllUsers, useCurrentUser } from '@/services/auth'
import { isAdultByBirthDate } from '@/lib/age'
import { cx } from '@/lib/format'
import { apiEnabled } from '@/services/api'
import { btnClass, inputClass } from './ui'
import { useAdminData } from './AdminLayout'
import { ROLES, ROLE_LABELS, type UserRole } from '../../shared/roles.js'

export function AdminUsers() {
  const users = useAllUsers()
  const me = useCurrentUser()
  // 改角色单独一道权限点：能封号的人不一定就该能发权限（见 shared/roles.js）
  const { abilities } = useAdminData()
  const canSetRole = abilities.includes('users:role')
  const [q, setQ] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return users
      .filter((u) => !needle || u.nickname.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [users, q])

  /** 是不是当前登录的这个管理员自己 */
  const isSelf = (u: PublicUser) => Boolean(me && me.id === u.id)

  const flash = (t: string) => {
    setToast(t)
    window.setTimeout(() => setToast(null), 2000)
  }

  /**
   * 改角色。
   *
   * 服务端还压着三道护栏（要有 users:role、不能给自己降级、不能把最后一个可用的
   * 管理员降下去），这里只挡住最显眼的那一条，剩下的靠回来的报错说话 ——
   * 「还剩几个管理员」只有数据库知道，前端这份用户列表算不准。
   */
  const changeRole = async (u: PublicUser, role: UserRole) => {
    if (role === u.role) return
    if (role !== 'user' && !window.confirm(`把「${u.nickname}」设为${ROLE_LABELS[role]}？`)) return
    try {
      await adminSetRole(u.id, role)
      flash(`${u.nickname} → ${ROLE_LABELS[role]}`)
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

  /**
   * 清除出生日期，让用户可以重填。
   *
   * 用户自己填一次就锁死（成人内容的年龄门靠这个才有意义），所以这是唯一的纠错通道。
   * 后台只能清、不能代填：出生日期是本人的声明，管理员替人填一个成年日期等于替人担责。
   */
  const clearBirthDate = async (u: PublicUser) => {
    if (!window.confirm(`清除「${u.nickname}」的出生日期？清除后他需要重新填写才能玩成人内容。`)) return
    try {
      await adminClearBirthDate(u.id)
      flash('已清除出生日期')
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
            共 {users.length} 位用户，{users.filter((u) => u.status === 'banned').length} 位被封禁。{apiEnabled() ? '用户数据来自数据库。' : '未配置后端，只能看到在这台浏览器注册的账号。'}
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
              <th className="px-3 py-2 font-medium">角色</th>
              <th className="px-3 py-2 font-medium">成人内容</th>
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
                <td className="px-3 py-2">
                  {canSetRole ? (
                    <select
                      value={u.role}
                      onChange={(e) => void changeRole(u, e.target.value as UserRole)}
                      // 给自己降级 = 当场把自己关在后台外面，后端也拦了一道
                      disabled={isSelf(u)}
                      title={isSelf(u) ? '不能改自己的角色' : undefined}
                      className={cx(inputClass, 'h-7 w-24 px-1.5 py-0 text-xs disabled:opacity-60')}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-muted">{ROLE_LABELS[u.role]}</span>
                  )}
                </td>
                {/* 成人内容的年龄验证状态。出生日期只显示给管理员，不进任何公开接口 */}
                <td className="px-3 py-2">
                  {u.birthDate ? (
                    <div className="flex items-center gap-1.5">
                      <span className={cx('rounded px-1.5 py-0.5 text-xs', isAdultByBirthDate(u.birthDate) ? 'bg-online/15 text-online' : 'bg-live/15 text-live')}>
                        {isAdultByBirthDate(u.birthDate) ? '已满 18' : '未满 18'}
                      </span>
                      <span className="tabular-nums text-xs text-dim">{u.birthDate}</span>
                      <button
                        type="button"
                        className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}
                        onClick={() => clearBirthDate(u)}
                        title="清除后用户可以重新填写出生日期"
                      >
                        清除
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-dim">未填写</span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted">{u.favorites.length}</td>
                <td className="px-3 py-2 tabular-nums text-muted">{u.recent.length}</td>
                <td className="px-3 py-2">
                  {u.status === 'banned' ? (
                    <span className="rounded bg-live/15 px-1.5 py-0.5 text-xs text-live">已封禁</span>
                  ) : (
                    <span className="rounded bg-online/15 px-1.5 py-0.5 text-xs text-online">正常</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    {/* 封禁 / 删除自己会把自己直接关在后台外面（下一次请求就被鉴权拦下），
                        后端也拦了一道，这里先把按钮禁掉，省得点了才报错 */}
                    <button
                      type="button"
                      className={cx(btnClass.small, 'text-muted hover:bg-black/5 hover:text-fg')}
                      onClick={() => toggleBan(u)}
                      disabled={isSelf(u) && u.status === 'active'}
                      title={isSelf(u) && u.status === 'active' ? '不能封禁自己' : undefined}
                    >
                      {u.status === 'banned' ? '解封' : '封禁'}
                    </button>
                    <button
                      type="button"
                      className={cx(btnClass.small, 'text-live hover:bg-live/15')}
                      onClick={() => remove(u)}
                      disabled={isSelf(u)}
                      title={isSelf(u) ? '不能删除自己' : undefined}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-muted">
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
