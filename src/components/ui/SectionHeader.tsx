import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

interface Props {
  title: string
  subtitle?: string
  icon?: ReactNode
  /** 「查看全部」链接 */
  moreTo?: string
  moreLabel?: string
  /** 右侧自定义内容（例如轮播箭头） */
  actions?: ReactNode
  className?: string
  id?: string
  as?: 'h1' | 'h2' | 'h3'
}

export function SectionHeader({
  title,
  subtitle,
  icon,
  moreTo,
  moreLabel,
  actions,
  className,
  id,
  as: Tag = 'h2',
}: Props) {
  const t = useT()
  return (
    <div id={id} className={cx('mb-3 flex items-end justify-between gap-4 scroll-mt-20', className)}>
      <div className="min-w-0">
        <Tag className="flex items-center gap-2 text-lg font-bold tracking-tight sm:text-xl">
          {icon && <span className="text-lg sm:text-xl" aria-hidden>{icon}</span>}
          <span className="truncate">{title}</span>
        </Tag>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        {moreTo && (
          <Link
            to={moreTo}
            className="group inline-flex items-center gap-1 text-sm font-medium text-muted transition hover:text-brand-hover"
          >
            {moreLabel ?? t.common.viewAll}
            <span className="transition group-hover:translate-x-0.5" aria-hidden>
              →
            </span>
          </Link>
        )}
      </div>
    </div>
  )
}
