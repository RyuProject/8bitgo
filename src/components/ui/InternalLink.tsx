import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { Link, useHref, useNavigate } from 'react-router-dom'
import { cx } from '@/lib/format'
import { isCrawlableInternal } from '@/lib/seoLinks'

/**
 * 站内跳转。目标可抓就渲染成真链接，被 robots.txt 禁抓就**不产生 href**。
 *
 * 为什么不是简单挂个 `rel="nofollow"`：nofollow 只是不传权重，挡不住发现，
 * 那些 `?q=` / `?developer=` 地址照样会被排进抓取队列，然后堆在 Search Console
 * 的「已被 robots.txt 屏蔽」里，把真事故盖住。完整推理见 `lib/seoLinks.ts`。
 *
 * 判据只有一份（`isCrawlableInternal`），并由 `npm run test:robots` 拿真的
 * robots.txt 逐条核对。调用方**不需要**知道哪些地址被禁抓 —— 这正是把判断
 * 收进组件的原因：首页那几个「更多」当年就是靠调用方自己记才漏的。
 *
 * 交互上尽量不比链接差：
 *   - ⌘ / Ctrl / Shift + 左键、以及中键，仍然是「在新标签页打开」
 *   - `as="div"` 那一路补了 Enter 键，和原生链接一致
 */
interface Props {
  /** 站内路径，**不带语言前缀**（前缀由 router 的 basename 补） */
  to: string
  className?: string
  children: ReactNode
  title?: string
  'aria-label'?: string
  /**
   * 禁抓分支渲染成什么。
   *
   * 默认 `button` —— 语义最准。但 `<button>` 的内容模型只允许 phrasing content，
   * 卡片式的目标（开发商列表里那种，内部有 `<h2>` / `<p>` / `<div>`）塞进去就是
   * 无效 HTML，标题在无障碍树里还会被压平成按钮名字。那种给 `div`，
   * 用 `role="link"` + Enter 键补齐语义。
   */
  as?: 'button' | 'div'
}

export function InternalLink({ to, className, children, as = 'button', ...rest }: Props) {
  // 两个 hook 都得在分支之前无条件调用：hook 的调用顺序每次渲染必须一致
  const navigate = useNavigate()
  // 带上 basename（语言前缀）的真实地址。只在「新标签页打开」时用到，不会进 HTML
  const href = useHref(to)

  if (isCrawlableInternal(to)) {
    return (
      <Link to={to} className={className} {...rest}>
        {children}
      </Link>
    )
  }

  const openNewTab = () => window.open(href, '_blank', 'noopener,noreferrer')

  /** 带修饰键 = 用户想开新标签，别把这个习惯改掉 */
  const activate = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) openNewTab()
    else navigate(to)
  }
  const onAuxClick = (e: MouseEvent) => {
    if (e.button === 1) openNewTab()
  }

  if (as === 'div') {
    return (
      <div
        role="link"
        tabIndex={0}
        className={cx('cursor-pointer', className)}
        onClick={activate}
        onAuxClick={onAuxClick}
        // role="link" 的键盘约定是 Enter（空格是按钮的，不该在这里生效）
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') navigate(to)
        }}
        {...rest}
      >
        {children}
      </div>
    )
  }

  return (
    <button
      type="button"
      /*
        Tailwind v4 的 preflight 不再给 button 默认 `cursor: pointer`，要自己加。
        `align-baseline` / `text-start`：button 默认是 inline-block + 居中，
        而这些地方原本都是行内链接，不补的话基线和换行对齐会跟着变。
      */
      className={cx('cursor-pointer align-baseline text-start', className)}
      onClick={activate}
      onAuxClick={onAuxClick}
      {...rest}
    >
      {children}
    </button>
  )
}
