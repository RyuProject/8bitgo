import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import logo1x from '@/assets/ui/logo-8bitgo-1x.webp'
import logo2x from '@/assets/ui/logo-8bitgo-2x.webp'
import logoFallback from '@/assets/ui/logo-8bitgo.png'
import logoMark from '@/assets/ui/logo-mark.png'

export const SITE_NAME = import.meta.env.VITE_SITE_NAME ?? '8BitGo'

/**
 * 对外联系邮箱。
 *
 * 页脚的版权免责声明里写了「如涉及版权问题请联系我们处理」，那句话必须真的能点 ——
 * 所以这个地址由页脚和关于页共用，别再各自写死一份。
 */
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? 'yeahcore@yeah.net'

/**
 * 站点 Logo。
 * 源文件仍保留在 public/ui 供旧页面使用；当前页面引用 src/assets 的副本，Vite 会生成内容哈希 URL，
 * 因而可以安全使用一年缓存。WebP 不可用时仍回退到透明底 PNG。
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
        src={compact ? logoMark : logo1x}
        srcSet={compact ? undefined : `${logo1x} 1x, ${logo2x} 2x`}
        alt={SITE_NAME}
        width={compact ? 32 : 155}
        height={compact ? 32 : 40}
        draggable={false}
        onError={compact ? undefined : (event) => {
          const image = event.currentTarget
          // 少数旧浏览器不认识 WebP；清掉候选集后回退，避免它反复请求坏格式。
          if (image.src !== new URL(logoFallback, document.baseURI).href) {
            image.removeAttribute('srcset')
            image.src = logoFallback
          }
        }}
        className={cx(
          'w-auto select-none transition duration-200 group-hover:-translate-y-0.5',
          compact ? 'h-8' : 'h-9 lg:h-10',
        )}
        style={{ imageRendering: 'pixelated', padding: '5px', paddingLeft: 0 }}
      />
    </Link>
  )
}
