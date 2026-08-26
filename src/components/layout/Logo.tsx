import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

export const SITE_NAME = import.meta.env.VITE_SITE_NAME ?? '8BitGo'

/**
 * 站点 Logo。
 * 素材：public/ui/logo-8bitgo.png（272x70 透明底像素字标）
 *      public/ui/logo-mark.png（128x128 单字「8」方形标，compact 时用）
 * img 上写死 width/height 是为了避免图片加载前后的布局抖动。
 */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  const t = useT()
  return (
    <Link
      to="/"
      className={cx('group inline-flex items-center', className)}
      aria-label={`${SITE_NAME} ${t.common.home}`}
    >
      <img
        src={compact ? '/ui/logo-mark.png' : '/ui/logo-8bitgo.png'}
        alt={SITE_NAME}
        width={compact ? 32 : 155}
        height={compact ? 32 : 40}
        draggable={false}
        className={cx(
          'w-auto select-none transition duration-200 group-hover:-translate-y-0.5',
          compact ? 'h-8' : 'h-9 lg:h-10',
        )}
        style={{ imageRendering: 'pixelated', padding: '5px', paddingLeft: 0 }}
      />
    </Link>
  )
}
