import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

export const SITE_NAME = import.meta.env.VITE_SITE_NAME ?? '8BitGo'

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  const t = useT()
  return (
    <Link to="/" className={cx('group inline-flex items-center gap-2', className)} aria-label={`${SITE_NAME} ${t.common.home}`}>
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white shadow-[0_0_18px_rgba(0,120,242,0.5)] transition group-hover:rotate-6">
        <svg width="18" height="18" viewBox="0 0 64 64" shapeRendering="crispEdges" aria-hidden>
          <rect x="6" y="20" width="52" height="26" rx="6" fill="#fff" />
          <rect x="14" y="30" width="12" height="5" fill="#0078f2" />
          <rect x="17.5" y="26.5" width="5" height="12" fill="#0078f2" />
          <rect x="40" y="27" width="5" height="5" fill="#fbbf24" />
          <rect x="47" y="32" width="5" height="5" fill="#fbbf24" />
        </svg>
      </span>
      {!compact && (
        <span className="text-pixel text-sm leading-none tracking-wide">
          <span className="text-fg">8Bit</span>
          <span className="text-brand-hover">Go</span>
        </span>
      )}
    </Link>
  )
}
