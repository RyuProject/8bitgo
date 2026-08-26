import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '@/lib/format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'coin' | 'danger'
type Size = 'sm' | 'md' | 'lg'

/* Duolingo 风：圆角、加粗、底部实心「3D」阴影，按下时整体下沉、阴影收起 */
const base =
  'inline-flex items-center justify-center gap-2 rounded-2xl font-bold whitespace-nowrap transition-[transform,box-shadow,background-color] duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50 disabled:pointer-events-none select-none'

const press = 'active:translate-y-[3px] active:shadow-none'

const variants: Record<Variant, string> = {
  primary: `bg-brand text-white shadow-[0_4px_0_0_var(--color-brand-shadow)] hover:brightness-105 ${press}`,
  secondary: `bg-surface text-fg border-2 border-line-strong shadow-[0_4px_0_0_var(--color-line-strong)] hover:bg-surface-2 ${press}`,
  ghost: 'text-muted hover:text-fg hover:bg-black/5',
  coin: `bg-coin text-[#7a4f00] shadow-[0_4px_0_0_#d9a600] hover:brightness-105 ${press}`,
  danger: `bg-live text-white shadow-[0_4px_0_0_#d63c3c] hover:brightness-105 ${press}`,
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

interface CommonProps {
  variant?: Variant
  size?: Size
  className?: string
  children: ReactNode
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & { to?: undefined }
type LinkProps = CommonProps & { to: string; target?: string; rel?: string; onClick?: () => void }

export function buttonClasses(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return cx(base, variants[variant], sizes[size], className)
}

/**
 * 筛选 chip：与按钮同一套 Duolingo 立体风格（底部实心投影、按下下沉）。
 * 选中 = primary（绿），未选中 = secondary（白 + 描边）。
 * 两种状态都带 border-2，切换时不会有 2px 抖动。
 */
export function chipClasses(active = false, className?: string) {
  return cx(
    'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-2xl border-2 px-3 text-xs font-bold select-none',
    'transition-[transform,box-shadow,background-color] duration-100',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    press,
    active
      ? 'border-brand bg-brand text-white shadow-[0_4px_0_0_var(--color-brand-shadow)] hover:brightness-105'
      : 'border-line-strong bg-surface text-fg shadow-[0_4px_0_0_var(--color-line-strong)] hover:bg-surface-2',
    className,
  )
}

export function Button(props: ButtonProps | LinkProps) {
  if (typeof props.to === 'string') {
    const { variant, size, className, children, to, target, rel, onClick } = props
    return (
      <Link to={to} target={target} rel={rel} onClick={onClick} className={buttonClasses(variant, size, className)}>
        {children}
      </Link>
    )
  }

  const { variant, size, className, children, ...rest } = props as ButtonProps
  return (
    <button type="button" className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  )
}
