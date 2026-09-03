/**
 * 详情页上「这款游戏要整页打开」的入口卡片。
 *
 * 用在少数需要跨源隔离（SharedArrayBuffer）的 WebAssembly 大作上：它们没法内嵌在详情页里，
 * 因为隔离头必须发在**顶层文档**上，而详情页一开 require-corp，Google Fonts、
 * 字节的收录脚本和对象存储上的封面图会被一起掐掉。完整理由见 shared/isolated-embeds.js。
 *
 * 所以这里只画一个和播放器同尺寸（16:9）的卡片，点了整页跳到 /play/<slug> ——
 * 人还在站内，只是换了一页。
 *
 * ⚠️ 必须用 <a> 而不是 react-router 的 <Link>：/play/<slug> 是由 Express 直接吐的外壳页
 * （见 server/src/routes/play.js），不是前端路由的一部分。走 <Link> 只会让 SPA 匹配不到
 * 而渲染 404 —— 隔离头也就永远发不出去。
 */
import { buttonClasses } from '@/components/ui/Button'
import { langPrefix } from '@/config/languages'
import { useLang } from '@/services/lang'
import { cx } from '@/lib/format'
import type { ReactNode } from 'react'

interface Props {
  slug: string
  gameName: string
  /** 空闲态的大图标，和 EmulatorPlayer 的 icon 一个意思 */
  icon?: string
  /** 背景（通常是封面），和播放器空闲态保持一致的观感 */
  backdrop?: ReactNode
  className?: string
}

export function IsolatedPlayCard({ slug, gameName, icon, backdrop, className }: Props) {
  const lang = useLang()
  // 语言前缀由 basename 承载，而这是一条整页跳转，得自己拼上，否则英文用户会掉到中文页
  const href = `${langPrefix(lang)}/play/${encodeURIComponent(slug)}`

  return (
    <div className={cx('overflow-hidden rounded-2xl border border-line bg-black', className)}>
      <div className="relative flex aspect-video w-full items-center justify-center">
        <div className="absolute inset-0 opacity-60 blur-sm">{backdrop}</div>
        <div className="scanlines absolute inset-0" aria-hidden />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />

        <div className="relative flex flex-col items-center gap-4 px-6 text-center">
          {icon && (
            <span className="hidden text-6xl drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:block sm:text-7xl" aria-hidden>
              {icon}
            </span>
          )}
          <a href={href} className={buttonClasses('primary', 'lg')}>
            <span aria-hidden>▶</span> {gameName}
          </a>
          <p className="max-w-sm text-xs text-muted">
            这款游戏会在独立的整页里运行（浏览器要求如此），随时可以从那一页返回。
          </p>
        </div>
      </div>
    </div>
  )
}
