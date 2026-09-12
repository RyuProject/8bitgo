import { useEffect, type ReactNode } from 'react'
import { cx } from '@/lib/format'

/**
 * 全站统一的模态框外壳。复刻 ShareDialog 那一套：
 * 半透明遮罩 + 背景模糊、点遮罩关、Esc 关、打开时锁 body 滚动。
 *
 * 之所以抽成组件而不是每处都写一遍那个 `fixed inset-0 z-[80]` 模板，
 * 是因为这个模式在分享 / 合集 / 授权页重复了四五次，改一处样式要同步五处很容易漏。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
  closeLabel = '关闭',
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
  closeLabel?: string
}) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={cx(
          'relative my-auto w-full rounded-2xl border border-line bg-surface p-5 shadow-2xl sm:p-6',
          size === 'sm' && 'max-w-sm',
          size === 'md' && 'max-w-lg',
          size === 'lg' && 'max-w-2xl',
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-fg"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {title && <h2 className="pr-10 text-lg font-extrabold tracking-tight">{title}</h2>}
        <div className={title ? 'mt-4' : ''}>{children}</div>
      </div>
    </div>
  )
}
