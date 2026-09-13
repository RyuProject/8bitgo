import type { ReactNode } from 'react'
import { cx } from '@/lib/format'
import type { UserRole } from '@/types'

/** 头像元素本身该加的 ring 类（让圆环贴着头像形状）。 */
export function userRoleAvatarClass(role?: UserRole | null): string {
  if (role === 'admin') return 'ring-2 ring-yellow-400'
  if (role === 'volunteer') return 'ring-2 ring-cyan-400'
  return ''
}

/**
 * 给管理员 / 志愿者头像加的圆环。
 *
 * 防止有人起名叫 admin 被误认为站长 —— 真正的身份由服务端 role 字段决定，
 * 前端只负责把这条信息画出来。
 */
export function UserRoleRing({
  role,
  className,
  title,
  children,
}: {
  role?: UserRole | null
  className?: string
  title?: string
  children: ReactNode
}) {
  if (!role || role === 'user') return <>{children}</>
  return (
    <span
      className={cx(
        'inline-flex rounded-full',
        role === 'admin' ? 'ring-2 ring-yellow-400' : 'ring-2 ring-cyan-400',
        className,
      )}
      title={title}
      aria-label={title}
    >
      {children}
    </span>
  )
}

/** 名字旁边的小圆点（弹幕、评论名单等没有头像的地方用）。 */
export function UserRoleDot({
  role,
  title,
}: {
  role?: UserRole | null
  title?: string
}) {
  if (!role || role === 'user') return null
  return (
    <span
      className={cx(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        role === 'admin' ? 'bg-yellow-400' : 'bg-cyan-400',
      )}
      title={title}
      aria-label={title}
    />
  )
}
